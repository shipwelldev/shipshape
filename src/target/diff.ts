export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
}

export interface ChangedFile {
	/** Repository-relative POSIX path in the reviewed version (the old path for deletions). */
	path: string;
	/** Previous path for renames and copies. */
	oldPath?: string;
	status: ChangeStatus;
	binary: boolean;
	additions: number;
	deletions: number;
	hunks: Hunk[];
	/** This file's section of the unified diff. */
	patch: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff` output (produced with DIFF_FLAGS, so prefixes are a/ and b/) into
 * per-file changes. Paths come from the unambiguous extended headers where possible.
 */
export function parsePatch(text: string): ChangedFile[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const files: ChangedFile[] = [];
	let chunk: string[] | undefined;
	const flush = () => {
		if (chunk) files.push(parseChunk(chunk));
	};
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			flush();
			chunk = [line];
		} else if (chunk) {
			chunk.push(line);
		}
	}
	flush();
	return files;
}

function parseChunk(lines: string[]): ChangedFile {
	let status: ChangeStatus = "modified";
	let renameFrom: string | undefined;
	let renameTo: string | undefined;
	let minusPath: string | undefined;
	let plusPath: string | undefined;
	let binary = false;
	let additions = 0;
	let deletions = 0;
	const hunks: Hunk[] = [];
	let inHunks = false;

	for (const line of lines.slice(1)) {
		if (inHunks) {
			const header = HUNK_HEADER.exec(line);
			if (header) {
				hunks.push(hunkFrom(header));
			} else if (line.startsWith("+")) {
				additions++;
			} else if (line.startsWith("-")) {
				deletions++;
			}
			continue;
		}
		const header = HUNK_HEADER.exec(line);
		if (header) {
			inHunks = true;
			hunks.push(hunkFrom(header));
		} else if (line.startsWith("new file mode")) {
			status = "added";
		} else if (line.startsWith("deleted file mode")) {
			status = "deleted";
		} else if (line.startsWith("rename from ")) {
			status = "renamed";
			renameFrom = unquote(line.slice("rename from ".length));
		} else if (line.startsWith("rename to ")) {
			renameTo = unquote(line.slice("rename to ".length));
		} else if (line.startsWith("copy from ")) {
			status = "copied";
			renameFrom = unquote(line.slice("copy from ".length));
		} else if (line.startsWith("copy to ")) {
			renameTo = unquote(line.slice("copy to ".length));
		} else if (line.startsWith("--- ")) {
			minusPath = stripPrefix(fileLinePath(line.slice(4)), "a/");
		} else if (line.startsWith("+++ ")) {
			plusPath = stripPrefix(fileLinePath(line.slice(4)), "b/");
		} else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
			binary = true;
		}
	}

	const [headerOld, headerNew] = parseGitHeader(lines[0]!.slice("diff --git ".length));
	const newPath = renameTo ?? plusPath ?? headerNew;
	const oldPath = renameFrom ?? minusPath ?? headerOld;
	const path = status === "deleted" ? (oldPath ?? newPath) : (newPath ?? oldPath);

	const file: ChangedFile = {
		path: path ?? "",
		status,
		binary,
		additions,
		deletions,
		hunks,
		patch: lines.join("\n"),
	};
	if ((status === "renamed" || status === "copied") && renameFrom) file.oldPath = renameFrom;
	return file;
}

function hunkFrom(match: RegExpExecArray): Hunk {
	return {
		oldStart: Number(match[1]),
		oldLines: match[2] === undefined ? 1 : Number(match[2]),
		newStart: Number(match[3]),
		newLines: match[4] === undefined ? 1 : Number(match[4]),
	};
}

/** Path from a `---`/`+++` line; git appends a tab when the name contains a space. */
function fileLinePath(value: string): string | undefined {
	if (value === "/dev/null") return undefined;
	if (value.startsWith('"')) return unquote(value);
	return value.endsWith("\t") ? value.slice(0, -1) : value;
}

function stripPrefix(path: string | undefined, prefix: string): string | undefined {
	if (path === undefined) return undefined;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Parse "a/X b/Y" from a `diff --git` header. Unquoted names are recovered only when X equals Y. */
function parseGitHeader(rest: string): [string | undefined, string | undefined] {
	if (rest.startsWith('"')) {
		const [first, end] = readQuoted(rest, 0);
		const second = rest.slice(end + 1);
		const secondPath = second.startsWith('"') ? readQuoted(second, 0)[0] : second;
		return [stripPrefix(first, "a/"), stripPrefix(secondPath, "b/")];
	}
	if ((rest.length - 5) % 2 === 0 && rest.startsWith("a/")) {
		const name = rest.slice(2, 2 + (rest.length - 5) / 2);
		if (rest === `a/${name} b/${name}`) return [name, name];
	}
	return [undefined, undefined];
}

/** Undo git's C-style path quoting. Returns unquoted input unchanged. */
export function unquote(value: string): string {
	return value.startsWith('"') ? readQuoted(value, 0)[0] : value;
}

function readQuoted(value: string, start: number): [string, number] {
	const bytes: number[] = [];
	const escapes: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, '"': 34 };
	let i = start + 1;
	for (; i < value.length; i++) {
		const codePoint = value.codePointAt(i)!;
		const char = String.fromCodePoint(codePoint);
		if (char === '"') break;
		if (char !== "\\") {
			bytes.push(...Buffer.from(char, "utf8"));
			if (codePoint > 0xffff) i++;
			continue;
		}
		const next = value[++i] ?? "";
		if (/[0-7]/.test(next)) {
			bytes.push(Number.parseInt(value.slice(i, i + 3), 8));
			i += 2;
		} else {
			bytes.push(escapes[next] ?? next.charCodeAt(0));
		}
	}
	return [Buffer.from(bytes).toString("utf8"), i];
}
