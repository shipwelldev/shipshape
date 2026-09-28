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

export interface ReviewResult {
	schema_version: typeof SCHEMA_VERSION;
	tool: { name: "shipshape"; version: string };
	review_id: string;
	status: ReviewStatus;
	exit_code: number;
	/** Present whenever the status is incomplete, error, or cancelled. */
	problem?: { reason: ProblemReason; message: string };
	target?: TargetSummary;
	model?: { provider: string; id: string; thinking: ThinkingLevel };
	policy: { fail_on: Severity };
	summary?: string;
	findings: Finding[];
	counts: { total: number; blocking: number; by_severity: Record<Severity, number> };
	coverage: Coverage;
	usage?: Usage;
	started_at: string;
	duration_ms: number;
}
