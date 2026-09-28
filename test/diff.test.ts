import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePatch, unquote } from "../src/target/diff.js";
import { DIFF_FLAGS } from "../src/target/git.js";
import { git, makeRepo, writeFiles } from "./helpers.js";

function diffHead(repo: string): string {
	return git(repo, "-c", "core.quotePath=false", "diff", ...DIFF_FLAGS, "HEAD", "--");
}

describe("parsePatch", () => {
	it("recovers exact paths for spaces, quotes, and non-ASCII names", () => {
		const names = ["with space.txt", 'quote"name.txt', "ünïcode 文件.txt", "tab\tname.txt"];
		const repo = makeRepo(Object.fromEntries(names.map((name) => [name, "a\n"])));
		writeFiles(repo, Object.fromEntries(names.map((name) => [name, "b\n"])));
		const files = parsePatch(diffHead(repo));
		expect(files.map((f) => f.path).sort()).toEqual([...names].sort());
		for (const file of files) expect(file).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
	});

	it("handles mode-only changes and tracked binary modifications", () => {
		const repo = makeRepo({ "run.sh": "echo hi\n", "img.bin": "\0\x01" });
		chmodSync(join(repo, "run.sh"), 0o755);
		writeFileSync(join(repo, "img.bin"), Buffer.from([0, 2, 3]));
		const files = parsePatch(diffHead(repo));
		const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
		expect(byPath["run.sh"]).toMatchObject({ status: "modified", additions: 0, deletions: 0, hunks: [] });
		expect(byPath["img.bin"]).toMatchObject({ binary: true });
	});

	it("does not mistake removed lines that look like headers for file headers", () => {
		const patch = [
			"diff --git a/x.md b/x.md",
			"--- a/x.md",
			"+++ b/x.md",
			"@@ -1,2 +1,1 @@",
			"--- a/not-a-header",
			" kept",
		].join("\n");
		const [file] = parsePatch(patch);
		expect(file).toMatchObject({ path: "x.md", deletions: 1, additions: 0 });
	});

	it("unquotes git C-style escapes including octal UTF-8 bytes", () => {
		expect(unquote('"a\\tb"')).toBe("a\tb");
		expect(unquote('"\\303\\274ber"')).toBe("über");
		expect(unquote("plain")).toBe("plain");
	});
});
