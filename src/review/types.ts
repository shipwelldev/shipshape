import type { Severity, ThinkingLevel } from "../config/schema.js";
import type { ChangeStatus } from "../target/diff.js";
import type { TargetIdentity, TargetKind } from "../target/resolve.js";

export const SCHEMA_VERSION = 1;

export const CATEGORIES = ["bug", "security", "standards", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export type Side = "new" | "old";

export interface Finding {
	id: string;
	severity: Severity;
	category: Category;
	title: string;
	description: string;
	/** Repository-relative POSIX path. */
	path: string;
	line_start?: number;
	line_end?: number;
	/** "new" = reviewed version; "old" = base version (deleted lines). */
	side: Side;
	trigger?: string;
	impact: string;
	evidence: string;
	standard?: string;
	suggestion?: string;
	/**
	 * Whether the location is visible in the diff: it overlaps a hunk, including the hunk's
	 * context lines (always false for full-codebase reviews). A file-level finding on a
	 * changed file counts as in the diff.
	 */
	in_diff: boolean;
	/** Whether the finding meets the configured failure threshold. */
	blocking: boolean;
	/** Council reviews only: the reviewers that reported this problem, in council order. */
	reported_by?: string[];
}

export type ReviewStatus = "passed" | "failed" | "no_changes" | "incomplete" | "error" | "cancelled";

/** Why a review did not produce a trustworthy complete result. */
export type ProblemReason =
	| "usage_error"
	| "config_error"
	| "target_error"
	| "auth_error"
	| "model_error"
	| "provider_error"
	| "timeout"
	| "missing_report"
	| "invalid_report"
	| "target_changed"
	| "quorum_not_met"
	| "collation_failed"
	| "cancelled"
	| "internal_error";

export interface TargetSummary {
	kind: TargetKind;
	root: string;
	description: string;
	identity: TargetIdentity;
	/** Changed files in scope (diff targets only). */
	files: Array<{
		path: string;
		old_path?: string;
		status: ChangeStatus;
		additions: number;
		deletions: number;
		binary: boolean;
	}>;
	/** Number of files in scope (changed files, or the inventory for full-codebase reviews). */
	file_count: number;
	excluded: string[];
}

export interface Coverage {
	/** Files whose diff was left out of the prompt to fit the budget (the agent could still read them). */
	diff_omitted: string[];
	/** Workspace files the agent opened with the read tool. */
	files_read: string[];
	/** Known gaps: declared by the reviewer or detected by Ship Shape. */
	limitations: string[];
}

export interface Usage {
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	/** List-price cost; omitted when none is reported, and for subscription sign-ins. */
	cost_usd?: number;
}

export type ParticipantStatus = "completed" | "failed" | "cancelled" | "skipped";

export interface CouncilParticipant {
	/** The model selector, with "#n" appended when the same model is listed more than once. */
	label: string;
	provider: string;
	id: string;
	thinking: ThinkingLevel;
	status: ParticipantStatus;
	/** Why the participant did not complete. */
	problem?: { reason: ProblemReason; message: string };
	usage?: Usage;
}

export interface CouncilSummary {
	/** Reviewers that had to complete ("all" resolved to the reviewer count). */
	min_reviewers: number;
	/** In configuration order; `findings` counts the validated findings each one submitted. */
	reviewers: Array<CouncilParticipant & { findings: number }>;
	/** `merges` counts the groups of duplicates combined into one finding. "skipped" means there was nothing to reconcile. */
	collator: CouncilParticipant & { merges: number };
}

export interface ReviewResult {
	schema_version: typeof SCHEMA_VERSION;
	tool: { name: "shipshape"; version: string };
	review_id: string;
	status: ReviewStatus;
	exit_code: number;
	/** Present whenever the status is incomplete, error, or cancelled. */
	problem?: { reason: ProblemReason; message: string };
	target?: TargetSummary;
	/** Single-model reviews; a council review reports its models under `council` instead. */
	model?: { provider: string; id: string; thinking: ThinkingLevel };
	council?: CouncilSummary;
	policy: { fail_on: Severity };
	summary?: string;
	findings: Finding[];
	counts: { total: number; blocking: number; by_severity: Record<Severity, number> };
	coverage: Coverage;
	usage?: Usage;
	started_at: string;
	duration_ms: number;
}
