import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareVersions, parseChecksums, runUpdate } from "../src/update.js";
import { type FakeGitHub, fakeGitHub, publish, releaseArchive } from "./fake-github.js";
import { cli, tempDir } from "./helpers.js";

const TARGET = "linux-x64";
const ASSET = "shipshape-linux-x64.tar.gz";

describe("compareVersions", () => {
	it("orders versions by semver precedence", () => {
		const ordered = ["0.1.0-alpha", "0.1.0-alpha.1", "0.1.0-alpha.beta", "0.1.0-beta.2", "0.1.0-beta.11", "0.1.0-rc.1", "0.1.0", "0.1.1", "0.2.0", "1.0.0"];
		for (let i = 0; i < ordered.length - 1; i++) {
			expect(compareVersions(ordered[i]!, ordered[i + 1]!)).toBeLessThan(0);
			expect(compareVersions(ordered[i + 1]!, ordered[i]!)).toBeGreaterThan(0);
		}
		expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
		expect(compareVersions("1.2.3+build.5", "1.2.3")).toBe(0);
		expect(() => compareVersions("latest", "1.0.0")).toThrow(/Cannot compare/);
	});

	it("parses sha256sum output", () => {
		const hash = "a".repeat(64);
		expect(parseChecksums(`${hash}  ${ASSET}\n${"B".repeat(64)} *shipshape-windows-x64.zip\ngarbage\n`)).toEqual(
			new Map([
				[ASSET, hash],
				["shipshape-windows-x64.zip", "b".repeat(64)],
			]),
		);
	});
});

const opened: FakeGitHub[] = [];
afterEach(async () => {
	await Promise.all(opened.splice(0).map((github) => github.close()));
});

async function startGitHub(): Promise<FakeGitHub> {
	const server = await fakeGitHub();
	opened.push(server);
	return server;
}

const archiveReporting = (version: string) => releaseArchive(ASSET, version);
const release = (server: FakeGitHub, tag: string, archive: Buffer, sums?: Buffer) => publish(server, tag, ASSET, archive, sums);

/** An installed release binary at bin/shipshape. */
function installed(version: string): string {
	const dir = join(tempDir("shipshape-install-"), "bin");
	mkdirSync(dir);
	const path = join(dir, "shipshape");
	writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
	chmodSync(path, 0o755);
	return path;
}

function options(github: FakeGitHub, executable: string, overrides: Partial<Parameters<typeof runUpdate>[0]> = {}) {
	return { checkOnly: false, currentVersion: "0.1.0", target: TARGET, executable, releasesUrl: github.url, ...overrides };
}

