import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeGitHub, fakeGitHub, hostTarget, publish, releaseArchive } from "./fake-github.js";
import { tempDir } from "./helpers.js";

const INSTALL_SH = resolve(import.meta.dirname, "../install.sh");
const ASSET = `shipshape-${hostTarget()}.tar.gz`;

const opened: FakeGitHub[] = [];
afterEach(async () => {
	await Promise.all(opened.splice(0).map((github) => github.close()));
});

async function startGitHub(): Promise<FakeGitHub> {
	const github = await fakeGitHub();
	opened.push(github);
	return github;
}

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run install.sh the documented way (`… | sh`) with a clean environment and a throwaway HOME. */
function install(github: FakeGitHub, home: string, env: Record<string, string> = {}): Promise<Run> {
	return new Promise((done) => {
		const child = execFile(
			"sh",
			[],
			{
				env: {
					PATH: "/usr/local/bin:/usr/bin:/bin",
					HOME: home,
					SHELL: "/bin/bash",
					SHIPSHAPE_RELEASES_URL: github.url,
					...env,
				},
			},
			(error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, stdout, stderr }),
		);
		child.stdin!.end(readFileSync(INSTALL_SH));
	});
}

function installed(home: string): string {
	return join(home, ".local/bin/shipshape");
}

function run(binary: string): Promise<string> {
	return new Promise((done, fail) => execFile(binary, ["--version"], (error, stdout) => (error ? fail(error) : done(stdout.trim()))));
}

describe.skipIf(process.platform === "win32")("install.sh", () => {
	it("installs the latest release and puts it on PATH once", async () => {
		const github = await startGitHub();
		publish(github, "v0.2.0", ASSET, releaseArchive(ASSET, "0.2.0"));
		const home = tempDir("shipshape-home-");
		const first = await install(github, home);
		expect(first.code).toBe(0);
		expect(first.stdout).toContain(`Installed shipshape 0.2.0 to ${installed(home)}`);
		expect(await run(installed(home))).toBe("0.2.0");

		const rc = join(home, process.platform === "darwin" ? ".bash_profile" : ".bashrc");
		expect(readFileSync(rc, "utf8")).toContain('export PATH="$HOME/.local/bin:$PATH"');
		await install(github, home);
		expect(readFileSync(rc, "utf8").match(/Added by the Ship Shape installer/g)).toHaveLength(1);
	});

	it("installs a pinned version and honors the install directory and PATH opt-out", async () => {
		const github = await startGitHub();
		publish(github, "v0.1.0", ASSET, releaseArchive(ASSET, "0.1.0"));
		publish(github, "v0.2.0", ASSET, releaseArchive(ASSET, "0.2.0"));
		const home = tempDir("shipshape-home-");
		const dir = join(home, "tools");
		const result = await install(github, home, { SHIPSHAPE_VERSION: "0.1.0", SHIPSHAPE_INSTALL_DIR: dir, SHIPSHAPE_NO_MODIFY_PATH: "1" });
		expect(result.code).toBe(0);
		expect(await run(join(dir, "shipshape"))).toBe("0.1.0");
		expect(result.stdout).toContain(`Add ${dir} to your PATH`);
		expect(existsSync(join(home, ".bashrc"))).toBe(false);
	});

	it.each([
		["a binary that fails to run", "exit 3", /does not run on this system/],
		["a binary that prints no version", "true", /did not report a version/],
	])("refuses %s and keeps the existing install", async (_case, script, message) => {
		const github = await startGitHub();
		publish(github, "v0.2.0", ASSET, releaseArchive(ASSET, "0.2.0", script));
		const home = tempDir("shipshape-home-");
		mkdirSync(join(home, ".local/bin"), { recursive: true });
		writeFileSync(installed(home), "#!/bin/sh\necho 0.1.0\n");
		chmodSync(installed(home), 0o755);

		const result = await install(github, home);
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(message);
		expect(await run(installed(home))).toBe("0.1.0");
	});

	it.skipIf(process.getuid?.() === 0)("fails cleanly when the install directory is not writable", async () => {
		const github = await startGitHub();
		publish(github, "v0.2.0", ASSET, releaseArchive(ASSET, "0.2.0"));
		const home = tempDir("shipshape-home-");
		const dir = join(home, ".local/bin");
		mkdirSync(dir, { recursive: true });
		writeFileSync(installed(home), "#!/bin/sh\necho 0.1.0\n");
		chmodSync(installed(home), 0o755);
		chmodSync(dir, 0o555);
		try {
			const result = await install(github, home);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`Could not write to ${dir}; the existing install, if any, was not changed.`);
			expect(await run(installed(home))).toBe("0.1.0");
			expect(readdirSync(dir)).toEqual(["shipshape"]);
		} finally {
			chmodSync(dir, 0o755);
		}
	});

	it("refuses a checksum mismatch or a missing release", async () => {
		const github = await startGitHub();
		const home = tempDir("shipshape-home-");
		const missing = await install(github, home);
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("Download failed");

		publish(github, "v0.2.0", ASSET, releaseArchive(ASSET, "0.2.0"), Buffer.from("tampered"));
		const tampered = await install(github, home);
		expect(tampered.code).toBe(1);
		expect(tampered.stderr).toContain("Checksum mismatch");
		expect(existsSync(installed(home))).toBe(false);
	});
});
