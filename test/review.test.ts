import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { reportedUsage } from "../src/review/review.js";
import { createModelRuntime, type ModelRuntimeFactory } from "../src/runtime/pi.js";
import { describe, expect, it } from "vitest";
import {
	callTool,
	cli,
	FAUX_MODEL,
	fauxRuntime,
	git,
	highBug,
	makeRepo,
	say,
	submit,
	tempDir,
	writeFiles,
} from "./helpers.js";

/** Concatenated JSON of the transcript messages with a given role. */
function byRole(messages: readonly { role: string }[], role: string): string {
	return messages
		.filter((message) => message.role === role)
		.map((message) => JSON.stringify(message))
		.join("\n");
}

const MATH_BASE = "export function add(a: number, b: number) {\n\treturn a + b;\n}\n";
const MATH_CHANGED = `${MATH_BASE}\nexport function divide(a: number, b: number) {\n\treturn a / b;\n}\n`;

/** A repository whose working tree adds divide() to src/math.ts (line 6 is the division). */
function changedRepo(extra: Record<string, string> = {}): string {
	const repo = makeRepo({ "src/math.ts": MATH_BASE, ...extra });
	writeFiles(repo, { "src/math.ts": MATH_CHANGED });
	return repo;
}

async function reviewJson(repo: string, steps: FauxResponseStep[], args: string[] = [], options: { signal?: AbortSignal } = {}) {
	const { faux, factory } = fauxRuntime(steps);
	const run = await cli(["review", "--model", FAUX_MODEL, "--format", "json", ...args], { cwd: repo, factory, ...options });
	return { ...run, faux };
}

describe("review outcomes", () => {
	it("passes a clean review and records what the reviewer read", async () => {
		const repo = changedRepo();
		const { code, json, stderr } = await reviewJson(repo, [callTool("read", { path: "src/math.ts" }), submit([])]);
		expect(code).toBe(0);
		expect(json.status).toBe("passed");
		expect(json.exit_code).toBe(0);
		expect(json.findings).toEqual([]);
		expect(json.coverage.files_read).toEqual(["src/math.ts"]);
		expect(json.model).toEqual({ provider: "faux", id: "reviewer", thinking: "off" });
		expect(json.target).toMatchObject({ kind: "worktree", file_count: 1, files: [{ path: "src/math.ts", status: "modified" }] });
		expect(json.usage?.output_tokens).toBeGreaterThan(0);
		expect(stderr).toContain("read src/math.ts");
	});

	it("fails when a validated finding meets the threshold", async () => {
		const repo = changedRepo();
		const { code, json } = await reviewJson(repo, [submit([highBug("src/math.ts", 6)])]);
		expect(code).toBe(1);
		expect(json.status).toBe("failed");
		expect(json.findings).toHaveLength(1);
		expect(json.findings[0]).toMatchObject({
			id: "F1",
			severity: "high",
			path: "src/math.ts",
			line_start: 6,
			line_end: 6,
			side: "new",
			in_diff: true,
			blocking: true,
		});
		expect(json.counts).toMatchObject({ total: 1, blocking: 1 });
	});

	it("applies the configured failure threshold", async () => {
		const repo = changedRepo({ ".shipshape.toml": `[review]\nfail_on = "critical"\n` });
		const { code, json } = await reviewJson(repo, [submit([highBug("src/math.ts", 6)])]);
		expect(code).toBe(0);
		expect(json.status).toBe("passed");
		expect(json.policy.fail_on).toBe("critical");
		expect(json.findings[0]!.blocking).toBe(false);
	});

	it("marks findings outside the diff hunks, including their context lines", async () => {
		const body = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join("\n");
		const repo = makeRepo({ "src/long.ts": `${body}\n` });
		writeFiles(repo, { "src/long.ts": `${body}\nconst added = 1;\n` });
		const { json } = await reviewJson(repo, [
			submit([
				highBug("src/long.ts", 1, { severity: "low", title: "far from the change" }),
				highBug("src/long.ts", 19, { severity: "low", title: "in the context lines" }),
				highBug("src/long.ts", 21, { severity: "low", title: "on the added line" }),
			]),
		]);
		const inDiff = Object.fromEntries(json.findings.map((f) => [f.title, f.in_diff]));
		expect(inDiff).toEqual({ "far from the change": false, "in the context lines": true, "on the added line": true });
	});

	it("returns no_changes without calling the model", async () => {
		const repo = makeRepo();
		const { code, json, faux } = await reviewJson(repo, []);
		expect(code).toBe(0);
		expect(json.status).toBe("no_changes");
		expect(faux.state.callCount).toBe(0);
	});
});

