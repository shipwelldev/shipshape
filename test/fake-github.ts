import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tempDir } from "./helpers.js";

export interface FakeGitHub {
	/** Base URL standing in for https://github.com/<owner>/<repo>/releases. */
	url: string;
	/** Tag served as the latest release; undefined means the repository has no releases. */
	latest: string | undefined;
	/** Release files keyed by "<tag>/<name>". */
	files: Map<string, Buffer>;
	close(): Promise<void>;
}

/**
 * Serve GitHub's release URL shapes: `latest` (redirect to the tag page), `latest/download/<file>`
 * (redirect to the latest release's file), and `download/<tag>/<file>`.
 */
export async function fakeGitHub(): Promise<FakeGitHub> {
	let server: Server;
	const state: FakeGitHub = {
		url: "",
		latest: undefined,
		files: new Map(),
		close: () => new Promise((done) => server.close(() => done())),
	};
	server = createServer((request, response) => {
		const path = request.url ?? "";
		if (path === "/releases/latest") {
			response.writeHead(302, { location: state.latest ? `${state.url}/tag/${state.latest}` : state.url });
			response.end();
			return;
		}
		const latestFile = /^\/releases\/latest\/download\/(.+)$/.exec(path)?.[1];
		if (latestFile) {
			if (state.latest) response.writeHead(302, { location: `${state.url}/download/${state.latest}/${latestFile}` });
			else response.writeHead(404);
			response.end();
			return;
		}
		const file = state.files.get(path.replace(/^\/releases\/download\//, ""));
		response.writeHead(file ? 200 : 404);
		response.end(file);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases`;
	return state;
}

/** Release target of this machine, as install.sh detects it. */
export function hostTarget(): string {
	return `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
}

/**
 * A release archive whose "binary" is a shell script. By default it prints `reportedVersion`;
 * `script` replaces its body to simulate a broken binary.
 */
export function releaseArchive(asset: string, reportedVersion: string, script = `echo ${reportedVersion}`): Buffer {
	const stage = tempDir("shipshape-stage-");
	writeFileSync(join(stage, "shipshape"), `#!/bin/sh\n${script}\n`);
	chmodSync(join(stage, "shipshape"), 0o755);
	writeFileSync(join(stage, "LICENSE"), "MIT\n");
	const archive = join(stage, asset);
	execFileSync("tar", ["-czf", archive, "-C", stage, "shipshape", "LICENSE"]);
	return readFileSync(archive);
}

/** Publish `archive` as `asset` in release `tag` and make it the latest; `sums` fakes a different checksum. */
export function publish(github: FakeGitHub, tag: string, asset: string, archive: Buffer, sums: Buffer = archive): void {
	github.latest = tag;
	github.files.set(`${tag}/${asset}`, archive);
	const sha = createHash("sha256").update(sums).digest("hex");
	github.files.set(`${tag}/SHA256SUMS`, Buffer.from(`${sha}  ${asset}\n`));
}
