import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentSession, AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../config/schema.js";
import { createReviewSession, type PiModel } from "../runtime/pi.js";
import type { ReviewTarget } from "../target/resolve.js";
import { createSubmitReviewTool, type Report, type SubmissionState } from "./submit-tool.js";
import type { ProblemReason, Usage } from "./types.js";

export type ProgressEvent =
	| { type: "tool"; name: string; detail: string }
	| { type: "tool_error"; name: string; message: string }
	| { type: "retry"; attempt: number; maxAttempts: number; message: string }
	| { type: "compaction" }
	| { type: "repair"; message: string };

export interface SessionRunOptions {
	target: ReviewTarget;
	runtime: ModelRuntime;
	model: PiModel;
	thinking: ThinkingLevel;
	agentDir: string;
	systemPrompt: string;
	taskPrompt: string;
	exclude: readonly string[];
	/** Whole-review deadline in seconds; 0 disables it. */
	timeoutSeconds: number;
	signal: AbortSignal;
	onProgress?: (event: ProgressEvent) => void;
}

export interface SessionOutcome {
	report?: Report;
	/** Set when the run did not produce a trustworthy complete report. */
	problem?: { reason: ProblemReason; message: string };
	cancelled: boolean;
	filesRead: string[];
	usage?: Usage;
	/** Thinking level after Pi clamped the requested level to the model's capabilities. */
	thinking?: ThinkingLevel;
}

const MISSING_REPORT_PROMPT =
	"You stopped without calling submit_review. Call submit_review now with your verified findings (an empty list if there are none) and any limitations. Do not continue investigating.";

/**
 * Run one isolated review session to settlement and classify the outcome. A submitted
 * report only counts if the run also ends cleanly: a later provider error, timeout, or
 * cancellation discards the completion (findings are kept as partial results).
 */
export async function runReviewSession(options: SessionRunOptions): Promise<SessionOutcome> {
	const state: SubmissionState = { rejections: 0 };
	const tool = createSubmitReviewTool(
		{
			kind: options.target.kind,
			workspace: options.target.workspace,
			exclude: options.exclude,
			files: options.target.files,
			readBaseFile: (path) => options.target.readBaseFile(path),
		},
		state,
	);

	if (options.signal.aborted) return { cancelled: true, filesRead: [] };
	const session = await createReviewSession({
		workspace: options.target.workspace,
		agentDir: options.agentDir,
		runtime: options.runtime,
		model: options.model,
		thinking: options.thinking,
		systemPrompt: options.systemPrompt,
		customTools: [tool],
	});

	const reads = new ReadTracker(options.target.workspace);
	const unsubscribe = session.subscribe((event) => {
		reads.observe(event);
		const progress = toProgress(event);
		if (progress) options.onProgress?.(progress);
	});

	let timedOut = false;
	let thrown: Error | undefined;
	const abort = () => void session.abort();
	const timer =
		options.timeoutSeconds > 0
			? setTimeout(() => {
					timedOut = true;
					abort();
				}, options.timeoutSeconds * 1000)
			: undefined;
	options.signal.addEventListener("abort", abort);

	const stopped = () => timedOut || options.signal.aborted;
	try {
		await session.prompt(options.taskPrompt);
		await session.waitForIdle();
		if (!state.report && !stopped() && !lastRunFailed(session)) {
			options.onProgress?.({ type: "repair", message: "reviewer ended without submitting a report; asking for it" });
			await session.prompt(MISSING_REPORT_PROMPT);
			await session.waitForIdle();
		}
	} catch (error) {
		thrown = error instanceof Error ? error : new Error(String(error));
	} finally {
		clearTimeout(timer);
		options.signal.removeEventListener("abort", abort);
		unsubscribe();
	}

	const usage = sumUsage(session);
	const failure = lastRunFailed(session);
	const thinking = session.thinkingLevel as ThinkingLevel;
	session.dispose();

	const base = { report: state.report, filesRead: reads.paths(), thinking, ...(usage ? { usage } : {}) };
	if (options.signal.aborted) return { ...base, cancelled: true };
	const problem = (reason: ProblemReason, message: string): SessionOutcome => ({ ...base, cancelled: false, problem: { reason, message } });
	if (timedOut) return problem("timeout", `The review did not finish within ${options.timeoutSeconds} seconds.`);
	if (thrown) return problem("provider_error", thrown.message);
	if (failure) return problem("provider_error", failure);
	if (!state.report) return problem("missing_report", "The reviewer finished without submitting a structured report.");
	if (state.unresolved) {
		return problem(
			"invalid_report",
			`The reviewer's report still had ${state.unresolved.length} invalid finding(s) after ${state.rejections - 1} repair attempt(s); they were dropped.`,
		);
	}
	return { ...base, cancelled: false };
}