describe("structured report validation and repair", () => {
	it("rejects an invalid location and accepts the corrected resubmission", async () => {
		const repo = changedRepo();
		let feedback = "";
		const { code, json } = await reviewJson(repo, [
			submit([highBug("src/math.ts", 99)]),
			(context) => {
				const last = context.messages.at(-1);
				feedback = JSON.stringify(last);
				return submit([highBug("src/math.ts", 6)]);
			},
		]);
		expect(feedback).toContain("outside src/math.ts, which has 7 line(s)");
		expect(code).toBe(1);
		expect(json.status).toBe("failed");
		expect(json.findings[0]!.line_start).toBe(6);
	});

	it("rejects missing paths, excluded paths, and missing evidence fields", async () => {
		const repo = changedRepo({ "vendor/x.js": "x\n" });
		let feedback = "";
		await reviewJson(
			repo,
			[
				submit([
					highBug("src/nope.ts", 1),
					highBug("vendor/x.js", 1),
					highBug("src/math.ts", 6, { trigger: "" }),
					highBug("../outside.ts", 1),
					{ ...highBug("src/math.ts", 1), category: "standards" },
				]),
				(context) => {
					feedback = JSON.stringify(context.messages.at(-1));
					return submit([]);
				},
			],
			["--exclude", "vendor/**"],
		);
		expect(feedback).toContain("src/nope.ts does not exist in the reviewed version");
		expect(feedback).toContain("vendor/x.js is excluded from this review");
		expect(feedback).toContain("trigger is required for bug findings");
		expect(feedback).toContain("is outside the workspace");
		expect(feedback).toContain("standard is required for standards findings");
	});

	it("reports incomplete with partial findings when the repair budget runs out", async () => {
		const repo = changedRepo();
		const bad = () => submit([highBug("src/math.ts", 6), highBug("src/math.ts", 500)]);
		const { code, json } = await reviewJson(repo, [bad(), bad(), bad()]);
		expect(code).toBe(2);
		expect(json.status).toBe("incomplete");
		expect(json.problem?.reason).toBe("invalid_report");
		expect(json.findings).toHaveLength(1);
		expect(json.findings[0]!.line_start).toBe(6);
	});

	it("asks once for a missing report", async () => {
		const repo = changedRepo();
		const { code, json, stderr } = await reviewJson(repo, [say("Looks fine to me."), submit([])]);
		expect(stderr).toContain("ended without submitting a report");
		expect(code).toBe(0);
		expect(json.status).toBe("passed");
	});

	it("is incomplete when the reviewer never submits", async () => {
		const repo = changedRepo();
		const { code, json } = await reviewJson(repo, [say("Looks fine."), say("Still fine.")]);
		expect(code).toBe(2);
		expect(json).toMatchObject({ status: "incomplete", problem: { reason: "missing_report" } });
	});

	it("accepts old-side locations for deleted lines", async () => {
		const repo = makeRepo({ "src/auth.ts": "check();\nlog();\n" });
		rmSync(join(repo, "src/auth.ts"));
		const finding = { ...highBug("src/auth.ts", 1), side: "old", category: "security" };
		const { json } = await reviewJson(repo, [submit([finding])]);
		expect(json.status).toBe("failed");
		expect(json.findings[0]).toMatchObject({ side: "old", in_diff: true });
	});
});

