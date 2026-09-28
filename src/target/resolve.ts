import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { minimatch } from "minimatch";
import { type ChangedFile, parsePatch } from "./diff.js";
import { DIFF_FLAGS, emptyTree, GitError, git, gitText, splitNul } from "./git.js";

export type TargetKind = "worktree" | "staged" | "branch" | "all";

/** A target that cannot be resolved as requested (bad ref, missing repository, conflicts). */
export class TargetError extends Error {}

export interface ProjectLocation {
	/** Git top level, or the selected directory outside Git. */
	root: string;
	isGit: boolean;
}

export interface TargetRequest {
	kind: TargetKind;
	base?: string;
	head?: string;
	exclude: readonly string[];
}

export interface TargetIdentity {
	base?: { ref: string; commit: string };
	merge_base?: string;
	head?: { ref: string; commit: string };
	/** Hash of the reviewed uncommitted content (working tree or index). */
	content_sha256?: string;
}

export type Stability = "stable" | "changed" | "unknown";

export interface ReviewTarget {
	kind: TargetKind;
	root: string;
	/** Directory Pi's tools operate in; contains exactly the reviewed version. */
	workspace: string;
	description: string;
	identity: TargetIdentity;
	/** In-scope changed files (diff targets). */
	files: ChangedFile[];
	/** In-scope files for a full-codebase review. */
	inventory: string[];
	/** Paths removed from scope by `review.exclude`. */
	excluded: string[];
	/** Private temporary directory outside the workspace. */
	scratchDir: string;
	/** True when there is nothing in scope to review. */
	isEmpty: boolean;
	/** Contents of a file on the base side ("old" line numbers), if the target has one. */
	readBaseFile(path: string): Promise<string | undefined>;
	/** Whether the reviewed content is still what the review started with. */
	checkStability(): Promise<Stability>;
	dispose(): Promise<void>;
}

export async function locateProject(dir: string): Promise<ProjectLocation> {
	const info = await stat(dir).catch(() => undefined);
	if (!info?.isDirectory()) throw new TargetError(`${dir} is not a directory.`);
	try {
		const top = (await gitText(["rev-parse", "--show-toplevel"], { cwd: dir })).trim();
		return { root: resolve(top), isGit: true };
	} catch (error) {
		if (error instanceof GitError && (error.exitCode === null || /not a git repository/i.test(error.stderr))) {
			return { root: resolve(dir), isGit: false };
		}
		throw error;
	}
}

export function isExcluded(path: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) =>
		minimatch(path, pattern.endsWith("/") ? `${pattern}**` : pattern, { dot: true, matchBase: true }),
	);
}

export async function resolveTarget(project: ProjectLocation, request: TargetRequest): Promise<ReviewTarget> {
	if (!project.isGit && request.kind !== "all") {
		throw new TargetError(
			`${project.root} is not inside a Git repository. Use --all to review a directory without Git.`,
		);
	}
	const scratchDir = await mkdtemp(join(tmpdir(), "shipshape-"));
	try {
		switch (request.kind) {
			case "worktree":
				return await worktreeTarget(project.root, request, scratchDir);
			case "staged":
				return await stagedTarget(project.root, request, scratchDir);
			case "branch":
				return await branchTarget(project.root, request, scratchDir);
			case "all":
				return await allTarget(project, request, scratchDir);
		}
	} catch (error) {
		await rm(scratchDir, { recursive: true, force: true });
		throw error;
	}
}

async function worktreeTarget(root: string, request: TargetRequest, scratchDir: string): Promise<ReviewTarget> {
	const head = await resolveHead(root);
	const state = await readWorktreeState(root, head);
	const { files, excluded } = partition(state.files, request.exclude);
	return {
		kind: "worktree",
		root,
		workspace: root,
		description: head
			? `uncommitted changes against HEAD (${short(head)})`
			: "uncommitted changes in a repository with no commits",
		identity: { ...(head ? { base: { ref: "HEAD", commit: head } } : {}), content_sha256: state.hash },
		files,
		inventory: [],
		excluded,
		scratchDir,
		isEmpty: files.length === 0,
		readBaseFile: (path) => (head ? readBlob(root, head, path) : Promise.resolve(undefined)),
		checkStability: async () => ((await readWorktreeState(root, head)).hash === state.hash ? "stable" : "changed"),
		dispose: () => rm(scratchDir, { recursive: true, force: true }),
	};
}

