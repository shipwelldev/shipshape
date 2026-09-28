import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ConfigError, type CliSettings, loadConfig } from "../config/resolve.js";
import { globalConfigDir, piStateDir } from "../config/paths.js";
import { type OutputFormat, parseModelSelector, type ShipshapeConfig, type ThinkingLevel } from "../config/schema.js";
import {
	createModelRuntime,
	ensureAuth,
	findModel,
	type ModelRuntimeFactory,
	modelsFilePath,
	SetupError,
} from "../runtime/pi.js";
import { GitError } from "../target/git.js";
import {
	locateProject,
	type ReviewTarget,
	resolveTarget,
	TargetError,
	type TargetKind,
} from "../target/resolve.js";
import { VERSION } from "../version.js";
import { type CancelSignal, countFindings, exitCodeFor, isBlocking, sortFindings } from "./policy.js";
import { buildSystemPrompt, buildTaskPrompt, DEFAULT_FOCUS, readStandards } from "./prompt.js";
import { type ProgressEvent, runReviewSession, type SessionOutcome } from "./run.js";
import {
	type Finding,
	type ProblemReason,
	type ReviewResult,
	type ReviewStatus,
	SCHEMA_VERSION,
	type TargetSummary,
	type Usage,
} from "./types.js";

export type ReviewProgress =
	| ProgressEvent
	| { type: "start"; description: string; files: number; model: string }
	| { type: "no_changes"; description: string };

export interface ReviewRequest {
	kind: TargetKind;
	base?: string;
	head?: string;
	/** Selected directory (absolute). */
	dir: string;
	cli: CliSettings;
	/** Directory the command was invoked from. */
	invocationDir: string;
	/** `--config PATH`, resolved against the invocation directory. */
	configOverride?: string;
	env: Record<string, string | undefined>;
	signal: AbortSignal;
	/** Which signal cancelled the run, for the exit status. */
	cancelSignal?: () => CancelSignal | undefined;
	/** Output format from the CLI, used if configuration cannot be loaded. */
	cliFormat?: OutputFormat;
	onProgress?: (event: ReviewProgress) => void;
	createModelRuntime?: ModelRuntimeFactory;
}

export interface ReviewResponse {
	result: ReviewResult;
	format: OutputFormat;
}

class Stop extends Error {
	constructor(
		readonly reason: ProblemReason,
		message: string,
	) {
		super(message);
	}
}

