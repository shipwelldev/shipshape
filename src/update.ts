import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_RELEASES_URL = "https://github.com/shipwelldev/shipshape/releases";

export class UpdateError extends Error {}

/** Release archive for a target: `shipshape-linux-x64.tar.gz`, `shipshape-windows-x64.zip`. */
export function assetName(target: string): string {
	return target.startsWith("windows-") ? `shipshape-${target}.zip` : `shipshape-${target}.tar.gz`;
}

export function binaryName(target: string): string {
	return target.startsWith("windows-") ? "shipshape.exe" : "shipshape";
}

interface ParsedVersion {
	core: [number, number, number];
	pre: string[];
}

export function parseVersion(text: string): ParsedVersion | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
	if (!match) return undefined;
	return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split(".") : [] };
}

/** Semantic-version order: negative when a < b, zero when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) throw new UpdateError(`Cannot compare versions "${a}" and "${b}".`);
	for (let i = 0; i < 3; i++) {
		if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
	}
	// A release outranks its pre-releases (1.0.0 > 1.0.0-rc.1).
	if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
	for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i]!;
		const q = y.pre[i]!;
		if (p === q) continue;
		const pNumeric = /^\d+$/.test(p);
		const qNumeric = /^\d+$/.test(q);
		if (pNumeric && qNumeric) return Number(p) - Number(q);
		if (pNumeric !== qNumeric) return pNumeric ? -1 : 1;
		return p < q ? -1 : 1;
	}
	return x.pre.length - y.pre.length;
}

/**
 * The latest release tag, read from the redirect GitHub serves for `releases/latest`
 * rather than the REST API, which rate-limits unauthenticated callers.
 */
export async function latestTag(releasesUrl: string, fetchFn: typeof fetch = fetch): Promise<string> {
	let response: Response;
	try {
		response = await fetchFn(`${releasesUrl}/latest`, { redirect: "manual" });
	} catch (error) {
		throw new UpdateError(`Could not reach ${releasesUrl}: ${(error as Error).message}`);
	}
	const location = response.headers.get("location") ?? "";
	const tag = /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1];
	if (response.status >= 300 && response.status < 400 && tag) return decodeURIComponent(tag);
	if (response.status === 404 || (response.status >= 300 && response.status < 400)) {
		throw new UpdateError(`No published release found at ${releasesUrl}.`);
	}
	throw new UpdateError(`Could not determine the latest release from ${releasesUrl} (HTTP ${response.status}).`);
}

/** Parse `sha256sum` output: "<hex>  <file>" per line. */
export function parseChecksums(text: string): Map<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
		if (match) sums.set(match[2]!, match[1]!.toLowerCase());
	}
	return sums;
}

export interface UpdateOptions {
	/** Report whether an update exists without installing it. */
	checkOnly: boolean;
	currentVersion: string;
	/** Release target baked into this binary; undefined when running from source. */
	target: string | undefined;
	/** Path of the running executable (process.execPath in a release binary). */
	executable: string;
	releasesUrl: string;
	fetch?: typeof fetch;
	log?: (line: string) => void;
}

export type UpdateOutcome =
	| { status: "up_to_date"; current: string; latest: string }
	| { status: "available"; current: string; latest: string }
	| { status: "updated"; current: string; latest: string; path: string };

