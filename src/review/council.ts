import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelSelector, ThinkingLevel } from "../config/schema.js";
import type { PiModel } from "../runtime/pi.js";
import type { ReviewTarget } from "../target/resolve.js";
import { type CollationOutcome, type CouncilEntry, mergeFindings, runCollationSession } from "./collate.js";
import { type AgentRunOutcome, type ProgressEvent, reportedUsage, runReviewSession, type SessionOutcome, totalUsage } from "./run.js";
import type { CouncilParticipant, CouncilSummary, ParticipantStatus, ProblemReason } from "./types.js";

export type CouncilProgress =
	| { type: "reviewer_done"; source: string; findings: number }
	| { type: "reviewer_failed"; source: string; message: string }
	| { type: "collate"; findings: number; reviewers: number; model: string };

export interface CouncilMember {
	label: string;
	selector: ModelSelector;
	model: PiModel;
	/** Signed in with a subscription, so list-price cost is left out. */
	subscription: boolean;
}

export interface CouncilOptions {
	target: ReviewTarget;
	runtime: ModelRuntime;
	reviewers: readonly CouncilMember[];
	collator: CouncilMember;
	/** Reviewers that must complete for a trustworthy result. */
	minReviewers: number;
	thinking: ThinkingLevel;
	agentDir: string;
	systemPrompt: string;
	taskPrompt: string;
	exclude: readonly string[];
	/** Deadline for the reviewers (together), and separately for the collator. 0 disables both. */
	timeoutSeconds: number;
	signal: AbortSignal;
	onProgress?: (event: ProgressEvent | CouncilProgress) => void;
}

export interface CouncilOutcome extends SessionOutcome {
	council: CouncilSummary;
}

/** "a/x", "a/x" -> "a/x#1", "a/x#2": a repeated model is told apart by position. */
export function councilLabels(models: readonly string[]): string[] {
	const counts = new Map<string, number>();
	for (const model of models) counts.set(model, (counts.get(model) ?? 0) + 1);
	const seen = new Map<string, number>();
	return models.map((model) => {
		if (counts.get(model) === 1) return model;
		const n = (seen.get(model) ?? 0) + 1;
		seen.set(model, n);
		return `${model}#${n}`;
	});
}

/**
 * Run every reviewer in parallel on the same prompts, then have the collator merge duplicate
 * findings. The verdict never depends on the collator's judgment: merging only combines
 * findings, and a merged finding keeps the highest severity in its group.
 */