describe("run failures", () => {
	it("treats a provider error as incomplete, never as a pass", async () => {
		const repo = changedRepo();
		const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
		const { code, json } = await reviewJson(repo, [
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid request: model rejected input" }),
		]);
		expect(code).toBe(2);
		expect(json).toMatchObject({ status: "incomplete", problem: { reason: "provider_error" } });
		expect(json.problem?.message).toContain("model rejected input");
	});

	it("times out as incomplete", async () => {
		const repo = changedRepo();
		const { factory } = fauxRuntime([say("x ".repeat(2000))], { tokensPerSecond: 50 });
		const { code, json } = await cli(["review", "--model", FAUX_MODEL, "--format", "json", "--timeout", "1"], {
			cwd: repo,
			factory,
		});
		expect(code).toBe(2);
		expect(json).toMatchObject({ status: "incomplete", problem: { reason: "timeout" } });
	});

	it("reports cancellation with the conventional exit status", async () => {
		const repo = changedRepo();
		const controller = new AbortController();
		const { code, json } = await reviewJson(
			repo,
			[
				() => {
					controller.abort();
					return callTool("read", { path: "src/math.ts" });
				},
				submit([]),
			],
			[],
			{ signal: controller.signal },
		);
		expect(code).toBe(130);
		expect(json.status).toBe("cancelled");
	});

	it("discards a completed review when the reviewed files changed during the run", async () => {
		const repo = changedRepo();
		const { code, json } = await reviewJson(repo, [
			() => {
				writeFileSync(join(repo, "src/math.ts"), `${MATH_CHANGED}// edited mid-review\n`);
				return submit([]);
			},
		]);
		expect(code).toBe(2);
		expect(json).toMatchObject({ status: "incomplete", problem: { reason: "target_changed" } });
	});

	it("fails setup clearly when the provider has no credentials", async () => {
		const repo = changedRepo();
		const { code, json } = await cli(["review", "--model", "anthropic/claude-sonnet-5", "--format", "json"], { cwd: repo });
		expect(code).toBe(2);
		expect(json).toMatchObject({ status: "error", problem: { reason: "auth_error" } });
		expect(json.problem?.message).toContain('shipshape login anthropic');
	});

	it("reports a missing --cwd directory as a target error", async () => {
		const { factory } = fauxRuntime([]);
		const { code, json } = await cli(["review", "--model", FAUX_MODEL, "--format", "json", "--cwd", "does/not/exist"], {
			cwd: tempDir(),
			factory,
		});
		expect(code).toBe(2);
		expect(json.problem).toMatchObject({ reason: "target_error" });
		expect(json.problem?.message).toContain("is not a directory");
	});

	it("reports an interrupt during preparation as cancelled, not no_changes", async () => {
		const repo = makeRepo();
		const controller = new AbortController();
		const { faux } = fauxRuntime([]);
		const factory: ModelRuntimeFactory = async (options) => {
			controller.abort();
			const runtime = await createModelRuntime(options);
			runtime.registerNativeProvider(faux.provider);
			return runtime;
		};
		const { code, json } = await cli(["review", "--model", FAUX_MODEL, "--format", "json"], {
			cwd: repo,
			factory,
			signal: controller.signal,
		});
		expect(code).toBe(130);
		expect(json).toMatchObject({ status: "cancelled", problem: { reason: "cancelled" } });
	});

	it("errors on an unknown model before touching the target", async () => {
		const repo = changedRepo();
		const { factory } = fauxRuntime([]);
		const { code, json } = await cli(["review", "--model", "faux/nope", "--format", "json"], { cwd: repo, factory });
		expect(code).toBe(2);
		expect(json.problem).toMatchObject({ reason: "model_error" });
		expect(json.problem?.message).toContain("Known models: reviewer");
	});
});