export async function review(request: ReviewRequest): Promise<ReviewResponse> {
	const started = Date.now();
	const base = {
		reviewId: randomUUID(),
		startedAt: new Date(started).toISOString(),
		started,
	};
	let format: OutputFormat = request.cliFormat ?? "text";
	let config: ShipshapeConfig | undefined;
	let target: ReviewTarget | undefined;
	let model: ReviewResult["model"];

	try {
		// Checked between preparation steps so an interrupt can never end as no_changes or an error.
		const checkpoint = () => {
			if (request.signal.aborted) throw new Stop("cancelled", "The review was cancelled.");
		};
		const project = await locateProject(request.dir).catch((error: unknown) => {
			throw error instanceof GitError || error instanceof TargetError ? new Stop("target_error", error.message) : error;
		});
		checkpoint();
		const resolved = await loadConfig({
			cli: request.cli,
			invocationDir: request.invocationDir,
			projectRoot: project.root,
			projectConfigOverride: request.configOverride,
			env: request.env,
		}).catch((error: unknown) => {
			throw error instanceof ConfigError ? new Stop("config_error", error.message) : error;
		});
		config = resolved.config;
		format = config.format;
		checkpoint();

		if (!config.model) {
			throw new Stop(
				"config_error",
				`No model configured. Set model = "provider/model-id" in ${globalConfigDir(request.env)}/config.toml or .shipshape.toml, or pass --model.`,
			);
		}
		const selector = parseModelSelector(config.model)!;
		model = { provider: selector.provider, id: selector.id, thinking: config.thinking };
		const focus = await readFocus(config.review.focus_file);

		// Model and credentials are validated before the target is resolved, even though an empty
		// target needs no model: a CI gate with a missing or expired credential must fail rather
		// than pass on an empty diff.
		const runtime = await (request.createModelRuntime ?? createModelRuntime)({
			authFile: config.auth_file,
			modelsFile: modelsFilePath(globalConfigDir(request.env)),
		});
		let piModel;
		let auth;
		try {
			piModel = findModel(runtime, selector);
			auth = await ensureAuth(runtime, selector.provider, config.auth_file);
		} catch (error) {
			throw error instanceof SetupError ? new Stop(error.reason, error.message) : error;
		}
		checkpoint();

		target = await resolveTarget(project, {
			kind: request.kind,
			base: request.base,
			head: request.head,
			exclude: config.review.exclude,
		}).catch((error: unknown) => {
			throw error instanceof TargetError || error instanceof GitError ? new Stop("target_error", error.message) : error;
		});
		checkpoint();

		if (target.isEmpty) {
			request.onProgress?.({ type: "no_changes", description: target.description });
			const limitations =
				target.excluded.length > 0 ? [`${target.excluded.length} file(s) excluded by configuration were not reviewed.`] : [];
			return { format, result: finish(base, "no_changes", { config, target, model, limitations }) };
		}

		const standards = await readStandards(target.workspace, config.review.standards_files);
		checkpoint();
		const systemPrompt = buildSystemPrompt({
			targetKind: target.kind,
			focus,
			instructions: config.review.instructions,
		});
		const task = await buildTaskPrompt(target, standards.files);
		request.onProgress?.({
			type: "start",
			description: target.description,
			files: target.kind === "all" ? target.inventory.length : target.files.length,
			model: `${selector.provider}/${selector.id}`,
		});

		const outcome = await runReviewSession({
			target,
			runtime,
			model: piModel,
			thinking: config.thinking,
			agentDir: piStateDir(request.env),
			systemPrompt,
			taskPrompt: task.text,
			exclude: config.review.exclude,
			timeoutSeconds: config.review.timeout_seconds,
			signal: request.signal,
			onProgress: request.onProgress,
		});

		const limitations = [...standards.limitations, ...task.limitations];
		if (target.excluded.length > 0) limitations.push(`${target.excluded.length} file(s) excluded by configuration were not reviewed.`);
		let problem = outcome.problem;
		if (!outcome.cancelled && !problem) {
			const stability = await target.checkStability();
			if (stability === "changed") {
				problem = {
					reason: "target_changed",
					message: "The reviewed files changed while the review was running; findings may not match the current content.",
				};
			} else if (stability === "unknown") {
				limitations.push("Changes made during the review cannot be detected outside a Git repository.");
			}
		}
		// The stability check above can take a while; an interrupt during it still means cancelled.
		const cancelled = outcome.cancelled || request.signal.aborted;
		let status: ReviewStatus;
		if (cancelled) status = "cancelled";
		else if (problem) status = "incomplete";
		else status = hasBlocking(outcome, config) ? "failed" : "passed";
		return {
			format,
			result: finish(base, status, {
				config,
				target,
				model,
				outcome,
				limitations,
				diffOmitted: task.diffOmitted,
				problem: cancelled ? { reason: "cancelled", message: "The review was cancelled." } : problem,
				cancelSignal: request.cancelSignal?.(),
				hideCost: auth.subscription,
			}),
		};
	} catch (error) {
		if (request.signal.aborted) {
			const problem = { reason: "cancelled" as const, message: "The review was cancelled." };
			return {
				format,
				result: finish(base, "cancelled", { config, target, model, problem, cancelSignal: request.cancelSignal?.() }),
			};
		}
		const stop =
			error instanceof Stop
				? error
				: new Stop("internal_error", `Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		return {
			format,
			result: finish(base, "error", { config, target, model, problem: { reason: stop.reason, message: stop.message } }),
		};
	} finally {
		await target?.dispose();
	}
}

async function readFocus(path: string | undefined): Promise<string> {
	if (!path) return DEFAULT_FOCUS;
	try {
		const text = await readFile(path, "utf8");
		if (!text.trim()) throw new Stop("config_error", `review.focus_file ${path} is empty.`);
		return text;
	} catch (error) {
		if (error instanceof Stop) throw error;
		throw new Stop("config_error", `Cannot read review.focus_file ${path}: ${(error as Error).message}`);
	}
}

function hasBlocking(outcome: SessionOutcome, config: ShipshapeConfig): boolean {
	return (outcome.report?.findings ?? []).some((finding) => isBlocking(finding.severity, config.review.fail_on));
}

interface FinishParts {
	config?: ShipshapeConfig;
	target?: ReviewTarget;
	model?: { provider: string; id: string; thinking: ThinkingLevel };
	outcome?: SessionOutcome;
	limitations?: string[];
	diffOmitted?: string[];
	problem?: { reason: ProblemReason; message: string };
	cancelSignal?: CancelSignal;
	/** Leave out cost for subscription sign-ins, where list prices are not what is paid. */
	hideCost?: boolean;
}

function finish(
	base: { reviewId: string; startedAt: string; started: number },
	status: ReviewStatus,
	parts: FinishParts,
): ReviewResult {
	const failOn = parts.config?.review.fail_on ?? "high";
	const findings: Finding[] = sortFindings(
		(parts.outcome?.report?.findings ?? []).map((draft) => ({
			id: "",
			...draft,
			blocking: isBlocking(draft.severity, failOn),
		})),
	).map((finding, index) => ({ ...finding, id: `F${index + 1}` }));

	const summary = parts.outcome?.report?.summary;
	const usage = reportedUsage(parts.outcome?.usage, parts.hideCost === true);
	return {
		schema_version: SCHEMA_VERSION,
		tool: { name: "shipshape", version: VERSION },
		review_id: base.reviewId,
		status,
		exit_code: exitCodeFor(status, parts.cancelSignal),
		...(parts.problem ? { problem: parts.problem } : {}),
		...(parts.target ? { target: summarizeTarget(parts.target) } : {}),
		...(parts.model ? { model: { ...parts.model, thinking: parts.outcome?.thinking ?? parts.model.thinking } } : {}),
		policy: { fail_on: failOn },
		...(summary ? { summary } : {}),
		findings,
		counts: countFindings(findings),
		coverage: {
			diff_omitted: parts.diffOmitted ?? [],
			files_read: parts.outcome?.filesRead ?? [],
			limitations: [...(parts.limitations ?? []), ...(parts.outcome?.report?.limitations ?? [])],
		},
		...(usage ? { usage } : {}),
		started_at: base.startedAt,
		duration_ms: Date.now() - base.started,
	};
}

/** List-price cost is meaningless for a subscription sign-in, so it is left out rather than shown. */
export function reportedUsage(usage: Usage | undefined, subscription: boolean): Usage | undefined {
	if (!usage || !subscription) return usage;
	const { cost_usd: _listPrice, ...tokens } = usage;
	return tokens;
}

function summarizeTarget(target: ReviewTarget): TargetSummary {
	return {
		kind: target.kind,
		root: target.root,
		description: target.description,
		identity: target.identity,
		files: target.files.map((file) => ({
			path: file.path,
			...(file.oldPath ? { old_path: file.oldPath } : {}),
			status: file.status,
			additions: file.additions,
			deletions: file.deletions,
			binary: file.binary,
		})),
		file_count: target.kind === "all" ? target.inventory.length : target.files.length,
		excluded: target.excluded,
	};
}
