import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/cli/args.js";
import { globalConfigDir } from "../src/config/paths.js";
import { ConfigError, loadConfig } from "../src/config/resolve.js";
import { tempDir } from "./helpers.js";

function setup(files: { global?: string; project?: string }) {
	const home = tempDir("shipshape-cfg-");
	const env = { ...process.env, XDG_CONFIG_HOME: join(home, "xdg") };
	const project = join(home, "project");
	mkdirSync(project, { recursive: true });
	if (files.global !== undefined) {
		mkdirSync(globalConfigDir(env), { recursive: true });
		writeFileSync(join(globalConfigDir(env), "config.toml"), files.global);
	}
	if (files.project !== undefined) writeFileSync(join(project, ".shipshape.toml"), files.project);
	return { home, env, project };
}

function cliSettings(...argv: string[]) {
	const command = parseCommand(["review", ...argv]);
	if (command.name !== "review") throw new Error("expected review");
	return command.settings;
}

describe("configuration precedence", () => {
	it("resolves each leaf independently: CLI > project > global > default", async () => {
		const { env, project } = setup({
			global: `model = "anthropic/some-model"\nformat = "text"\n[review]\nfail_on = "high"\ntimeout_seconds = 300\n`,
			project: `[review]\nfail_on = "medium"\nexclude = ["vendor/**", "generated/**"]\n`,
		});
		const { config, sources } = await loadConfig({
			cli: cliSettings("--format", "json"),
			invocationDir: project,
			projectRoot: project,
			env,
		});
		expect(config.model).toBe("anthropic/some-model");
		expect(config.review.timeout_seconds).toBe(300);
		expect(config.review.fail_on).toBe("medium");
		expect(config.review.exclude).toEqual(["vendor/**", "generated/**"]);
		expect(config.format).toBe("json");
		expect(config.thinking).toBe("medium");
		expect(sources.model.kind).toBe("global");
		expect(sources["review.fail_on"]).toEqual({ kind: "project", path: join(project, ".shipshape.toml") });
		expect(sources.format.kind).toBe("cli");
		expect(sources.thinking.kind).toBe("default");
	});

	it("replaces lists instead of merging, and an empty list clears an inherited one", async () => {
		const { env, project } = setup({
			global: `[review]\nexclude = ["dist/**"]\nstandards_files = ["STYLE.md"]\n`,
			project: `[review]\nstandards_files = []\n`,
		});
		const { config } = await loadConfig({ cli: cliSettings("--exclude", "a/**", "--exclude", "b/**"), invocationDir: project, projectRoot: project, env });
		expect(config.review.exclude).toEqual(["a/**", "b/**"]);
		expect(config.review.standards_files).toEqual([]);
	});

	it("treats explicit zero and empty strings as values, not as missing", async () => {
		const { env, project } = setup({
			global: `[review]\ntimeout_seconds = 300\ninstructions = "Be strict about SQL."\n`,
			project: `[review]\ntimeout_seconds = 0\ninstructions = ""\n`,
		});
		const { config } = await loadConfig({ cli: new Map(), invocationDir: project, projectRoot: project, env });
		expect(config.review.timeout_seconds).toBe(0);
		expect(config.review.instructions).toBe("");
	});

	it("uses --config as a replacement for the project file", async () => {
		const { env, project, home } = setup({ project: `[review]\nfail_on = "low"\n` });
		const trusted = join(home, "trusted.toml");
		writeFileSync(trusted, `[review]\nfail_on = "critical"\n`);
		const { config, sources } = await loadConfig({
			cli: new Map(),
			invocationDir: project,
			projectRoot: project,
			projectConfigOverride: trusted,
			env,
		});
		expect(config.review.fail_on).toBe("critical");
		expect(sources["review.fail_on"].path).toBe(trusted);
	});

	it("errors when an explicitly selected --config file is missing", async () => {
		const { env, project } = setup({});
		await expect(
			loadConfig({ cli: new Map(), invocationDir: project, projectRoot: project, projectConfigOverride: join(project, "nope.toml"), env }),
		).rejects.toThrow(/nope\.toml: cannot read configuration/);
	});

	it("resolves paths relative to the file that declares them, and CLI paths to the invocation directory", async () => {
		const { env, project, home } = setup({ project: `[review]\nfocus_file = "review/focus.md"\n` });
		mkdirSync(join(project, "review"));
		writeFileSync(join(project, "review/focus.md"), "focus");
		const fromFile = await loadConfig({ cli: new Map(), invocationDir: home, projectRoot: project, env });
		expect(fromFile.config.review.focus_file).toBe(join(project, "review/focus.md"));
		const fromCli = await loadConfig({ cli: cliSettings("--focus-file", "f.md"), invocationDir: home, projectRoot: project, env });
		expect(fromCli.config.review.focus_file).toBe(join(home, "f.md"));
	});

	it("rejects auth_file in project configuration", async () => {
		const { env, project } = setup({ project: `auth_file = "./creds.json"\n` });
		await expect(loadConfig({ cli: new Map(), invocationDir: project, projectRoot: project, env })).rejects.toThrow(
			/"auth_file" cannot be set in project configuration/,
		);
	});

	it("accepts auth_file from global config with ~ expansion", async () => {
		const { env, project } = setup({ global: `auth_file = "~/.pi/agent/auth.json"\n` });
		const { config } = await loadConfig({ cli: new Map(), invocationDir: project, projectRoot: project, env });
		expect(config.auth_file).toMatch(/\.pi\/agent\/auth\.json$/);
		expect(config.auth_file.startsWith("~")).toBe(false);
	});

	it("reports every problem with its file and key", async () => {
		const { env, project } = setup({
			global: `modle = "x/y"\n[review]\nfail_on = "severe"\ntimeout_seconds = -1\n`,
			project: `model = "no-provider"\n`,
		});
		const error = await loadConfig({ cli: cliSettings("--timeout", "soon"), invocationDir: project, projectRoot: project, env }).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(ConfigError);
		const problems = (error as ConfigError).problems.join("\n");
		expect(problems).toMatch(/--timeout: expected a whole number/);
		expect(problems).toMatch(/\.shipshape\.toml: model: expected a provider-qualified model/);
		expect(problems).toMatch(/config\.toml: unknown setting "modle"/);
		expect(problems).toMatch(/review\.fail_on: expected one of critical, high, medium, low; got "severe"/);
		expect(problems).toMatch(/review\.timeout_seconds: expected a whole number of seconds from 0 to \d+; got -1/);
	});

	it("reports TOML syntax errors with a location", async () => {
		const { env, project } = setup({ project: `[review\nfail_on = "high"\n` });
		await expect(loadConfig({ cli: new Map(), invocationDir: project, projectRoot: project, env })).rejects.toThrow(
			/\.shipshape\.toml: invalid TOML at line 1/,
		);
	});

	it("does not mask configured values with parser defaults", () => {
		expect(cliSettings().size).toBe(0);
		expect(cliSettings("--staged").size).toBe(0);
	});
});

