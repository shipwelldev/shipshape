import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import type { CliContext, Prompter } from "../src/cli/app.js";
import { runCli } from "../src/cli/app.js";
import { createModelRuntime, type ModelRuntimeFactory } from "../src/runtime/pi.js";
import type { ReviewResult } from "../src/review/types.js";

export function tempDir(prefix = "shipshape-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function git(dir: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

export function writeFiles(dir: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
}

/** A repository with one commit containing `files`. */
export function makeRepo(files: Record<string, string> = { "README.md": "# fixture\n" }): string {
	const dir = tempDir("shipshape-repo-");
	git(dir, "init", "-q", "-b", "main");
	writeFiles(dir, files);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "initial");
	return dir;
}

export function commitAll(dir: string, message = "change"): string {
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", message);
	return git(dir, "rev-parse", "HEAD").trim();
}

export const FAUX_MODEL = "faux/reviewer";

/** Tool-call turn; the faux provider needs the stop reason stated explicitly. */
export function callTool(name: string, args: Record<string, unknown>) {
	return fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
}

export function submit(findings: unknown[] = [], extra: Record<string, unknown> = {}) {
	return callTool("submit_review", { summary: "Reviewed the change.", findings, ...extra });
}

export function say(text: string) {
	return fauxAssistantMessage([fauxText(text)]);
}

export function highBug(path: string, line: number, overrides: Record<string, unknown> = {}) {
	return {
		severity: "high",
		category: "bug",
		title: "Division by zero",
		description: "divide() does not guard against a zero divisor.",
		path,
		line_start: line,
		trigger: "divide(1, 0)",
		impact: "Returns Infinity to callers expecting a finite number.",
		evidence: `${path}:${line} divides without checking b.`,
		...overrides,
	};
}

/** Model runtime factory that registers a scripted faux provider next to the real ones. */
export function fauxRuntime(steps: FauxResponseStep[], options: RegisterFauxProviderOptions = {}) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "reviewer" }], ...options });
	faux.setResponses(steps);
	const factory: ModelRuntimeFactory = async (runtimeOptions) => {
		const runtime = await createModelRuntime(runtimeOptions);
		runtime.registerNativeProvider(faux.provider);
		return runtime;
	};
	return { faux, factory };
}

export interface CliRun {
	code: number;
	stdout: string;
	stderr: string;
	/** Parsed stdout when the command printed JSON. */
	json: ReviewResult;
}

export async function cli(
	argv: string[],
	options: {
		cwd: string;
		factory?: ModelRuntimeFactory;
		env?: Record<string, string | undefined>;
		signal?: AbortSignal;
		interactive?: boolean;
		answers?: string[];
		/** Extra context fields, e.g. the self-update identity. */
		context?: Partial<CliContext>;
	},
): Promise<CliRun> {
	let stdout = "";
	let stderr = "";
	const answers = [...(options.answers ?? [])];
	const prompter: Prompter = {
		ask: async () => {
			const answer = answers.shift();
			if (answer === undefined) throw new Error("unexpected prompt");
			return answer;
		},
		close: () => {},
	};
	const ctx: CliContext = {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdout: { write: (text) => void (stdout += text) },
		stderr: { write: (text) => void (stderr += text) },
		interactive: options.interactive ?? false,
		createPrompter: () => prompter,
		signal: options.signal ?? new AbortController().signal,
		cancelSignal: () => (options.signal?.aborted ? "SIGINT" : undefined),
		createModelRuntime: options.factory,
		...options.context,
	};
	const code = await runCli(argv, ctx);
	let json: ReviewResult = undefined as unknown as ReviewResult;
	try {
		json = JSON.parse(stdout) as ReviewResult;
	} catch {
		// text output
	}
	return { code, stdout, stderr, json };
}