async function stagedTarget(root: string, request: TargetRequest, scratchDir: string): Promise<ReviewTarget> {
	if ((await gitText(["ls-files", "-z", "-u"], { cwd: root })).length > 0) {
		throw new TargetError("The index has unresolved merge conflicts; resolve them before reviewing staged changes.");
	}
	const head = await resolveHead(root);
	const base = head ?? (await emptyTree(root));
	const indexHash = await hashIndex(root);
	const patch = await gitText(["diff", "--cached", "--binary", ...DIFF_FLAGS, base, "--"], { cwd: root });

	// Materialize the index so Pi's tools read staged contents, not unstaged edits.
	const workspace = join(scratchDir, "workspace");
	await mkdir(workspace); // checkout-index creates nothing when every file was deleted
	await checkoutIndex(root, workspace);
	if ((await hashIndex(root)) !== indexHash) {
		throw new TargetError("The index changed while preparing the review; try again.");
	}

	const { files, excluded } = partition(stripBinaryPatches(parsePatch(patch)), request.exclude);
	return {
		kind: "staged",
		root,
		workspace,
		description: head ? `staged changes against HEAD (${short(head)})` : "staged changes in a repository with no commits",
		identity: { ...(head ? { base: { ref: "HEAD", commit: head } } : {}), content_sha256: indexHash },
		files,
		inventory: [],
		excluded,
		scratchDir,
		isEmpty: files.length === 0,
		readBaseFile: (path) => (head ? readBlob(root, head, path) : Promise.resolve(undefined)),
		// The workspace is a private snapshot, so later index edits cannot change what was reviewed.
		checkStability: async () => "stable",
		dispose: () => rm(scratchDir, { recursive: true, force: true }),
	};
}

async function branchTarget(root: string, request: TargetRequest, scratchDir: string): Promise<ReviewTarget> {
	const baseRef = request.base!;
	const headRef = request.head ?? "HEAD";
	const baseCommit = await resolveCommit(root, baseRef, "--base");
	const headCommit = await resolveCommit(root, headRef, "--head");
	let mergeBase: string;
	try {
		mergeBase = (await gitText(["merge-base", baseCommit, headCommit], { cwd: root })).trim();
	} catch (error) {
		if (!(error instanceof GitError)) throw error;
		throw new TargetError(
			`No merge base between ${baseRef} and ${headRef}. In a shallow clone, fetch more history (for example actions/checkout with fetch-depth: 0).`,
		);
	}
	const patch = await gitText(["diff", "--binary", ...DIFF_FLAGS, mergeBase, headCommit, "--"], { cwd: root });

	// Materialize the head commit through a private index; the user's index and worktree are untouched.
	const workspace = join(scratchDir, "workspace");
	await mkdir(workspace); // the head commit may have an empty tree
	const env = { GIT_INDEX_FILE: join(scratchDir, "index") };
	await git(["read-tree", headCommit], { cwd: root, env });
	await checkoutIndex(root, workspace, env);

	const { files, excluded } = partition(stripBinaryPatches(parsePatch(patch)), request.exclude);
	return {
		kind: "branch",
		root,
		workspace,
		description: `changes on ${headRef} (${short(headCommit)}) since its merge base with ${baseRef} (${short(mergeBase)})`,
		identity: {
			base: { ref: baseRef, commit: baseCommit },
			merge_base: mergeBase,
			head: { ref: headRef, commit: headCommit },
		},
		files,
		inventory: [],
		excluded,
		scratchDir,
		isEmpty: files.length === 0,
		readBaseFile: (path) => readBlob(root, mergeBase, path),
		checkStability: async () => "stable",
		dispose: () => rm(scratchDir, { recursive: true, force: true }),
	};
}