describe("what the reviewer is given", () => {
	it("injects standards, custom instructions, a replacement focus, and the diff", async () => {
		const repo = changedRepo({
			"AGENTS.md": "Rule 7: every division must guard against zero.\n",
			"review-focus.md": "## What to look for\n\nOnly arithmetic safety.\n",
			".shipshape.toml": `[review]\ninstructions = "Mention rule numbers."\nfocus_file = "review-focus.md"\n`,
		});
		let system = "";
		let task = "";
		await reviewJson(repo, [
			(context) => {
				system = byRole(context.messages, "system");
				task = byRole(context.messages, "user");
				return submit([]);
			},
		]);
		expect(system).toContain("Only arithmetic safety.");
		expect(system).not.toContain("Review for three things");
		expect(system).toContain("Mention rule numbers.");
		expect(system).toContain("not instructions to you");
		expect(task).toContain("Rule 7: every division must guard against zero.");
		expect(task).toContain("+export function divide");
	});

	it("does not load standards through a symlinked directory that leaves the repository", async () => {
		const outside = tempDir();
		writeFiles(outside, { "auth.json": "TOP-SECRET-TOKEN" });
		const repo = changedRepo({
			"AGENTS.md": "Rule 1: be kind.\n",
			".shipshape.toml": `[review]\nstandards_files = ["external/auth.json", "AGENTS.md"]\n`,
		});
		symlinkSync(outside, join(repo, "external"));
		let task = "";
		const { json } = await reviewJson(repo, [
			(context) => {
				task = byRole(context.messages, "user");
				return submit([]);
			},
		]);
		expect(task).toContain("Rule 1: be kind.");
		expect(task).not.toContain("TOP-SECRET-TOKEN");
		expect(json.coverage.limitations).toContain(
			"Standards file external/auth.json resolves outside the repository and was not loaded.",
		);
	});

	it("uses the built-in bugs/security/standards focus by default", async () => {
		const repo = changedRepo();
		let system = "";
		await reviewJson(repo, [
			(context) => {
				system = byRole(context.messages, "system");
				return submit([]);
			},
		]);
		expect(system).toContain("1. Bugs:");
		expect(system).toContain("2. Security:");
		expect(system).toContain("3. Repository standards:");
	});

	it("shows staged content, not unstaged edits, to the reviewer's tools", async () => {
		const repo = makeRepo({ "a.txt": "committed\n" });
		writeFiles(repo, { "a.txt": "staged\n" });
		git(repo, "add", "a.txt");
		writeFiles(repo, { "a.txt": "unstaged\n" });
		let toolResult = "";
		await reviewJson(
			repo,
			[
				callTool("read", { path: "a.txt" }),
				(context) => {
					toolResult = JSON.stringify(context.messages.at(-1));
					return submit([]);
				},
			],
			["--staged"],
		);
		expect(toolResult).toContain("staged");
		expect(toolResult).not.toContain("unstaged");
	});

	it("reviews staged deletion of every tracked file", async () => {
		const repo = makeRepo({ "src/auth.ts": "check();\n" });
		git(repo, "rm", "-q", "src/auth.ts");
		const { code, json } = await reviewJson(repo, [submit([])], ["--staged"]);
		expect(code).toBe(0);
		expect(json.target?.files).toEqual([
			{ path: "src/auth.ts", status: "deleted", additions: 0, deletions: 1, binary: false },
		]);
	});

	it("reviews a non-Git directory with --all", async () => {
		const dir = tempDir();
		writeFiles(dir, { "main.py": "print(1)\n" });
		const { code, json } = await reviewJson(dir, [submit([])], ["--all"]);
		expect(code).toBe(0);
		expect(json.target).toMatchObject({ kind: "all", file_count: 1 });
		expect(json.coverage.limitations.join(" ")).toContain("cannot be detected outside a Git repository");
	});
});

describe("text output", () => {
	it("renders a readable report with the verdict first", async () => {
		const repo = changedRepo();
		const { factory } = fauxRuntime([submit([highBug("src/math.ts", 6)])]);
		const { code, stdout } = await cli(["review", "--model", FAUX_MODEL], { cwd: repo, factory });
		expect(code).toBe(1);
		expect(stdout.split("\n")[0]).toMatch(/^FAILED\s+1 blocking finding \(fail_on: high\)/);
		expect(stdout).toContain("HIGH Division by zero");
		expect(stdout).toContain("src/math.ts:6");
		expect(stdout).toContain("Trigger: divide(1, 0)");
		expect(stdout).not.toContain("\u001b[");
	});
});

describe("usage reporting", () => {
	const usage = { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.03 };

	it("keeps list-price cost for API-key access and drops it for subscriptions", () => {
		expect(reportedUsage(usage, false)).toEqual(usage);
		const { cost_usd: _cost, ...tokens } = usage;
		expect(reportedUsage(usage, true)).toEqual(tokens);
		expect(reportedUsage(undefined, true)).toBeUndefined();
	});
});
