import { readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isExcluded, locateProject, type ReviewTarget, resolveTarget, type TargetRequest } from "../src/target/resolve.js";
import { commitAll, git, makeRepo, tempDir, writeFiles } from "./helpers.js";

const opened: ReviewTarget[] = [];
afterEach(async () => {
	await Promise.all(opened.splice(0).map((target) => target.dispose()));
});

async function target(dir: string, request: Partial<TargetRequest> = {}): Promise<ReviewTarget> {
	const resolved = await resolveTarget(await locateProject(dir), { kind: "worktree", exclude: [], ...request });
	opened.push(resolved);
	return resolved;
}

describe("working-tree target", () => {
	it("includes staged, unstaged, and untracked changes and parses them per file", async () => {
		const repo = makeRepo({ "src/a.ts": "one\ntwo\nthree\n", "old name.txt": "same\n", "gone.txt": "bye\n" });
		writeFiles(repo, { "src/a.ts": "one\nTWO\nthree\nfour\n", "new file.ts": "export const x = 1;\n" });
		git(repo, "mv", "old name.txt", "new name.txt");
		rmSync(join(repo, "gone.txt"));
		writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3]));

		const t = await target(repo);
		const byPath = Object.fromEntries(t.files.map((f) => [f.path, f]));
		expect(Object.keys(byPath).sort()).toEqual(["blob.bin", "gone.txt", "new file.ts", "new name.txt", "src/a.ts"]);
		expect(byPath["src/a.ts"]).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
		expect(byPath["src/a.ts"]!.hunks).toEqual([{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 }]);
		expect(byPath["new name.txt"]).toMatchObject({ status: "renamed", oldPath: "old name.txt" });
		expect(byPath["gone.txt"]).toMatchObject({ status: "deleted" });
		expect(byPath["new file.ts"]).toMatchObject({ status: "added", additions: 1 });
		expect(byPath["blob.bin"]).toMatchObject({ status: "added", binary: true });
		expect(t.workspace).toBe(repo);
		expect(t.identity.base?.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(t.identity.content_sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is empty when nothing changed and ignores gitignored files", async () => {
		const repo = makeRepo({ ".gitignore": "build/\n" });
		writeFiles(repo, { "build/out.js": "generated\n" });
		const t = await target(repo);
		expect(t.isEmpty).toBe(true);
	});

	it("detects content changes made during the review", async () => {
		const repo = makeRepo({ "a.txt": "1\n" });
		writeFiles(repo, { "a.txt": "2\n" });
		const t = await target(repo);
		expect(await t.checkStability()).toBe("stable");
		writeFiles(repo, { "a.txt": "3\n" });
		expect(await t.checkStability()).toBe("changed");
	});

	it("works in a repository with no commits", async () => {
		const repo = tempDir();
		git(repo, "init", "-q");
		writeFiles(repo, { "a.txt": "hello\n" });
		const t = await target(repo);
		expect(t.files.map((f) => f.path)).toEqual(["a.txt"]);
		expect(t.identity.base).toBeUndefined();
	});

	it("reads base-side file contents for old-line validation", async () => {
		const repo = makeRepo({ "a.txt": "base\n" });
		writeFiles(repo, { "a.txt": "changed\n" });
		const t = await target(repo);
		expect(await t.readBaseFile("a.txt")).toBe("base\n");
		expect(await t.readBaseFile("missing.txt")).toBeUndefined();
	});
});

describe("staged target", () => {
	it("materializes the index so unstaged edits are invisible", async () => {
		const repo = makeRepo({ "a.txt": "committed\n" });
		writeFiles(repo, { "a.txt": "staged\n" });
		git(repo, "add", "a.txt");
		writeFiles(repo, { "a.txt": "unstaged\n", "untracked.txt": "x\n" });

		const t = await target(repo, { kind: "staged" });
		expect(t.workspace).not.toBe(repo);
		expect(readFileSync(join(t.workspace, "a.txt"), "utf8")).toBe("staged\n");
		expect(existsSync(join(t.workspace, "untracked.txt"))).toBe(false);
		expect(t.files.map((f) => f.path)).toEqual(["a.txt"]);
		expect(t.files[0]!.patch).toContain("+staged");
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("unstaged\n");

		const workspace = t.workspace;
		await t.dispose();
		expect(existsSync(workspace)).toBe(false);
	});

	it.each(["--no-sparse-index", "--sparse-index"])(
		"includes files outside a sparse checkout (%s), including staged changes there",
		async (indexMode) => {
			const repo = makeRepo({ "inside/a.txt": "a\n", "outside/b.txt": "b\n", "outside/c.txt": "c\n" });
			git(repo, "sparse-checkout", "set", "--cone", indexMode, "inside");
			// Stage a change outside the cone the supported way, then let Git re-apply the sparse rules.
			git(repo, "sparse-checkout", "add", "outside");
			writeFiles(repo, { "outside/b.txt": "b staged\n" });
			git(repo, "add", "outside/b.txt");
			git(repo, "sparse-checkout", "set", "inside");
			expect(git(repo, "ls-files", "-t")).toContain("S outside/b.txt");

			const t = await target(repo, { kind: "staged" });
			expect(t.files.map((f) => f.path)).toEqual(["outside/b.txt"]);
			expect(readFileSync(join(t.workspace, "outside/b.txt"), "utf8")).toBe("b staged\n");
			expect(readFileSync(join(t.workspace, "outside/c.txt"), "utf8")).toBe("c\n");
			expect(existsSync(join(repo, "outside"))).toBe(false);
		},
	);

	it("is empty when nothing is staged", async () => {
		const repo = makeRepo();
		writeFiles(repo, { "README.md": "unstaged edit\n" });
		expect((await target(repo, { kind: "staged" })).isEmpty).toBe(true);
	});
});

