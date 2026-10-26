import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/cli/args.js";
import { globalConfigDir } from "../src/config/paths.js";
import { ConfigError, loadConfig } from "../src/config/resolve.js";
import { callTool, cli, collate, fauxProviders, highBug, makeRepo, submit, tempDir, writeFiles } from "./helpers.js";

const MATH_BASE = "export function add(a: number, b: number) {\n\treturn a + b;\n}\n";
const MATH_CHANGED = `${MATH_BASE}\nexport function divide(a: number, b: number) {\n\treturn a / b;\n}\n`;

/** A repository whose working tree adds divide() to src/math.ts (line 6 is the division). */
function changedRepo(extra: Record<string, string> = {}): string {
	const repo = makeRepo({ "src/math.ts": MATH_BASE, ...extra });
	writeFiles(repo, { "src/math.ts": MATH_CHANGED });
	return repo;
}

const ALPHA = "alpha/reviewer";
const BETA = "beta/reviewer";
const GAMMA = "gamma/reviewer";
const CHAIR = "chair/reviewer";

const models = (...selectors: string[]) => selectors.flatMap((selector) => ["--model", selector]);
const providerError = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid request: model rejected input" });

async function councilJson(
	repo: string,
	scripts: Record<string, FauxResponseStep[]>,
	args: string[],
	options: { signal?: AbortSignal } = {},
) {
	const { fauxes, factory } = fauxProviders(scripts);
	const run = await cli(["review", "--format", "json", ...args], { cwd: repo, factory, ...options });
	return { ...run, fauxes };
}

/** Concatenated JSON of the transcript messages with a given role. */
function byRole(messages: readonly { role: string }[], role: string): string {
	return messages
		.filter((message) => message.role === role)
		.map((message) => JSON.stringify(message))
		.join("\n");
}