/** Error text if the final assistant turn ended in a provider error or an unrequested abort. */
function lastRunFailed(session: AgentSession): string | undefined {
	const last = [...session.messages].reverse().find((message) => message.role === "assistant");
	if (!last || last.role !== "assistant") return undefined;
	if (last.stopReason === "error") return last.errorMessage ?? "The model provider returned an error.";
	if (last.stopReason === "aborted") return last.errorMessage ?? "The model request was aborted.";
	return undefined;
}

function sumUsage(session: AgentSession): Usage | undefined {
	const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
	let cost = 0;
	let seen = false;
	for (const message of session.messages) {
		if (message.role !== "assistant" || !message.usage) continue;
		seen = true;
		usage.input_tokens += message.usage.input;
		usage.output_tokens += message.usage.output;
		usage.cache_read_tokens += message.usage.cacheRead;
		usage.cache_write_tokens += message.usage.cacheWrite;
		cost += message.usage.cost?.total ?? 0;
	}
	if (!seen) return undefined;
	if (cost > 0) usage.cost_usd = Math.round(cost * 1e6) / 1e6;
	return usage;
}

function toProgress(event: AgentSessionEvent): ProgressEvent | undefined {
	switch (event.type) {
		case "tool_execution_start":
			return { type: "tool", name: event.toolName, detail: describeToolArgs(event.toolName, event.args) };
		case "tool_execution_end":
			if (!event.isError || event.toolName === "submit_review") return undefined;
			return { type: "tool_error", name: event.toolName, message: firstText(event.result) };
		case "auto_retry_start":
			return { type: "retry", attempt: event.attempt, maxAttempts: event.maxAttempts, message: event.errorMessage };
		case "compaction_start":
			return { type: "compaction" };
		default:
			return undefined;
	}
}

function describeToolArgs(name: string, args: Record<string, unknown> | undefined): string {
	const a = args ?? {};
	const str = (value: unknown) => (typeof value === "string" ? value : "");
	switch (name) {
		case "read":
			return str(a.path);
		case "grep":
			return `${JSON.stringify(str(a.pattern))}${a.path ? ` in ${str(a.path)}` : ""}`;
		case "find":
			return `${str(a.pattern)}${a.path ? ` in ${str(a.path)}` : ""}`;
		case "ls":
			return str(a.path) || ".";
		case "submit_review":
			return `${Array.isArray(a.findings) ? a.findings.length : 0} finding(s)`;
		default:
			return "";
	}
}

function firstText(result: unknown): string {
	const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content;
	const text = content?.find((part) => part.type === "text")?.text ?? "";
	return text.split("\n")[0] ?? "";
}

/** Record which workspace files the reviewer successfully opened: objective coverage evidence. */
class ReadTracker {
	private readonly pending = new Map<string, string>();
	private readonly read = new Set<string>();

	constructor(private readonly workspace: string) {}

	observe(event: AgentSessionEvent): void {
		if (event.type === "tool_execution_start" && event.toolName === "read" && typeof event.args?.path === "string") {
			this.pending.set(event.toolCallId, event.args.path);
		} else if (event.type === "tool_execution_end" && this.pending.has(event.toolCallId)) {
			const path = this.pending.get(event.toolCallId)!;
			this.pending.delete(event.toolCallId);
			if (!event.isError) {
				const rel = relative(this.workspace, isAbsolute(path) ? path : resolve(this.workspace, path));
				if (rel && !rel.startsWith("..") && !isAbsolute(rel)) this.read.add(rel.split(sep).join("/"));
			}
		}
	}

	paths(): string[] {
		return [...this.read].sort();
	}
}
