import { SEVERITIES, type Severity, severityRank } from "../config/schema.js";
import type { Finding, ReviewResult, ReviewStatus } from "./types.js";

export type CancelSignal = "SIGINT" | "SIGTERM";

/** 0 = pass, 1 = blocking findings, 2 = no trustworthy result, 128+n = cancelled by signal n. */
export function exitCodeFor(status: ReviewStatus, signal: CancelSignal = "SIGINT"): number {
	switch (status) {
		case "passed":
		case "no_changes":
			return 0;
		case "failed":
			return 1;
		case "incomplete":
		case "error":
			return 2;
		case "cancelled":
			return signal === "SIGTERM" ? 143 : 130;
	}
}

export function isBlocking(severity: Severity, failOn: Severity): boolean {
	return severityRank(severity) >= severityRank(failOn);
}

export function countFindings(findings: readonly Finding[]): ReviewResult["counts"] {
	const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
	for (const finding of findings) bySeverity[finding.severity]++;
	return {
		total: findings.length,
		blocking: findings.filter((finding) => finding.blocking).length,
		by_severity: bySeverity,
	};
}

/** Most severe first, then by location, so output is stable across runs with the same findings. */
export function sortFindings(findings: Finding[]): Finding[] {
	return findings.sort(
		(a, b) =>
			severityRank(b.severity) - severityRank(a.severity) ||
			a.path.localeCompare(b.path) ||
			(a.line_start ?? 0) - (b.line_start ?? 0),
	);
}