describe("council reviews", () => {
	it("merges duplicate findings, keeping the highest severity and every reporter", async () => {
		const repo = changedRepo();
		let task = "";
		let tools: string[] | undefined;
		const { code, json, fauxes } = await councilJson(
			repo,
			{
				alpha: [submit([highBug("src/math.ts", 6, { severity: "medium" })])],
				beta: [
					submit([
						highBug("src/math.ts", 5, { title: "divide() accepts zero" }),
						highBug("src/math.ts", 1, { severity: "low", title: "Unrelated" }),
					]),
				],
				chair: [
					(context) => {
						task = byRole(context.messages, "user");
						tools = context.messages.flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []));
						return collate(
							[{ findings: ["R1-F1", "R2-F1"], primary: "R1-F1", description: "Both reviewers found that divide() lacks a zero check." }],
							"Merged summary.",
						);
					},
				],
			},
			[...models(ALPHA, BETA), "--collator", CHAIR],
		);
		expect(code).toBe(1);
		expect(json.status).toBe("failed");
		expect(json.model).toBeUndefined();
		expect(json.summary).toBe("Merged summary.");
		expect(json.findings).toHaveLength(2);
		expect(json.findings[0]).toMatchObject({
			id: "F1",
			severity: "high",
			title: "Division by zero",
			description: "Both reviewers found that divide() lacks a zero check.",
			line_start: 6,
			reported_by: [ALPHA, BETA],
			blocking: true,
		});
		expect(json.findings[1]).toMatchObject({ id: "F2", severity: "low", title: "Unrelated", reported_by: [BETA] });
		expect(json.council).toMatchObject({
			min_reviewers: 2,
			reviewers: [
				{ label: ALPHA, provider: "alpha", id: "reviewer", status: "completed", findings: 1 },
				{ label: BETA, status: "completed", findings: 2 },
			],
			collator: { label: CHAIR, status: "completed", merges: 1 },
		});
		expect(task).toContain("Reviewer 2: beta/reviewer");
		expect(task).toContain('\\"id\\": \\"R2-F2\\"');
		expect(tools).toEqual(["submit_collation"]);
		expect(fauxes.chair!.state.callCount).toBe(1);
	});

	it("collates with the first model by default and labels progress by member", async () => {
		const repo = changedRepo();
		const { json, stderr } = await councilJson(
			repo,
			{
				alpha: [submit([highBug("src/math.ts", 6)]), collate([{ findings: ["R1-F1", "R2-F1"], primary: "R2-F1" }])],
				beta: [submit([highBug("src/math.ts", 6, { severity: "critical", title: "Crash on zero" })])],
			},
			models(ALPHA, BETA),
		);
		expect(json.findings).toHaveLength(1);
		expect(json.findings[0]).toMatchObject({ severity: "critical", title: "Crash on zero", reported_by: [ALPHA, BETA] });
		expect(json.council?.collator).toMatchObject({ label: ALPHA, status: "completed", merges: 1 });
		expect(stderr).toContain("council of 2: alpha/reviewer, beta/reviewer · collator: alpha/reviewer");
		expect(stderr).toContain("[beta/reviewer] submit_review 1 finding(s)");
		expect(stderr).toContain("[alpha/reviewer] finished with 1 finding(s)");
		expect(stderr).toContain("collating 2 finding(s) from 2 reviewers · alpha/reviewer");
		expect(stderr).toContain("[collator] submit_collation 1 merge(s)");
	});

	it("skips the collator when fewer than two reviewers report findings", async () => {
		const repo = changedRepo();
		const { code, json, fauxes } = await councilJson(
			repo,
			{
				alpha: [submit([highBug("src/math.ts", 6)], { summary: "Alpha found a bug." })],
				beta: [submit([], { summary: "Beta found nothing." })],
				chair: [],
			},
			[...models(ALPHA, BETA), "--collator", CHAIR],
		);
		expect(code).toBe(1);
		expect(json.findings).toHaveLength(1);
		expect(json.findings[0]!.reported_by).toEqual([ALPHA]);
		expect(json.council?.collator).toMatchObject({ status: "skipped", merges: 0 });
		expect(json.summary).toBe("alpha/reviewer: Alpha found a bug.\n\nbeta/reviewer: Beta found nothing.");
		expect(fauxes.chair!.state.callCount).toBe(0);
	});

	it("rejects a collation that names unknown findings or merges a single finding, then accepts the repair", async () => {
		const repo = changedRepo();
		let feedback = "";
		const { json } = await councilJson(
			repo,
			{
				alpha: [submit([highBug("src/math.ts", 6)])],
				beta: [submit([highBug("src/math.ts", 6)])],
				chair: [
					collate([
						{ findings: ["R1-F1", "R9-F9"], primary: "R1-F1" },
						{ findings: ["R2-F1", "R2-F1"], primary: "R1-F1" },
					]),
					(context) => {
						feedback = JSON.stringify(context.messages.at(-1));
						return collate([{ findings: ["R1-F1", "R2-F1"], primary: "R2-F1" }]);
					},
				],
			},
			[...models(ALPHA, BETA), "--collator", CHAIR],
		);
		expect(feedback).toContain('merges[0]: unknown finding ID \\"R9-F9\\"');
		expect(feedback).toContain("merges[1]: R2-F1 is listed twice");
		expect(feedback).toContain("merges[1]: a merge needs at least two different findings");
		expect(feedback).toContain('merges[1]: primary \\"R1-F1\\" is not one of the group');
		expect(json.status).toBe("failed");
		expect(json.findings).toHaveLength(1);
		expect(json.council?.collator.merges).toBe(1);
	});

	it("is incomplete with unmerged findings when the collator never produces a valid collation", async () => {
		const repo = changedRepo();
		const invalid = collate([{ findings: ["R1-F1", "nope"], primary: "R1-F1" }]);
		const { code, json } = await councilJson(
			repo,
			{
				alpha: [submit([highBug("src/math.ts", 6)])],
				beta: [submit([highBug("src/math.ts", 6, { severity: "low" })])],
				chair: [invalid, invalid, invalid],
			},
			[...models(ALPHA, BETA), "--collator", CHAIR],
		);
		expect(code).toBe(2);
		expect(json).toMatchObject({ status: "incomplete", problem: { reason: "collation_failed" } });
		expect(json.problem?.message).toContain("The collator (chair/reviewer) failed: The collator's submission still had 1 problem(s)");
		expect(json.findings.map((finding) => finding.reported_by)).toEqual([[ALPHA], [BETA]]);
		expect(json.council?.collator).toMatchObject({ status: "failed", problem: { reason: "invalid_report" } });
	});

	it("is incomplete when the collator's provider fails", async () => {
		const repo = changedRepo();
		const { code, json } = await councilJson(
			repo,
			{
				alpha: [submit([highBug("src/math.ts", 6)])],
				beta: [submit([highBug("src/math.ts", 6)])],
				chair: [providerError()],
			},
			[...models(ALPHA, BETA), "--collator", CHAIR],
		);
		expect(code).toBe(2);
		expect(json).toMatchObject({ status: "incomplete", problem: { reason: "collation_failed" } });
		expect(json.problem?.message).toContain("model rejected input");
		expect(json.findings).toHaveLength(2);
	});

	it("a single model is an ordinary review", async () => {
		const repo = changedRepo();
		const { json } = await councilJson(repo, { alpha: [submit([highBug("src/math.ts", 6)])] }, [...models(ALPHA), "--collator", CHAIR]);
		expect(json.model).toEqual({ provider: "alpha", id: "reviewer", thinking: "off" });
		expect(json.council).toBeUndefined();
		expect(json.findings[0]!.reported_by).toBeUndefined();
	});

	it("tells repeated models apart by position", async () => {
		const repo = changedRepo();
		const { code, json } = await councilJson(repo, { alpha: [submit([]), submit([])] }, models(ALPHA, ALPHA));
		expect(code).toBe(0);
		expect(json.council?.reviewers.map((reviewer) => reviewer.label)).toEqual(["alpha/reviewer#1", "alpha/reviewer#2"]);
	});

	it("renders the council and who reported each finding", async () => {
		const repo = changedRepo();
		const { fauxes: _fauxes, factory } = fauxProviders({
			alpha: [submit([highBug("src/math.ts", 6)])],
			beta: [submit([highBug("src/math.ts", 6)])],
			chair: [collate([{ findings: ["R1-F1", "R2-F1"], primary: "R1-F1" }])],
		});
		const { stdout } = await cli(["review", ...models(ALPHA, BETA), "--collator", CHAIR], { cwd: repo, factory });
		expect(stdout).toContain("Council: alpha/reviewer, beta/reviewer (2 of 2 completed; thinking: off)\n");
		expect(stdout).toContain("Collator: chair/reviewer (1 duplicate group merged)\n");
		expect(stdout).toContain("   Reported by: alpha/reviewer, beta/reviewer (2 of 2)\n");
	});
});

