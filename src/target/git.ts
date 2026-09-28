import { spawn } from "node:child_process";

export class GitError extends Error {
	constructor(
		message: string,
		readonly args: readonly string[],
		readonly exitCode: number | null,
		readonly stderr: string,
	) {
		super(message);
	}
}

export interface GitOptions {
	cwd: string;
	/** Extra environment, e.g. GIT_INDEX_FILE for a private index. */
	env?: Record<string, string>;
	/** Exit codes treated as success in addition to 0 (e.g. 1 for `diff --no-index`). */
	okCodes?: readonly number[];
	signal?: AbortSignal;
}

export interface GitResult {
	stdout: Buffer;
	exitCode: number;
}

/**
 * Run git without a shell. Output-shaping configuration from the user's or repository's
 * config (quoting, color, pager, external diff drivers) is overridden per command so
 * parsing is stable; GIT_OPTIONAL_LOCKS=0 stops read commands from rewriting the index.
 */
export function git(args: readonly string[], options: GitOptions): Promise<GitResult> {
	const fullArgs = ["-c", "core.quotePath=false", "-c", "color.ui=false", ...args];
	return new Promise((resolve, reject) => {
		const child = spawn("git", fullArgs, {
			cwd: options.cwd,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			signal: options.signal,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error: NodeJS.ErrnoException) => {
			const message = error.code === "ENOENT" ? "git is not installed or not on PATH" : `failed to run git: ${error.message}`;
			reject(new GitError(message, args, null, ""));
		});
		child.on("close", (code) => {
			const exitCode = code ?? -1;
			const errText = Buffer.concat(stderr).toString("utf8").trim();
			if (exitCode === 0 || options.okCodes?.includes(exitCode)) {
				resolve({ stdout: Buffer.concat(stdout), exitCode });
			} else {
				const detail = errText || `exit code ${exitCode}`;
				reject(new GitError(`git ${args[0]} failed: ${detail}`, args, exitCode, errText));
			}
		});
	});
}

export async function gitText(args: readonly string[], options: GitOptions): Promise<string> {
	return (await git(args, options)).stdout.toString("utf8");
}

/** Split NUL-terminated git output (`-z`) into fields. */
export function splitNul(text: string): string[] {
	const parts = text.split("\0");
	if (parts.at(-1) === "") parts.pop();
	return parts;
}

/** Flags that make `git diff` output deterministic regardless of user/repo config. */
export const DIFF_FLAGS = [
	"--no-color",
	"--no-ext-diff",
	"--no-textconv",
	"--no-relative",
	"--src-prefix=a/",
	"--dst-prefix=b/",
	"-M",
] as const;

/**
 * The empty tree id in this repository's hash algorithm, used as the base when HEAD is
 * unborn. stdin is /dev/null, so this hashes an empty tree without writing an object.
 */
export async function emptyTree(cwd: string): Promise<string> {
	return (await gitText(["hash-object", "-t", "tree", "--stdin"], { cwd })).trim();
}
