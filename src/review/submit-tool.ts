import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { Severity } from "../config/schema.js";
import type { ChangedFile, Hunk } from "../target/diff.js";
import { isExcluded, type TargetKind } from "../target/resolve.js";
import type { Category, Finding, Side } from "./types.js";

const FindingInput = Type.Object({
	severity: Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
	category: Type.Union([Type.Literal("bug"), Type.Literal("security"), Type.Literal("standards"), Type.Literal("other")]),
	title: Type.String({ description: "Short summary of the problem" }),
	description: Type.String({ description: "What is wrong and why, in terms a developer can act on" }),
	path: Type.String({ description: "File path relative to the workspace root" }),
	line_start: Type.Optional(Type.Integer({ minimum: 1, description: "First affected line (1-based)" })),
	line_end: Type.Optional(Type.Integer({ minimum: 1, description: "Last affected line (inclusive)" })),
	side: Type.Optional(
		Type.Union([Type.Literal("new"), Type.Literal("old")], {
			description: '"new" (default): reviewed version. "old": base version, for problems only in deleted lines.',
		}),
	),
	trigger: Type.Optional(Type.String({ description: "Input or state that causes the problem (required for bug/security)" })),
	impact: Type.String({ description: "What goes wrong, and for whom" }),
	evidence: Type.String({ description: "Code that demonstrates the problem, with path:line references" }),
	standard: Type.Optional(Type.String({ description: "The violated rule and the file documenting it (required for standards)" })),
	suggestion: Type.Optional(Type.String({ description: "How to fix it" })),
});

export const SubmitReviewParams = Type.Object({
	summary: Type.String({ description: "Two or three sentences on the overall state of the change" }),
	findings: Type.Array(FindingInput, { description: "Verified problems; empty when none were found" }),
	limitations: Type.Optional(Type.Array(Type.String(), { description: "Anything you could not review or verify" })),
});

export type FindingInput = Static<typeof FindingInput>;

// Keep the tool schema's literals in lockstep with the domain enums.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const schemaMatchesDomain: [Same<FindingInput["severity"], Severity>, Same<FindingInput["category"], Category>] = [true, true];
void schemaMatchesDomain;

interface SubmitDetails {
	accepted: boolean;
	findings?: number;
	problems?: string[];
}
export type FindingDraft = Omit<Finding, "id" | "blocking">;

export interface Report {
	summary: string;
	findings: FindingDraft[];
	limitations: string[];
}

export interface LocationContext {
	kind: TargetKind;
	workspace: string;
	exclude: readonly string[];
	files: readonly ChangedFile[];
	readBaseFile(path: string): Promise<string | undefined>;
}

export interface SubmissionState {
	report?: Report;
	/** Problems in the last recorded report when it was accepted only because the repair budget ran out. */
	unresolved?: string[];
	rejections: number;
}

/** Rejected submissions the reviewer may repair before the report is recorded as invalid. */
export const MAX_REPORT_REPAIRS = 2;

export function createSubmitReviewTool(context: LocationContext, state: SubmissionState) {
	return defineTool<typeof SubmitReviewParams, SubmitDetails>({
		name: "submit_review",
		label: "Submit review",
		description:
			"Submit the final code review report. Call once, after investigating. The report is validated; if it is rejected, fix the listed problems and call again with the complete report.",
		parameters: SubmitReviewParams,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const validator = new LocationValidator(context);
			const problems: string[] = [];
			const drafts: FindingDraft[] = [];
			for (const [index, input] of params.findings.entries()) {
				const result = await validator.validate(input);
				if (result.problems.length > 0) {
					problems.push(...result.problems.map((p) => `findings[${index}] "${input.title}": ${p}`));
				} else if (result.finding) {
					drafts.push(result.finding);
				}
			}
			const report: Report = {
				summary: params.summary.trim(),
				findings: drafts,
				limitations: (params.limitations ?? []).map((l) => l.trim()).filter(Boolean),
			};

			if (problems.length === 0) {
				state.report = report;
				state.unresolved = undefined;
				return {
					content: [{ type: "text", text: `Review accepted with ${drafts.length} finding(s). You are done; do not call any more tools.` }],
					details: { accepted: true, findings: drafts.length },
					terminate: true,
				};
			}

			state.rejections++;
			if (state.rejections > MAX_REPORT_REPAIRS) {
				// Out of repair budget: keep the valid findings as a partial result. The run is reported incomplete.
				state.report = report;
				state.unresolved = problems;
				return {
					content: [
						{
							type: "text",
							text: `Report recorded, but ${problems.length} problem(s) remain and the affected findings were dropped. Stop now.\n- ${problems.join("\n- ")}`,
						},
					],
					details: { accepted: false, problems },
					terminate: true,
				};
			}
			throw new Error(
				`The report was not accepted. Fix these problems and call submit_review again with the complete report (all findings, not only the corrected ones):\n- ${problems.join("\n- ")}`,
			);
		},
	});
}