describe("council quorum and failures", () => {
	const scripts = () => ({
		alpha: [submit([highBug("src/math.ts", 6)])],
		beta: [submit([])],
		gamma: [providerError()],
	});

	it("passes judgment on the reviewers that finished when the quorum is met", async () => {
		const repo = changedRepo();
		const { code, json } = await councilJson(repo, scripts(), [...models(ALPHA, BETA, GAMMA), "--min-reviewers", "2"]);
		expect(code).toBe(1);
		expect(json.status).toBe("failed");
		expect(json.council?.min_reviewers).toBe(2);
		expect(json.council?.reviewers[2]).toMatchObject({ label: GAMMA, status: "failed", problem: { reason: "provider_error" } });
		expect(json.coverage.limitations.some((l) => l.startsWith("Reviewer gamma/reviewer did not complete (provider_error)"))).toBe(true);
	});

	it("requires every reviewer by default", async () => {
		const repo = changedRepo();
		const { code, json } = await councilJson(repo, scripts(), models(ALPHA, BETA, GAMMA));
		expect(code).toBe(2);
		expect(json).toMatchObject({
			status: "incomplete",
			problem: { reason: "quorum_not_met", message: "2 of 3 reviewers completed; review.min_reviewers requires 3." },
		});
		expect(json.findings).toHaveLength(1);
	});

	it("counts the validated findings of a reviewer that did not complete", async () => {
		const repo = changedRepo();
		const partial = submit([highBug("src/math.ts", 6), highBug("src/math.ts", 99)]);
		const { code, json } = await councilJson(
			repo,
			{ alpha: [partial, partial, partial], beta: [submit([])] },
			[...models(ALPHA, BETA), "--min-reviewers", "1"],
		);
		expect(code).toBe(1);
		expect(json.status).toBe("failed");
		expect(json.council?.reviewers[0]).toMatchObject({ status: "failed", findings: 1, problem: { reason: "invalid_report" } });
		expect(json.findings[0]).toMatchObject({ line_start: 6, reported_by: [ALPHA] });
	});

	it("rejects a quorum larger than the council before calling any model", async () => {
		const repo = changedRepo();
		const { code, json, fauxes } = await councilJson(repo, { alpha: [submit([])] }, [...models(ALPHA), "--min-reviewers", "2"]);
		expect(code).toBe(2);
		expect(json.problem).toEqual({
			reason: "config_error",
			message:
				"review.min_reviewers is 2 (from the command line), but only 1 model(s) are configured (from the command line). Lower it with --min-reviewers, or configure more models.",
		});
		expect(fauxes.alpha!.state.callCount).toBe(0);
	});

	it("checks the collator's credentials before the target, even with nothing to review", async () => {
		const repo = makeRepo();
		const { json } = await councilJson(repo, { alpha: [], beta: [] }, [...models(ALPHA, BETA), "--collator", "anthropic/claude-sonnet-5"]);
		expect(json).toMatchObject({ status: "error", problem: { reason: "auth_error" } });
	});

	it("reports cancellation without running the collator", async () => {
		const repo = changedRepo();
		const controller = new AbortController();
		const { code, json, fauxes } = await councilJson(
			repo,
			{
				alpha: [
					() => {
						controller.abort();
						return callTool("read", { path: "src/math.ts" });
					},
					submit([highBug("src/math.ts", 6)]),
				],
				beta: [submit([highBug("src/math.ts", 6)])],
				chair: [collate([])],
			},
			[...models(ALPHA, BETA), "--collator", CHAIR],
			{ signal: controller.signal },
		);
		expect(code).toBe(130);
		expect(json.status).toBe("cancelled");
		expect(fauxes.chair!.state.callCount).toBe(0);
	});
});

