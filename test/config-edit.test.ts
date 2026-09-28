import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setKey, unsetKey } from "../src/config/edit.js";
import { cli, makeRepo, tempDir } from "./helpers.js";

describe("TOML editing", () => {
	it("replaces a value in place, keeping comments, order, and a trailing comment", () => {
		const text = `# Ship Shape settings\nmodel = "a/b"   # team default\n\n[review]\n# strictness\nfail_on = "high"\ntimeout_seconds = 300\n`;
		expect(setKey(text, "review.fail_on", "medium")).toBe(
			`# Ship Shape settings\nmodel = "a/b"   # team default\n\n[review]\n# strictness\nfail_on = "medium"\ntimeout_seconds = 300\n`,
		);
		expect(setKey(text, "model", "x/y")).toContain(`model = "x/y"   # team default\n`);
	});

	it("adds keys to the right place", () => {
		const text = `# header comment\n[review]\nfail_on = "high"\n\n[other]\nx = 1\n`;
		expect(setKey(text, "review.timeout_seconds", 60)).toBe(
			`# header comment\n[review]\nfail_on = "high"\ntimeout_seconds = 60\n\n[other]\nx = 1\n`,
		);
		expect(setKey(text, "model", "a/b")).toBe(`# header comment\nmodel = "a/b"\n\n[review]\nfail_on = "high"\n\n[other]\nx = 1\n`);
		expect(setKey(`model = "a/b"\n`, "review.fail_on", "low")).toBe(`model = "a/b"\n\n[review]\nfail_on = "low"\n`);
		expect(setKey("", "model", "a/b")).toBe(`model = "a/b"\n`);
	});

	it("handles dotted keys, quoted keys, and multi-line arrays", () => {
		expect(setKey(`review.fail_on = "low"\n`, "review.exclude", ["a"])).toBe(`review.fail_on = "low"\nreview.exclude = [ "a" ]\n`);
		expect(setKey(`[ "review" ]\n"fail_on" = "low"\n`, "review.fail_on", "high")).toBe(`[ "review" ]\n"fail_on" = "high"\n`);
		const multi = `[review]\nexclude = [\n  "vendor/**", # third party\n  "dist/**",\n]\nfail_on = "low"\n`;
		expect(setKey(multi, "review.exclude", [])).toBe(`[review]\nexclude = []\nfail_on = "low"\n`);
		expect(unsetKey(multi, "review.exclude")).toBe(`[review]\nfail_on = "low"\n`);
	});

	it("keeps Windows line endings", () => {
		expect(setKey(`[review]\r\nfail_on = "high"\r\n`, "review.fail_on", "low")).toBe(`[review]\r\nfail_on = "low"\r\n`);
	});

	it("reports an absent key on unset", () => {
		expect(unsetKey(`model = "a/b"\n`, "review.fail_on")).toBeUndefined();
	});
});

function setup() {
	const home = tempDir("shipshape-set-");
	const env = { XDG_CONFIG_HOME: join(home, "xdg") };
	const globalFile = join(home, "xdg", "shipshape", "config.toml");
	return { home, env, globalFile };
}