async function allTarget(project: ProjectLocation, request: TargetRequest, scratchDir: string): Promise<ReviewTarget> {
	const root = project.root;
	let listed: string[];
	let head: string | undefined;
	let hash: string | undefined;
	if (project.isGit) {
		head = await resolveHead(root);
		hash = (await readWorktreeState(root, head)).hash;
		const names = splitNul(await gitText(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root }));
		listed = [];
		for (const name of new Set(names)) {
			if (!name.endsWith("/") && (await isFileOrLink(join(root, name)))) listed.push(name);
		}
	} else {
		listed = await walk(root);
	}
	listed.sort();
	const inventory = listed.filter((path) => !isExcluded(path, request.exclude));
	const excluded = listed.filter((path) => isExcluded(path, request.exclude));
	return {
		kind: "all",
		root,
		workspace: root,
		description: head ? `entire codebase at ${root} (HEAD ${short(head)} plus any uncommitted changes)` : `entire codebase at ${root}`,
		identity: { ...(head ? { head: { ref: "HEAD", commit: head } } : {}), ...(hash ? { content_sha256: hash } : {}) },
		files: [],
		inventory,
		excluded,
		scratchDir,
		isEmpty: inventory.length === 0,
		readBaseFile: async () => undefined,
		checkStability: async () => {
			if (!project.isGit) return "unknown";
			return (await readWorktreeState(root, head)).hash === hash ? "stable" : "changed";
		},
		dispose: () => rm(scratchDir, { recursive: true, force: true }),
	};
}

interface WorktreeState {
	files: ChangedFile[];
	hash: string;
}

/** Tracked changes against HEAD plus untracked, non-ignored files, with a content hash of all of it. */
async function readWorktreeState(root: string, head: string | undefined): Promise<WorktreeState> {
	const base = head ?? (await emptyTree(root));
	const tracked = await gitText(["diff", "--binary", ...DIFF_FLAGS, base, "--"], { cwd: root });
	const hash = createHash("sha256").update("tracked\0").update(tracked);
	const files = stripBinaryPatches(parsePatch(tracked));

	const untracked = splitNul(await gitText(["ls-files", "-z", "--others", "--exclude-standard"], { cwd: root }))
		.filter((name) => !name.endsWith("/"))
		.sort();
	for (const path of untracked) {
		const file = await untrackedFile(root, path);
		if (!file) continue;
		hash.update(`untracked\0${path}\0`).update(file.digest);
		files.push(file.change);
	}
	return { files, hash: hash.digest("hex") };
}

const MAX_SYNTHESIZED_BYTES = 1024 * 1024;

/** Build a new-file diff for an untracked file without spawning git per file. */
async function untrackedFile(root: string, path: string): Promise<{ change: ChangedFile; digest: string } | undefined> {
	const absolute = join(root, path);
	let info;
	try {
		info = await lstat(absolute);
	} catch {
		return undefined; // removed since listing
	}
	if (!info.isFile() && !info.isSymbolicLink()) return undefined;
	const mode = info.isSymbolicLink() ? "120000" : info.mode & 0o111 ? "100755" : "100644";
	const header = [`diff --git a/${path} b/${path}`, `new file mode ${mode}`];
	if (info.isFile() && info.size > MAX_SYNTHESIZED_BYTES) {
		return {
			digest: await hashFile(absolute),
			change: {
				path,
				status: "added",
				binary: false,
				additions: 0,
				deletions: 0,
				hunks: [],
				patch: [...header, `(new file of ${info.size} bytes; diff omitted)`].join("\n"),
			},
		};
	}
	const content = info.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
	const digest = createHash("sha256").update(content).digest("hex");
	if (content.subarray(0, 8000).includes(0)) {
		return {
			digest,
			change: {
				path,
				status: "added",
				binary: true,
				additions: 0,
				deletions: 0,
				hunks: [],
				patch: [...header, `Binary files /dev/null and b/${path} differ`].join("\n"),
			},
		};
	}
	const text = content.toString("utf8");
	const lines = text === "" ? [] : text.split("\n");
	const trailingNewline = text.endsWith("\n");
	if (trailingNewline) lines.pop();
	const body = lines.map((line) => `+${line}`);
	if (!trailingNewline && lines.length > 0) body.push("\\ No newline at end of file");
	const patch = [...header, "--- /dev/null", `+++ b/${path}`, ...(lines.length > 0 ? [`@@ -0,0 +1,${lines.length} @@`, ...body] : [])];
	return {
		digest,
		change: {
			path,
			status: "added",
			binary: false,
			additions: lines.length,
			deletions: 0,
			hunks: lines.length > 0 ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length }] : [],
			patch: patch.join("\n"),
		},
	};
}

