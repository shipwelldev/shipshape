import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModelRuntime, ensureAuth } from "../src/runtime/pi.js";
import { cli, fauxRuntime, makeRepo, tempDir } from "./helpers.js";

afterEach(() => {
	delete process.env.ANTHROPIC_API_KEY;
});

describe("login and logout", () => {
	it("stores an API key in the configured auth file and removes it again", async () => {
		const dir = tempDir();
		const authFile = join(dir, "nested", "auth.json");
		const login = await cli(["login", "anthropic", "--auth-file", authFile], {
			cwd: dir,
			interactive: true,
			answers: ["api_key", "sk-ant-test-key"],
		});
		expect(login.stderr).toContain(`Saved API key credentials for anthropic to ${authFile}`);
		expect(login.code).toBe(0);
		expect(JSON.parse(readFileSync(authFile, "utf8"))).toMatchObject({ anthropic: { type: "api_key", key: "sk-ant-test-key" } });
		expect(statSync(authFile).mode & 0o077).toBe(0);

		const runtime = await createModelRuntime({ authFile });
		await expect(ensureAuth(runtime, "anthropic", authFile)).resolves.toEqual({ subscription: false });

		const logout = await cli(["logout", "anthropic", "--auth-file", authFile], { cwd: dir });
		expect(logout.code).toBe(0);
		expect(JSON.parse(readFileSync(authFile, "utf8"))).not.toHaveProperty("anthropic");
	});

	it("uses the global config's auth_file, e.g. an existing Pi auth.json", async () => {
		const dir = tempDir();
		const xdg = join(dir, "xdg");
		const piAuth = join(dir, "pi-agent", "auth.json");
		mkdirSync(join(xdg, "shipshape"), { recursive: true });
		mkdirSync(join(dir, "pi-agent"));
		writeFileSync(piAuth, JSON.stringify({ openai: { type: "api_key", key: "sk-openai" } }));
		writeFileSync(join(xdg, "shipshape", "config.toml"), `auth_file = ${JSON.stringify(piAuth)}\n`);
		const logout = await cli(["logout", "openai"], { cwd: dir, env: { XDG_CONFIG_HOME: xdg } });
		expect(logout.stderr).toContain(`Removed credentials for openai from ${piAuth}`);
	});

	it("refuses to prompt without a terminal", async () => {
		const { code, stderr } = await cli(["login", "anthropic"], { cwd: tempDir() });
		expect(code).toBe(2);
		expect(stderr).toContain("needs an interactive terminal");
	});
});

describe("credentials during review", () => {
	it("accepts provider environment variables with no auth file", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
		const authFile = join(tempDir(), "missing", "auth.json");
		const runtime = await createModelRuntime({ authFile });
		await expect(ensureAuth(runtime, "anthropic", authFile)).resolves.toEqual({ subscription: false });
		expect(existsSync(authFile)).toBe(false);
	});

	it("recognizes a subscription sign-in from a stored OAuth credential", async () => {
		const { faux } = fauxRuntime([]);
		const authFile = join(tempDir(), "auth.json");
		writeFileSync(authFile, JSON.stringify({ faux: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 86_400_000 } }));
		const runtime = await createModelRuntime({ authFile });
		runtime.registerNativeProvider({
			...faux.provider,
			auth: {
				oauth: {
					name: "Faux subscription",
					isSubscription: true,
					login: async () => {
						throw new Error("not used");
					},
					refresh: async (credential) => credential,
					toAuth: async () => ({}),
				},
			},
		});
		await expect(ensureAuth(runtime, "faux", authFile)).resolves.toEqual({ subscription: true });
	});

	it("never creates the auth file as a side effect of a review", async () => {
		const repo = makeRepo();
		const authFile = join(tempDir(), "auth.json");
		await cli(["review", "--model", "anthropic/claude-sonnet-5", "--auth-file", authFile], { cwd: repo });
		expect(existsSync(authFile)).toBe(false);
	});
});

describe("config show", () => {
	it("prints effective values with their sources", async () => {
		const repo = makeRepo({ ".shipshape.toml": `model = "anthropic/some-model"\n[review]\nexclude = ["dist/**"]\n` });
		const { code, stdout } = await cli(["config", "show", "--sources", "--fail-on", "low"], { cwd: repo });
		expect(code).toBe(0);
		expect(stdout).toMatch(/^model = "anthropic\/some-model"\s+# project: .*\.shipshape\.toml$/m);
		expect(stdout).toMatch(/^fail_on = "low"\s+# command line$/m);
		expect(stdout).toMatch(/^exclude = \["dist\/\*\*"\]\s+# project: /m);
		expect(stdout).toMatch(/^thinking = "medium"\s+# default$/m);
	});

	it("exits 2 with an actionable message on invalid configuration", async () => {
		const repo = makeRepo({ ".shipshape.toml": `[review]\nfail_on = 3\n` });
		const { code, stderr } = await cli(["config", "show"], { cwd: repo });
		expect(code).toBe(2);
		expect(stderr).toContain("review.fail_on: expected one of critical, high, medium, low; got 3");
	});
});
