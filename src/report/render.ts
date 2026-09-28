import { styleText } from "node:util";
import type { Finding, ReviewResult } from "../review/types.js";

export function renderJson(result: ReviewResult): string {
	return `${JSON.stringify(result, null, 2)}\n`;
}

type Format = Parameters<typeof styleText>[0];
export type Styler = (format: Format, text: string) => string;

export const plain: Styler = (_format, text) => text;
export const colored: Styler = (format, text) => styleText(format, text, { validateStream: false });

const STATUS_LABEL: Record<ReviewResult["status"], [string, Format]> = {
	passed: ["PASSED", ["bold", "green"]],
	failed: ["FAILED", ["bold", "red"]],
	no_changes: ["NO CHANGES", ["bold", "green"]],
	incomplete: ["INCOMPLETE", ["bold", "yellow"]],
	error: ["ERROR", ["bold", "red"]],
	cancelled: ["CANCELLED", ["bold", "yellow"]],
};

const SEVERITY_STYLE: Record<Finding["severity"], Format> = {
	critical: ["bold", "red"],
	high: "red",
	medium: "yellow",
	low: "cyan",
};

export function renderText(result: ReviewResult, style: Styler = plain): string {
	const out: string[] = [];
	const [label, labelStyle] = STATUS_LABEL[result.status];
	out.push(`${style(labelStyle, label)}  ${headline(result)}`);
	if (result.problem && result.status !== "cancelled") {
		out.push(`${style("dim", `(${result.problem.reason})`)} ${result.problem.message}`);
	}
	if (result.target) {
		const files = result.target.file_count === 1 ? "1 file" : `${result.target.file_count} files`;
		out.push(`${style("dim", "Target:")} ${result.target.description} · ${files}`);
	}
	if (result.model) {
		out.push(`${style("dim", "Model:")}  ${result.model.provider}/${result.model.id} (thinking: ${result.model.thinking})`);
	}

	if (result.findings.length > 0) {
		const partial = result.status === "incomplete" || result.status === "cancelled";
		out.push("", style("bold", partial ? "Partial findings (the review did not complete)" : "Findings"));
		for (const finding of result.findings) out.push("", ...renderFinding(finding, style));
	}

	if (result.summary) out.push("", style("bold", "Summary"), indent(result.summary));
	if (result.coverage.limitations.length > 0) {
		out.push("", style("bold", "Limitations"), ...result.coverage.limitations.map((l) => `  - ${l}`));
	}
	const footer = usageLine(result);
	if (footer) out.push("", style("dim", footer));
	return `${out.join("\n")}\n`;
}

function headline(result: ReviewResult): string {
	const { total, blocking } = result.counts;
	switch (result.status) {
		case "passed":
			return total === 0
				? "No problems found."
				: `${plural(total, "finding")}, none at or above ${result.policy.fail_on}.`;
		case "failed":
			return `${plural(blocking, "blocking finding")} (fail_on: ${result.policy.fail_on}), ${total} total.`;
		case "no_changes":
			return result.target ? `Nothing to review in ${result.target.description}.` : "Nothing to review.";
		case "incomplete":
			return "The review did not produce a trustworthy complete result.";
		case "error":
			return "The review could not run.";
		case "cancelled":
			return "The review was cancelled.";
	}
}

function renderFinding(finding: Finding, style: Styler): string[] {
	const lines =
		finding.line_start === undefined
			? ""
			: finding.line_end && finding.line_end !== finding.line_start
				? `:${finding.line_start}-${finding.line_end}`
				: `:${finding.line_start}`;
	const where = `${finding.path}${lines}${finding.side === "old" ? " (base version)" : ""}`;
	const tags = [finding.category, finding.blocking ? "blocking" : undefined].filter(Boolean).join(", ");
	const out = [
		`${style(SEVERITY_STYLE[finding.severity], finding.severity.toUpperCase())} ${style("bold", finding.title)}`,
		`  ${style("underline", where)}  ${style("dim", `[${finding.id}; ${tags}]`)}`,
		indent(finding.description),
	];
	const field = (name: string, value: string | undefined) => {
		if (value) out.push(`  ${style("dim", `${name}:`)} ${value.replace(/\n/g, "\n    ")}`);
	};
	field("Trigger", finding.trigger);
	field("Impact", finding.impact);
	field("Evidence", finding.evidence);
	field("Standard", finding.standard);
	field("Suggestion", finding.suggestion);
	return out;
}

function usageLine(result: ReviewResult): string | undefined {
	const parts: string[] = [];
	if (result.usage) {
		parts.push(`${result.usage.input_tokens.toLocaleString("en-US")} input tokens`);
		parts.push(`${result.usage.output_tokens.toLocaleString("en-US")} output tokens`);
		if (result.usage.cost_usd !== undefined) parts.push(`$${result.usage.cost_usd.toFixed(4)}`);
	}
	parts.push(`${(result.duration_ms / 1000).toFixed(1)}s`);
	return parts.join(" · ");
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => (line ? `  ${line}` : line))
		.join("\n");
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