interface Validation {
	finding?: FindingDraft;
	problems: string[];
}

class LocationValidator {
	private readonly cache = new Map<string, Promise<string | undefined>>();

	constructor(private readonly context: LocationContext) {}

	async validate(input: FindingInput): Promise<Validation> {
		const problems: string[] = [];
		for (const field of ["title", "description", "impact", "evidence"] as const) {
			if (!input[field].trim()) problems.push(`${field} must not be empty`);
		}
		if ((input.category === "bug" || input.category === "security") && !input.trigger?.trim()) {
			problems.push(`trigger is required for ${input.category} findings`);
		}
		if (input.category === "standards" && !input.standard?.trim()) {
			problems.push("standard is required for standards findings: cite the rule and the file that documents it");
		}

		const side: Side = input.side ?? "new";
		const path = this.normalizePath(input.path, problems);
		if (path === undefined) return { problems };
		if (isExcluded(path, this.context.exclude)) problems.push(`${path} is excluded from this review`);

		const content = await this.read(path, side);
		if (content === undefined) {
			problems.push(
				side === "new"
					? `${path} does not exist in the reviewed version${this.context.kind === "all" ? "" : ' (for a deleted file, use side "old")'}`
					: this.context.kind === "all"
						? 'side "old" is not available when reviewing the entire codebase'
						: `${path} does not exist in the base version`,
			);
			return { problems };
		}

		let lineEnd = input.line_end;
		if (input.line_start === undefined) {
			if (lineEnd !== undefined) problems.push("line_end requires line_start");
		} else {
			lineEnd ??= input.line_start;
			const count = lineCount(content);
			if (lineEnd < input.line_start) problems.push(`line_end ${lineEnd} is before line_start ${input.line_start}`);
			if (lineEnd > count) {
				problems.push(`lines ${input.line_start}-${lineEnd} are outside ${path}, which has ${count} line(s) in the ${side} version`);
			}
		}
		if (problems.length > 0) return { problems };

		const finding: FindingDraft = {
			severity: input.severity,
			category: input.category,
			title: input.title.trim(),
			description: input.description.trim(),
			path,
			side,
			impact: input.impact.trim(),
			evidence: input.evidence.trim(),
			in_diff: this.inDiff(path, side, input.line_start, lineEnd),
		};
		if (input.line_start !== undefined) {
			finding.line_start = input.line_start;
			finding.line_end = lineEnd;
		}
		if (input.trigger?.trim()) finding.trigger = input.trigger.trim();
		if (input.standard?.trim()) finding.standard = input.standard.trim();
		if (input.suggestion?.trim()) finding.suggestion = input.suggestion.trim();
		return { finding, problems };
	}

	/** Accept workspace-relative or in-workspace absolute paths; return a POSIX relative path. */
	private normalizePath(raw: string, problems: string[]): string | undefined {
		const trimmed = raw.trim();
		if (!trimmed) {
			problems.push("path must not be empty");
			return undefined;
		}
		const workspace = resolve(this.context.workspace);
		const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(workspace, trimmed);
		const rel = relative(workspace, absolute);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
			problems.push(`path ${JSON.stringify(raw)} is outside the workspace; use a path relative to the workspace root`);
			return undefined;
		}
		return rel.split(sep).join("/");
	}

	private read(path: string, side: Side): Promise<string | undefined> {
		const key = `${side}:${path}`;
		let pending = this.cache.get(key);
		if (!pending) {
			pending =
				side === "new"
					? readFile(join(this.context.workspace, path), "utf8").catch(() => undefined)
					: this.context.readBaseFile(path);
			this.cache.set(key, pending);
		}
		return pending;
	}

	private inDiff(path: string, side: Side, start: number | undefined, end: number | undefined): boolean {
		const file = this.context.files.find((f) => (side === "new" ? f.path === path : (f.oldPath ?? f.path) === path));
		if (!file) return false;
		if (start === undefined || end === undefined || (file.status === "added" && side === "new")) return true;
		return file.hunks.some((hunk) => overlaps(hunk, side, start, end));
	}
}

function overlaps(hunk: Hunk, side: Side, start: number, end: number): boolean {
	const [from, count] = side === "new" ? [hunk.newStart, hunk.newLines] : [hunk.oldStart, hunk.oldLines];
	return count > 0 && start <= from + count - 1 && end >= from;
}

function lineCount(content: string): number {
	if (content.length === 0) return 0;
	const lines = content.split("\n").length;
	return content.endsWith("\n") ? lines - 1 : lines;
}