describe("shipshape config set / unset", () => {
	it("creates the global config and makes the value effective", async () => {
		const { home, env, globalFile } = setup();
		const set = await cli(["config", "set", "model", "openai-codex/gpt-6-astra", "--global"], { cwd: home, env });
		expect(set.code).toBe(0);
		expect(set.stdout).toBe(`Set model = "openai-codex/gpt-6-astra" in ${globalFile}\n`);
		expect(readFileSync(globalFile, "utf8")).toBe(`model = "openai-codex/gpt-6-astra"\n`);
		const show = await cli(["config", "show", "--sources"], { cwd: home, env });
		expect(show.stdout).toMatch(/^model = "openai-codex\/gpt-6-astra"\s+# global: /m);
	});

	it("writes the project file at the repository root, from any subdirectory", async () => {
		const repo = makeRepo({ "src/index.ts": "export {};\n" });
		const run = await cli(["config", "set", "review.exclude", "vendor/**", "*.lock", "--project"], {
			cwd: join(repo, "src"),
			env: setup().env,
		});
		expect(run.code).toBe(0);
		expect(readFileSync(join(repo, ".shipshape.toml"), "utf8")).toBe(`[review]\nexclude = [ "vendor/**", "*.lock" ]\n`);
	});

	it("parses values by setting type", async () => {
		const { home, env, globalFile } = setup();
		await cli(["config", "set", "review.timeout_seconds", "90", "--global"], { cwd: home, env });
		await cli(["config", "set", "review.standards_files", "[]", "--global"], { cwd: home, env });
		await cli(["config", "set", "review.instructions", "--global", "--", "-be strict"], { cwd: home, env });
		expect(readFileSync(globalFile, "utf8")).toBe(
			`[review]\ntimeout_seconds = 90\nstandards_files = []\ninstructions = "-be strict"\n`,
		);
	});

	it("rejects invalid values without touching the file", async () => {
		const { home, env, globalFile } = setup();
		mkdirSync(join(home, "xdg", "shipshape"), { recursive: true });
		writeFileSync(globalFile, `# mine\n[review]\nfail_on = "high"\n`);
		const bad = await cli(["config", "set", "review.fail_on", "severe", "--global"], { cwd: home, env });
		expect(bad.code).toBe(2);
		expect(bad.stderr).toContain(`review.fail_on: expected one of critical, high, medium, low; got "severe"`);
		const notInt = await cli(["config", "set", "review.timeout_seconds", "soon", "--global"], { cwd: home, env });
		expect(notInt.stderr).toContain("expected a whole number of seconds");
		const tooMany = await cli(["config", "set", "model", "a/b", "c/d", "--global"], { cwd: home, env });
		expect(tooMany.stderr).toContain("model: expected exactly one value; got 2");
		expect(readFileSync(globalFile, "utf8")).toBe(`# mine\n[review]\nfail_on = "high"\n`);
	});

	it("enforces layer rules and requires a scope", async () => {
		const repo = makeRepo();
		const { env } = setup();
		const projectAuth = await cli(["config", "set", "auth_file", "creds.json", "--project"], { cwd: repo, env });
		expect(projectAuth.code).toBe(2);
		expect(projectAuth.stderr).toContain('"auth_file" cannot be set in project configuration; use the global config instead.');
		expect(existsSync(join(repo, ".shipshape.toml"))).toBe(false);

		const noScope = await cli(["config", "set", "model", "a/b"], { cwd: repo, env });
		expect(noScope.code).toBe(2);
		expect(noScope.stderr).toContain("Choose where to set the value: --global");
		const unknown = await cli(["config", "set", "modle", "a/b", "--global"], { cwd: repo, env });
		expect(unknown.stderr).toContain('unknown setting "modle"');
	});

	it("keeps project files inside the repository", async () => {
		const repo = makeRepo();
		const run = await cli(["config", "set", "review.standards_files", "../secrets.txt", "--project"], { cwd: repo, env: setup().env });
		expect(run.code).toBe(2);
		expect(run.stderr).toContain("expected paths inside the repository");
	});

	it("notes when a higher-precedence layer decides the effective value", async () => {
		const repo = makeRepo({ ".shipshape.toml": `model = "anthropic/team-model"\n` });
		const { env } = setup();
		const run = await cli(["config", "set", "model", "openai/mine", "--global"], { cwd: repo, env });
		expect(run.code).toBe(0);
		expect(run.stderr).toContain('Note: the effective model is "anthropic/team-model", from project:');
	});

	it("unsets a key so it inherits again, preserving the file's mode", async () => {
		const repo = makeRepo({ ".shipshape.toml": `# keep me\n[review]\nfail_on = "low"\n` });
		chmodSync(join(repo, ".shipshape.toml"), 0o640);
		const { env } = setup();
		const run = await cli(["config", "unset", "review.fail_on", "--project"], { cwd: repo, env });
		expect(run.stdout).toContain("Removed review.fail_on from");
		expect(run.stderr).toContain('review.fail_on now resolves to "high" (default)');
		expect(readFileSync(join(repo, ".shipshape.toml"), "utf8")).toBe(`# keep me\n[review]\n`);
		expect(statSync(join(repo, ".shipshape.toml")).mode & 0o777).toBe(0o640);

		const again = await cli(["config", "unset", "review.fail_on", "--project"], { cwd: repo, env });
		expect(again.code).toBe(0);
		expect(again.stdout).toContain("review.fail_on is not set in");
	});

	it("explains that inline tables cannot be edited instead of misreporting or crashing", async () => {
		const repo = makeRepo({ ".shipshape.toml": `review = { fail_on = "low" }\n` });
		const { env } = setup();
		for (const argv of [
			["config", "unset", "review.fail_on", "--project"],
			["config", "set", "review.fail_on", "high", "--project"],
		]) {
			const run = await cli(argv, { cwd: repo, env });
			expect(run.code).toBe(2);
			expect(run.stderr).toContain("review is written as an inline table (review = { ... }), which shipshape config cannot edit");
		}
		expect(readFileSync(join(repo, ".shipshape.toml"), "utf8")).toBe(`review = { fail_on = "low" }\n`);
		// Top-level keys in the same file are still editable.
		expect((await cli(["config", "set", "model", "a/b", "--project"], { cwd: repo, env })).code).toBe(0);
	});

	it("refuses to edit a file that is not valid TOML", async () => {
		const repo = makeRepo({ ".shipshape.toml": `[review\n` });
		const run = await cli(["config", "set", "review.fail_on", "low", "--project"], { cwd: repo, env: setup().env });
		expect(run.code).toBe(2);
		expect(run.stderr).toContain("is not valid TOML");
		expect(readFileSync(join(repo, ".shipshape.toml"), "utf8")).toBe(`[review\n`);
	});
});