export async function runCouncil(options: CouncilOptions): Promise<CouncilOutcome> {
	const outcomes = await Promise.all(
		options.reviewers.map(async (reviewer): Promise<SessionOutcome> => {
			const outcome: SessionOutcome = await guarded(options.signal, () =>
				runReviewSession({
					target: options.target,
					runtime: options.runtime,
					model: reviewer.model,
					thinking: options.thinking,
					agentDir: options.agentDir,
					systemPrompt: options.systemPrompt,
					taskPrompt: options.taskPrompt,
					exclude: options.exclude,
					timeoutSeconds: options.timeoutSeconds,
					signal: options.signal,
					source: reviewer.label,
					onProgress: options.onProgress,
				}),
			);
			if (!outcome.cancelled) {
				options.onProgress?.(
					outcome.problem
						? { type: "reviewer_failed", source: reviewer.label, message: outcome.problem.message }
						: { type: "reviewer_done", source: reviewer.label, findings: outcome.report?.findings.length ?? 0 },
				);
			}
			return outcome;
		}),
	);

	// A failed reviewer's validated findings still count: they can only make the verdict stricter.
	const entries: CouncilEntry[] = options.reviewers.flatMap((reviewer, position) => {
		const outcome = outcomes[position]!;
		return outcome.report ? [{ label: reviewer.label, position, report: outcome.report, completed: !outcome.problem && !outcome.cancelled }] : [];
	});
	let cancelled = options.signal.aborted || outcomes.some((outcome) => outcome.cancelled);

	// Duplicates can only exist across reviewers, so a collator is needed only when two or more reported findings.
	const reporting = entries.filter((entry) => entry.report.findings.length > 0);
	let collation: CollationOutcome | undefined;
	if (!cancelled && reporting.length >= 2) {
		options.onProgress?.({
			type: "collate",
			findings: reporting.reduce((sum, entry) => sum + entry.report.findings.length, 0),
			reviewers: reporting.length,
			model: options.collator.label,
		});
		collation = await guarded(options.signal, () =>
			runCollationSession({
				workspace: options.target.workspace,
				runtime: options.runtime,
				model: options.collator.model,
				thinking: options.thinking,
				agentDir: options.agentDir,
				targetDescription: options.target.description,
				entries,
				timeoutSeconds: options.timeoutSeconds,
				signal: options.signal,
				onProgress: options.onProgress,
			}),
		);
		cancelled ||= collation.cancelled;
	}

	const limitations: string[] = [];
	options.reviewers.forEach((reviewer, position) => {
		const problem = outcomes[position]!.problem;
		if (problem) limitations.push(`Reviewer ${reviewer.label} did not complete (${problem.reason}): ${problem.message}`);
	});
	for (const entry of entries) limitations.push(...entry.report.limitations.map((limitation) => `${entry.label}: ${limitation}`));

	const completed = outcomes.filter((outcome) => !outcome.cancelled && !outcome.problem).length;
	const collationProblem = collation?.problem && {
		reason: "collation_failed" as const,
		message: `The collator (${options.collator.label}) failed: ${collation.problem.message} Findings are shown unmerged.`,
	};
	let problem: { reason: ProblemReason; message: string } | undefined;
	if (completed < options.minReviewers) {
		problem = {
			reason: "quorum_not_met",
			message: `${completed} of ${options.reviewers.length} reviewers completed; review.min_reviewers requires ${options.minReviewers}.`,
		};
		if (collationProblem) limitations.push(collationProblem.message);
	} else {
		problem = collationProblem;
	}

	const reviewerUsage = options.reviewers.map((reviewer, position) => ({ usage: outcomes[position]!.usage, subscription: reviewer.subscription }));
	const usage = totalUsage([...reviewerUsage, { usage: collation?.usage, subscription: options.collator.subscription }]);
	const participant = (member: CouncilMember, outcome: AgentRunOutcome | undefined): CouncilParticipant => {
		const memberUsage = reportedUsage(outcome?.usage, member.subscription);
		return {
			label: member.label,
			provider: member.selector.provider,
			id: member.selector.id,
			thinking: outcome?.thinking ?? options.thinking,
			status: statusOf(outcome),
			...(outcome?.problem ? { problem: outcome.problem } : {}),
			...(memberUsage ? { usage: memberUsage } : {}),
		};
	};
	const council: CouncilSummary = {
		min_reviewers: options.minReviewers,
		reviewers: options.reviewers.map((reviewer, position) => ({
			...participant(reviewer, outcomes[position]),
			findings: outcomes[position]!.report?.findings.length ?? 0,
		})),
		collator: { ...participant(options.collator, collation), merges: collation?.collation?.merges.length ?? 0 },
	};

	const filesRead = [...new Set(outcomes.flatMap((outcome) => outcome.filesRead))].sort();
	return {
		report: {
			summary: collation?.collation?.summary || combinedSummary(entries),
			findings: mergeFindings(entries, collation?.collation?.merges),
			limitations,
		},
		...(cancelled ? {} : problem ? { problem } : {}),
		cancelled,
		filesRead,
		...(usage ? { usage } : {}),
		council,
	};
}

function statusOf(outcome: AgentRunOutcome | undefined): ParticipantStatus {
	if (!outcome) return "skipped";
	if (outcome.cancelled) return "cancelled";
	return outcome.problem ? "failed" : "completed";
}

/** Without a collator's summary, show each reviewer's own. */
function combinedSummary(entries: readonly CouncilEntry[]): string {
	return entries
		.filter((entry) => entry.report.summary)
		.map((entry) => `${entry.label}: ${entry.report.summary}`)
		.join("\n\n");
}

/** One member's unexpected failure must not take down the others; it counts against the quorum. */
async function guarded<T extends AgentRunOutcome>(signal: AbortSignal, run: () => Promise<T>): Promise<T | AgentRunOutcome> {
	try {
		return await run();
	} catch (error) {
		if (signal.aborted) return { cancelled: true, filesRead: [] };
		const message = `Unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
		return { cancelled: false, filesRead: [], problem: { reason: "internal_error", message } };
	}
}