describe("command parsing", () => {
	it("selects the review target", () => {
		expect(parseCommand(["review"])).toMatchObject({ name: "review", kind: "worktree" });
		expect(parseCommand(["review", "--staged"])).toMatchObject({ kind: "staged" });
		expect(parseCommand(["review", "--base", "main"])).toMatchObject({ kind: "branch", base: "main" });
		expect(parseCommand(["review", "--base", "a", "--head", "b"])).toMatchObject({ kind: "branch", base: "a", head: "b" });
		expect(parseCommand(["review", "--all"])).toMatchObject({ kind: "all" });
	});

	it("rejects conflicting or incomplete target flags", () => {
		expect(() => parseCommand(["review", "--staged", "--base", "main"])).toThrow(/cannot be combined/);
		expect(() => parseCommand(["review", "--head", "x"])).toThrow(/--head requires --base/);
		expect(() => parseCommand(["review", "--bogus"])).toThrow(/Unknown option/);
		expect(() => parseCommand(["reveiw"])).toThrow(/Unknown command/);
	});
});

describe("repository-controlled configuration", () => {
	it("keeps standards files inside the repository", async () => {
		const { env, project } = setup({ project: `[review]\nstandards_files = ["../../home/user/.ssh/id_rsa"]\n` });
		await expect(loadConfig({ cli: new Map(), invocationDir: project, projectRoot: project, env })).rejects.toThrow(
			/standards_files: expected paths inside the repository/,
		);
	});

	it("refuses a discovered project focus file that resolves outside the project, including via symlink", async () => {
		const { symlinkSync } = await import("node:fs");
		const outside = setup({ project: `[review]\nfocus_file = "../secret.txt"\n` });
		writeFileSync(join(outside.home, "secret.txt"), "secret");
		await expect(
			loadConfig({ cli: new Map(), invocationDir: outside.project, projectRoot: outside.project, env: outside.env }),
		).rejects.toThrow(/focus_file: .* resolves outside the project/);

		const linked = setup({ project: `[review]\nfocus_file = "focus.md"\n` });
		writeFileSync(join(linked.home, "secret.txt"), "secret");
		symlinkSync(join(linked.home, "secret.txt"), join(linked.project, "focus.md"));
		await expect(
			loadConfig({ cli: new Map(), invocationDir: linked.project, projectRoot: linked.project, env: linked.env }),
		).rejects.toThrow(/resolves outside the project/);
	});

	it("lets an explicit --config file point anywhere", async () => {
		const { env, project, home } = setup({});
		writeFileSync(join(home, "focus.md"), "focus");
		mkdirSync(join(home, "ci"));
		writeFileSync(join(home, "ci", "trusted.toml"), `[review]\nfocus_file = "../focus.md"\n`);
		const { config } = await loadConfig({
			cli: new Map(),
			invocationDir: project,
			projectRoot: project,
			projectConfigOverride: join(home, "ci", "trusted.toml"),
			env,
		});
		expect(config.review.focus_file).toBe(join(home, "focus.md"));
	});

	it("bounds the timeout to what timers can represent", async () => {
		const { env, project } = setup({ project: `[review]\ntimeout_seconds = 3000000\n` });
		await expect(loadConfig({ cli: new Map(), invocationDir: project, projectRoot: project, env })).rejects.toThrow(
			/timeout_seconds: expected a whole number of seconds from 0 to 2147483/,
		);
	});
});