export async function runUpdate(options: UpdateOptions): Promise<UpdateOutcome> {
	if (!options.target) {
		throw new UpdateError(
			"This copy of Ship Shape runs from source, so it cannot update itself. Pull and rebuild, or install a release binary.",
		);
	}
	const fetchFn = options.fetch ?? fetch;
	const tag = await latestTag(options.releasesUrl, fetchFn);
	const latest = tag.replace(/^v/, "");
	const current = options.currentVersion;
	if (compareVersions(latest, current) <= 0) return { status: "up_to_date", current, latest };
	if (options.checkOnly) return { status: "available", current, latest };

	const asset = assetName(options.target);
	const base = `${options.releasesUrl}/download/${encodeURIComponent(tag)}`;
	const sums = parseChecksums(await (await fetchOk(`${base}/SHA256SUMS`, fetchFn)).text());
	const expected = sums.get(asset);
	if (!expected) throw new UpdateError(`Release ${tag} has no ${asset} for this platform.`);

	const work = await mkdtemp(join(tmpdir(), "shipshape-update-"));
	try {
		const archive = join(work, asset);
		options.log?.(`Downloading ${asset} from ${tag}`);
		const actual = await download(`${base}/${asset}`, archive, fetchFn);
		if (actual !== expected) throw new UpdateError(`Checksum mismatch for ${asset}; the download was discarded.`);

		const extracted = join(work, "extracted");
		await mkdir(extracted);
		await extract(archive, extracted);
		const replacement = join(extracted, binaryName(options.target));
		if (!(await exists(replacement))) throw new UpdateError(`${asset} does not contain ${binaryName(options.target)}.`);
		await chmod(replacement, 0o755);

		// Refuse a binary that does not run here or reports a different version.
		const reported = (await capture(replacement, ["--version"])).trim();
		if (reported !== latest) {
			throw new UpdateError(`The downloaded binary reports version "${reported}", expected "${latest}"; nothing was changed.`);
		}

		const path = await realpath(options.executable);
		await replaceExecutable(path, replacement);
		return { status: "updated", current, latest, path };
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

/**
 * Swap in the new binary without leaving a half-written file at the installed path: stage
 * it beside the target (same filesystem), then rename over it. Windows cannot overwrite a
 * running .exe but can rename it, so the old one is moved aside first.
 */
export async function replaceExecutable(target: string, replacement: string): Promise<void> {
	const dir = dirname(target);
	const staged = join(dir, `.${basename(target)}.update-${process.pid}`);
	try {
		await copyFile(replacement, staged);
		await chmod(staged, 0o755);
	} catch (error) {
		await rm(staged, { force: true });
		throw writeError(dir, error);
	}
	try {
		if (process.platform === "win32") {
			const old = `${target}.old`;
			await rm(old, { force: true }).catch(() => {}); // left by an earlier update; may still be running
			await rename(target, old);
			try {
				await rename(staged, target);
			} catch (error) {
				await rename(old, target);
				throw error;
			}
			await rm(old, { force: true }).catch(() => {}); // this process still holds it; the next update removes it
		} else {
			await rename(staged, target);
		}
	} catch (error) {
		await rm(staged, { force: true });
		throw writeError(dir, error);
	}
}

function writeError(dir: string, error: unknown): UpdateError {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "EACCES" || code === "EPERM") {
		return new UpdateError(`No permission to replace the binary in ${dir}. Re-run with the permissions used to install it (for example sudo).`);
	}
	return new UpdateError(`Could not replace the binary in ${dir}: ${(error as Error).message}`);
}

async function fetchOk(url: string, fetchFn: typeof fetch): Promise<Response> {
	let response: Response;
	try {
		response = await fetchFn(url);
	} catch (error) {
		throw new UpdateError(`Could not download ${url}: ${(error as Error).message}`);
	}
	if (!response.ok || !response.body) throw new UpdateError(`Could not download ${url} (HTTP ${response.status}).`);
	return response;
}

/** Stream a download to disk and return its SHA-256. */
async function download(url: string, dest: string, fetchFn: typeof fetch): Promise<string> {
	const response = await fetchOk(url, fetchFn);
	const hash = createHash("sha256");
	const hasher = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			callback(null, chunk);
		},
	});
	await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), hasher, createWriteStream(dest));
	return hash.digest("hex");
}

/**
 * Extract with the system tar: Linux and macOS ship one, and Windows 10+ ships bsdtar, which
 * also reads .zip. On Windows use System32's copy explicitly; Git's GNU tar cannot read zip.
 */
function extract(archive: string, into: string): Promise<void> {
	const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
	return new Promise((resolve, reject) => {
		const child = spawn(tar, ["-xf", archive, "-C", into], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", (error) => reject(new UpdateError(`Cannot run tar to extract the update: ${error.message}`)));
		child.on("close", (code) =>
			code === 0 ? resolve() : reject(new UpdateError(`Extracting the update failed: ${stderr.trim() || `tar exited with ${code}`}`)),
		);
	});
}

function capture(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.on("error", (error) => reject(new UpdateError(`The downloaded binary does not run here: ${error.message}`)));
		child.on("close", (code, signal) => {
			if (code === 0) resolve(stdout);
			else {
				const how = signal ? `was killed by ${signal}` : `exited with code ${code}`;
				reject(new UpdateError(`The downloaded binary ${how} during its version check; nothing was changed.`));
			}
		});
	});
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