/** Binary patch payloads are noise for a reviewer; keep only the header lines. */
function stripBinaryPatches(files: ChangedFile[]): ChangedFile[] {
	return files.map((file) => {
		if (!file.binary) return file;
		const lines = file.patch.split("\n");
		const cut = lines.findIndex((line) => line === "GIT binary patch" || line.startsWith("Binary files "));
		const kept = cut === -1 ? lines : lines.slice(0, cut);
		return { ...file, patch: [...kept, `Binary file ${file.status}`].join("\n") };
	});
}

function partition(all: ChangedFile[], patterns: readonly string[]): { files: ChangedFile[]; excluded: string[] } {
	const files: ChangedFile[] = [];
	const excluded: string[] = [];
	for (const file of all) {
		if (isExcluded(file.path, patterns)) excluded.push(file.path);
		else files.push(file);
	}
	return { files, excluded };
}

/**
 * Write every index entry into `workspace`. In a sparse checkout, entries outside the sparse
 * selection carry the skip-worktree bit and checkout-index would silently leave them out,
 * including staged changes, so those bits are ignored.
 */
async function checkoutIndex(root: string, workspace: string, env?: Record<string, string>): Promise<void> {
	await git(["checkout-index", "--all", "--force", "--ignore-skip-worktree-bits", `--prefix=${workspace}${sep}`], {
		cwd: root,
		...(env ? { env } : {}),
	});
}

async function resolveHead(root: string): Promise<string | undefined> {
	const result = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: root, okCodes: [1] });
	return result.exitCode === 0 ? result.stdout.toString("utf8").trim() : undefined;
}

async function resolveCommit(root: string, ref: string, flag: string): Promise<string> {
	const result = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
		cwd: root,
		okCodes: [1],
	});
	if (result.exitCode !== 0) {
		throw new TargetError(
			`Cannot resolve ${flag} "${ref}" to a commit. Check the name, or fetch it first (in CI, fetch the base branch or use fetch-depth: 0).`,
		);
	}
	return result.stdout.toString("utf8").trim();
}

async function hashIndex(root: string): Promise<string> {
	const listing = await git(["ls-files", "-z", "-s"], { cwd: root });
	return createHash("sha256").update(listing.stdout).digest("hex");
}

async function readBlob(root: string, commit: string, path: string): Promise<string | undefined> {
	const result = await git(["cat-file", "blob", `${commit}:${path}`], { cwd: root, okCodes: [128] });
	return result.exitCode === 0 ? result.stdout.toString("utf8") : undefined;
}

function hashFile(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		createReadStream(path)
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolve(hash.digest("hex")));
	});
}

async function isFileOrLink(path: string): Promise<boolean> {
	try {
		const info = await lstat(path);
		return info.isFile() || info.isSymbolicLink();
	} catch {
		return false;
	}
}

interface IgnoreScope {
	base: string;
	rules: Ignore;
}

const VCS_DIRS = new Set([".git", ".hg", ".svn"]);

/**
 * List files under a non-Git directory, as Git would see them: VCS metadata and anything
 * matched by a .gitignore (at any level, rules relative to their own directory) are skipped.
 * Symlinked directories are not followed.
 */
async function walk(root: string): Promise<string[]> {
	const out: string[] = [];
	const visit = async (dir: string, scopes: readonly IgnoreScope[]) => {
		const rules = await readFile(join(dir, ".gitignore"), "utf8").then(
			(text) => ignore().add(text),
			() => undefined,
		);
		const active = rules ? [...scopes, { base: dir, rules }] : scopes;
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const absolute = join(dir, entry.name);
			const isDir = entry.isDirectory();
			if (isDir && VCS_DIRS.has(entry.name)) continue;
			if (isIgnored(absolute, isDir, active)) continue;
			if (isDir) await visit(absolute, active);
			else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative(root, absolute).split(sep).join("/"));
		}
	};
	await visit(root, []);
	return out;
}

/** Deeper .gitignore files take precedence, and a negation (!pattern) re-includes a path. */
function isIgnored(absolute: string, isDir: boolean, scopes: readonly IgnoreScope[]): boolean {
	let ignored = false;
	for (const { base, rules } of scopes) {
		const path = relative(base, absolute).split(sep).join("/") + (isDir ? "/" : "");
		const result = rules.test(path);
		if (result.ignored) ignored = true;
		else if (result.unignored) ignored = false;
	}
	return ignored;
}

function short(commit: string): string {
	return commit.slice(0, 12);
}