describe("council configuration", () => {
	function setup(globalConfig?: string) {
		const home = tempDir("shipshape-council-");
		const env = { ...process.env, XDG_CONFIG_HOME: join(home, "xdg") };
		if (globalConfig !== undefined) {
			mkdirSync(globalConfigDir(env), { recursive: true });
			writeFileSync(join(globalConfigDir(env), "config.toml"), globalConfig);
		}
		return { home, env };
	}

	async function load(globalConfig: string, ...argv: string[]) {
		const { home, env } = setup(globalConfig);
		const command = parseCommand(["review", ...argv]);
		if (command.name !== "review") throw new Error("expected review");
		return loadConfig({ cli: command.settings, invocationDir: home, projectRoot: undefined, env });
	}

	it("accepts one model or a list, from files and repeated flags", async () => {
		expect((await load(`model = ["a/x", "b/y"]\ncollator = "c/z"\n`)).config).toMatchObject({ model: ["a/x", "b/y"], collator: "c/z" });
		expect((await load(`model = "a/x"\n`, "--model", "b/y", "--model", "c/z")).config.model).toEqual(["b/y", "c/z"]);
		expect((await load("")).config.review.min_reviewers).toBe("all");
		expect((await load(`[review]\nmin_reviewers = 2\n`)).config.review.min_reviewers).toBe(2);
	});

	it("rejects an empty or malformed model list and an invalid quorum", async () => {
		const problems = async (text: string, ...argv: string[]) => {
			const error = await load(text, ...argv).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(ConfigError);
			return (error as ConfigError).message;
		};
		expect(await problems(`model = []\n`)).toContain("model: expected at least one model; got an empty list");
		expect(await problems(`model = ["a/x", "nope"]\n`)).toContain(`model: expected a provider-qualified model such as "anthropic/<model-id>"; got "nope"`);
		expect(await problems(`collator = "nope"\n`)).toContain("collator: expected a provider-qualified model");
		expect(await problems(`[review]\nmin_reviewers = 0\n`)).toContain(`review.min_reviewers: expected "all" or a whole number of at least 1; got 0`);
		expect(await problems("", "--min-reviewers", "most")).toContain(`--min-reviewers: expected "all" or a whole number of at least 1; got "most"`);
	});

	it("writes one model as a string and several as a list with config set", async () => {
		const { home, env } = setup();
		const globalFile = join(globalConfigDir(env), "config.toml");
		await cli(["config", "set", "model", "a/x", "--global"], { cwd: home, env });
		expect(readFileSync(globalFile, "utf8")).toBe(`model = "a/x"\n`);
		const set = await cli(["config", "set", "model", "a/x", "b/y", "--global"], { cwd: home, env });
		expect(set.stdout).toBe(`Set model = [ "a/x", "b/y" ] in ${globalFile}\n`);
		await cli(["config", "set", "review.min_reviewers", "1", "--global"], { cwd: home, env });
		expect(readFileSync(globalFile, "utf8")).toBe(`model = [ "a/x", "b/y" ]\n\n[review]\nmin_reviewers = 1\n`);
		const show = await cli(["config", "show"], { cwd: home, env });
		expect(show.stdout).toContain(`model = ["a/x","b/y"]\n# collator = (not set; a council uses its first model)\n`);
		expect(show.stdout).toContain("min_reviewers = 1\n");
	});
});