describe.skipIf(process.platform === "win32")("self-update", () => {
	it("replaces the installed binary with a verified newer release", async () => {
		const github = await startGitHub();
		release(github, "v0.2.0", archiveReporting("0.2.0"));
		const binary = installed("0.1.0");
		const outcome = await runUpdate(options(github, binary));
		expect(outcome).toEqual({ status: "updated", current: "0.1.0", latest: "0.2.0", path: binary });
		expect(execFileSync(binary, { encoding: "utf8" }).trim()).toBe("0.2.0");
		expect(statSync(binary).mode & 0o111).not.toBe(0);
		expect(readdirSync(join(binary, ".."))).toEqual(["shipshape"]); // no staged leftovers
	});

	it("updates the real file behind a symlinked install", async () => {
		const github = await startGitHub();
		release(github, "v0.2.0", archiveReporting("0.2.0"));
		const real = installed("0.1.0");
		const link = join(tempDir(), "shipshape");
		symlinkSync(real, link);
		const outcome = await runUpdate(options(github, link));
		expect(outcome).toMatchObject({ status: "updated", path: real });
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(execFileSync(link, { encoding: "utf8" }).trim()).toBe("0.2.0");
	});

	it("reports without installing when only checking or already current", async () => {
		const github = await startGitHub();
		release(github, "v0.2.0", archiveReporting("0.2.0"));
		const binary = installed("0.1.0");
		expect(await runUpdate(options(github, binary, { checkOnly: true }))).toEqual({ status: "available", current: "0.1.0", latest: "0.2.0" });
		expect(await runUpdate(options(github, binary, { currentVersion: "0.2.0" }))).toMatchObject({ status: "up_to_date" });
		expect(await runUpdate(options(github, binary, { currentVersion: "0.3.0-rc.1" }))).toMatchObject({ status: "up_to_date" });
		expect(execFileSync(binary, { encoding: "utf8" }).trim()).toBe("0.1.0");
	});

	it.each([
		["a checksum mismatch", (github: FakeGitHub) => release(github, "v0.2.0", archiveReporting("0.2.0"), Buffer.from("tampered")), /Checksum mismatch/],
		["a binary that fails after printing the right version", (github: FakeGitHub) => release(github, "v0.2.0", releaseArchive(ASSET, "0.2.0", "echo 0.2.0; exit 3")), /exited with code 3 during its version check/],
		["a binary reporting the wrong version", (github: FakeGitHub) => release(github, "v0.2.0", archiveReporting("0.1.9")), /reports version "0.1.9", expected "0.2.0"/],
		["no asset for this platform", (github: FakeGitHub) => {
			release(github, "v0.2.0", archiveReporting("0.2.0"));
			github.files.set("v0.2.0/SHA256SUMS", Buffer.from(`${"c".repeat(64)}  shipshape-darwin-arm64.tar.gz\n`));
		}, /has no shipshape-linux-x64.tar.gz/],
		["a repository with no releases", () => {}, /No published release found/],
	])("refuses %s and leaves the installed binary alone", async (_case, setup, message) => {
		const github = await startGitHub();
		setup(github);
		const binary = installed("0.1.0");
		await expect(runUpdate(options(github, binary))).rejects.toThrow(message);
		expect(execFileSync(binary, { encoding: "utf8" }).trim()).toBe("0.1.0");
		expect(readdirSync(join(binary, ".."))).toEqual(["shipshape"]);
	});

	it.skipIf(process.getuid?.() === 0)("explains a directory it cannot write to", async () => {
		const github = await startGitHub();
		release(github, "v0.2.0", archiveReporting("0.2.0"));
		const binary = installed("0.1.0");
		chmodSync(join(binary, ".."), 0o555);
		try {
			await expect(runUpdate(options(github, binary))).rejects.toThrow(/No permission to replace the binary/);
		} finally {
			chmodSync(join(binary, ".."), 0o755);
		}
	});

	it("maps outcomes to exit codes on the command line", async () => {
		const github = await startGitHub();
		release(github, "v0.2.0", archiveReporting("0.2.0"));
		const binary = installed("0.1.0");
		const context = { version: "0.1.0", buildTarget: TARGET, executable: binary };
		const env = { SHIPSHAPE_RELEASES_URL: github.url };
		const check = await cli(["update", "--check"], { cwd: tempDir(), env, context });
		expect(check.code).toBe(1);
		expect(check.stdout).toBe('shipshape 0.2.0 is available (installed: 0.1.0). Run "shipshape update" to install it.\n');
		const update = await cli(["update"], { cwd: tempDir(), env, context });
		expect(update.code).toBe(0);
		expect(update.stdout).toBe(`Updated shipshape 0.1.0 -> 0.2.0 at ${binary}\n`);
		const again = await cli(["update"], { cwd: tempDir(), env, context: { ...context, version: "0.2.0" } });
		expect(again.stdout).toBe("shipshape 0.2.0 is up to date.\n");
	});

	it("refuses to update a copy run from source", async () => {
		const { code, stderr } = await cli(["update"], { cwd: tempDir(), context: { buildTarget: undefined } });
		expect(code).toBe(2);
		expect(stderr).toContain("runs from source, so it cannot update itself");
	});
});