describe("branch target", () => {
	it("reviews the head commit's changes since the merge base, in a private snapshot", async () => {
		const repo = makeRepo({ "a.txt": "base\n" });
		git(repo, "checkout", "-q", "-b", "feature");
		writeFiles(repo, { "a.txt": "feature\n", "b.txt": "new\n" });
		const head = commitAll(repo, "feature work");
		git(repo, "checkout", "-q", "main");
		writeFiles(repo, { "main-only.txt": "later on main\n" });
		commitAll(repo, "main moves on");
		writeFiles(repo, { "a.txt": "dirty worktree\n" });

		const t = await target(repo, { kind: "branch", base: "main", head: "feature" });
		expect(t.files.map((f) => f.path).sort()).toEqual(["a.txt", "b.txt"]);
		expect(t.identity.head).toEqual({ ref: "feature", commit: head });
		expect(t.identity.merge_base).toMatch(/^[0-9a-f]{40}$/);
		expect(readFileSync(join(t.workspace, "a.txt"), "utf8")).toBe("feature\n");
		expect(existsSync(join(t.workspace, "main-only.txt"))).toBe(false);
		expect(await t.readBaseFile("a.txt")).toBe("base\n");
		expect(git(repo, "status", "--porcelain")).toContain("a.txt");
	});

	it("explains unresolvable refs", async () => {
		const repo = makeRepo();
		await expect(target(repo, { kind: "branch", base: "origin/nope" })).rejects.toThrow(/Cannot resolve --base "origin\/nope"/);
	});
});

describe("snapshots of an empty tree", () => {
	it("creates the workspace when every tracked file is deleted", async () => {
		const repo = makeRepo({ "a.txt": "a\n", "b.txt": "b\n" });
		git(repo, "rm", "-q", "a.txt", "b.txt");
		const staged = await target(repo, { kind: "staged" });
		expect(existsSync(staged.workspace)).toBe(true);
		expect(staged.files.map((f) => [f.path, f.status])).toEqual([
			["a.txt", "deleted"],
			["b.txt", "deleted"],
		]);

		git(repo, "checkout", "-q", "-b", "wipe");
		git(repo, "commit", "-q", "-m", "delete everything");
		const branch = await target(repo, { kind: "branch", base: "main", head: "wipe" });
		expect(existsSync(branch.workspace)).toBe(true);
		expect(branch.files).toHaveLength(2);
	});
});

describe("full-codebase target", () => {
	it("lists tracked and untracked files in a Git repository, honoring excludes", async () => {
		const repo = makeRepo({ "src/a.ts": "a\n", "vendor/lib.js": "v\n", ".gitignore": "*.log\n" });
		writeFiles(repo, { "src/b.ts": "b\n", "debug.log": "noise\n" });
		const t = await target(repo, { kind: "all", exclude: ["vendor/**"] });
		expect(t.inventory).toEqual([".gitignore", "src/a.ts", "src/b.ts"]);
		expect(t.excluded).toEqual(["vendor/lib.js"]);
	});

	it("reviews a plain directory outside Git", async () => {
		const dir = tempDir();
		writeFiles(dir, { "main.py": "print(1)\n", "pkg/util.py": "x = 1\n" });
		const t = await target(dir, { kind: "all" });
		expect(t.inventory).toEqual(["main.py", "pkg/util.py"]);
		expect(await t.checkStability()).toBe("unknown");
	});

	it("respects .gitignore files outside Git, including nested rules and negations", async () => {
		const dir = tempDir();
		writeFiles(dir, {
			".gitignore": "node_modules/\n*.log\n!keep.log\n",
			"node_modules/pkg/index.js": "x",
			"src/app.ts": "x",
			"src/debug.log": "x",
			"src/keep.log": "x",
			"src/generated/.gitignore": "*\n!.gitignore\n",
			"src/generated/out.ts": "x",
		});
		const t = await target(dir, { kind: "all" });
		expect(t.inventory).toEqual([".gitignore", "src/app.ts", "src/generated/.gitignore", "src/keep.log"]);
		expect(t.excluded).toEqual([]);
	});

	it("requires --all outside Git", async () => {
		const dir = tempDir();
		await expect(target(dir)).rejects.toThrow(/not inside a Git repository. Use --all/);
	});
});

describe("exclude patterns", () => {
	it("matches repository-relative globs, bare names at any depth, and directory prefixes", () => {
		expect(isExcluded("vendor/x/y.js", ["vendor/**"])).toBe(true);
		expect(isExcluded("vendor/x/y.js", ["vendor/"])).toBe(true);
		expect(isExcluded("deep/path/package-lock.json", ["package-lock.json"])).toBe(true);
		expect(isExcluded("src/a.min.js", ["*.min.js"])).toBe(true);
		expect(isExcluded("src/a.js", ["vendor/**", "*.min.js"])).toBe(false);
		expect(isExcluded(".github/workflows/ci.yml", [".github/**"])).toBe(true);
	});
});
