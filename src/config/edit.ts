import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ConfigError, validateConfigText } from "./resolve.js";
import { type SettingDef, SettingError, type SettingKey, SETTINGS_BY_KEY } from "./schema.js";

/** Convert `config set` arguments into the TOML value for a setting. */
export function valueFromArgs(def: SettingDef, args: readonly string[]): unknown {
	if (def.kind === "list") {
		const [only] = args;
		if (args.length === 1 && only!.trim().startsWith("[")) {
			try {
				return (parseToml(`value = ${only}`) as { value: unknown }).value;
			} catch {
				throw new SettingError(`${JSON.stringify(only)} is not a valid TOML array`);
			}
		}
		if (args.length === 0) throw new SettingError("expected one or more values, or [] for an empty list");
		return [...args];
	}
	if (args.length !== 1) throw new SettingError(`expected exactly one value; got ${args.length}`);
	const value = args[0]!;
	return def.kind === "integer" && /^\d+$/.test(value) ? Number(value) : value;
}

export interface EditOptions {
	path: string;
	layer: "project" | "global";
	/** The file was chosen with --config rather than discovered in the repository. */
	explicit: boolean;
	key: SettingKey;
	/** New value; undefined removes the key. */
	value?: unknown;
}

/**
 * Set or remove one setting in a TOML file, keeping every other line (comments, ordering,
 * formatting) as it was. The result must parse to exactly the intended change and pass the
 * same validation `review` applies, or nothing is written.
 */
export async function editSetting(options: EditOptions): Promise<{ changed: boolean }> {
	const { path, layer, key, value } = options;
	const def = SETTINGS_BY_KEY.get(key)!;
	if (!def.layers.includes(layer)) {
		const allowed = def.layers.filter((l) => l !== "cli").join(" or ");
		throw new ConfigError([`"${key}" cannot be set in ${layer} configuration; use the ${allowed} config instead.`]);
	}

	let original = "";
	let mode: number | undefined;
	try {
		original = await readFile(path, "utf8");
		mode = (await stat(path)).mode & 0o7777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	try {
		parseToml(original);
	} catch (error) {
		throw new ConfigError([`${path}: the file is not valid TOML (${firstLine((error as Error).message)}); fix it by hand first.`]);
	}

	const updated = value === undefined ? unsetKey(original, key) : setKey(original, key, value);
	if (updated === undefined || updated === original) return { changed: false };
	if (!sameValue(readKey(updated, key), value)) {
		throw new ConfigError([`${path}: cannot update ${key} without restructuring the file; edit it by hand.`]);
	}
	const problems: string[] = [];
	await validateConfigText(updated, path, layer, options.explicit, problems);
	if (problems.length > 0) throw new ConfigError(problems);

	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, updated);
	if (mode !== undefined) await chmod(temporary, mode);
	await rename(temporary, path);
	return { changed: true };
}

/** The TOML text for a value, e.g. `"high"` or `["a", "b"]`. */
export function tomlLiteral(value: unknown): string {
	return stringifyToml({ value }).trim().slice("value = ".length);
}

interface Entry {
	/** Fully qualified key, e.g. "review.fail_on", whether written in a [review] table or dotted. */
	name: string;
	/** Table the entry is written in ("" for the root). */
	table: string;
	start: number;
	end: number;
	indent: string;
	keyText: string;
	/** Trailing comment (with its leading spaces) on a single-line entry. */
	comment: string;
}

interface Layout {
	lines: string[];
	eol: string;
	entries: Entry[];
	headers: Array<{ table: string; line: number }>;
}

const HEADER = /^\s*\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/;
const MAX_VALUE_LINES = 500;

function layout(text: string): Layout {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text === "" ? [] : text.split(/\r?\n/);
	if (lines.at(-1) === "") lines.pop();
	const entries: Entry[] = [];
	const headers: Layout["headers"] = [];
	let table = "";
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		if (trimmed.startsWith("[[")) {
			table = "\0array-of-tables";
			headers.push({ table, line: i });
			continue;
		}
		const header = HEADER.exec(line);
		if (header) {
			table = canonicalKey(header[1]!, "header");
			headers.push({ table, line: i });
			continue;
		}
		// A key/value entry spans the fewest lines that parse on their own (multi-line arrays and strings).
		let end = -1;
		for (let j = i; j < Math.min(lines.length, i + MAX_VALUE_LINES); j++) {
			if (parses(lines.slice(i, j + 1).join("\n"))) {
				end = j;
				break;
			}
		}
		if (end === -1) throw new ConfigError([`cannot locate the end of the value on line ${i + 1}; edit the file by hand.`]);
		const keyText = line.slice(0, line.indexOf("=")).trim();
		const dotted = canonicalKey(keyText, "key");
		entries.push({
			name: table ? `${table}.${dotted}` : dotted,
			table,
			start: i,
			end,
			indent: /^\s*/.exec(line)![0],
			keyText,
			comment: end === i ? trailingComment(line) : "",
		});
		i = end;
	}
	return { lines, eol, entries, headers };
}

export function setKey(text: string, key: SettingKey, value: unknown): string {
	const { lines, eol, entries, headers } = layout(text);
	const literal = tomlLiteral(value);
	const [table, leaf] = splitKey(key);
	const existing = entries.filter((entry) => entry.name === key);
	if (existing.length > 1) throw new ConfigError([`${key} is defined more than once; edit the file by hand.`]);

	let out: string[];
	const match = existing[0];
	if (match) {
		out = splice(lines, match.start, match.end - match.start + 1, [`${match.indent}${match.keyText} = ${literal}${match.comment}`]);
	} else if (table === "") {
		// Root keys must precede the first table header.
		const lastRoot = entries.filter((entry) => entry.table === "").at(-1);
		const firstHeader = headers[0];
		if (lastRoot) out = splice(lines, lastRoot.end + 1, 0, [`${leaf} = ${literal}`]);
		else if (firstHeader) out = splice(lines, firstHeader.line, 0, [`${leaf} = ${literal}`, ""]);
		else out = [...lines, `${leaf} = ${literal}`];
	} else {
		const header = headers.find((h) => h.table === table);
		const dottedAtRoot = entries.filter((entry) => entry.table === "" && entry.name.startsWith(`${table}.`));
		if (header) {
			const next = headers.find((h) => h.line > header.line)?.line ?? lines.length;
			const last = entries.filter((entry) => entry.start > header.line && entry.start < next).at(-1);
			out = splice(lines, last ? last.end + 1 : header.line + 1, 0, [`${leaf} = ${literal}`]);
		} else if (dottedAtRoot.length > 0) {
			// The table is defined with dotted keys; adding a [table] header would redefine it.
			out = splice(lines, dottedAtRoot.at(-1)!.end + 1, 0, [`${key} = ${literal}`]);
		} else {
			out = [...lines];
			while (out.length > 0 && out.at(-1)!.trim() === "") out.pop();
			if (out.length > 0) out.push("");
			out.push(`[${table}]`, `${leaf} = ${literal}`);
		}
	}
	return joinLines(out, eol);
}

/** Remove a key; undefined when it is not set in this text. */
export function unsetKey(text: string, key: SettingKey): string | undefined {
	const { lines, eol, entries } = layout(text);
	const match = entries.find((entry) => entry.name === key);
	if (!match) return undefined;
	return joinLines(splice(lines, match.start, match.end - match.start + 1, []), eol);
}

function readKey(text: string, key: SettingKey): unknown {
	let node: unknown = parseToml(text);
	for (const part of key.split(".")) {
		if (typeof node !== "object" || node === null) return undefined;
		node = (node as Record<string, unknown>)[part];
	}
	return node;
}

function sameValue(actual: unknown, expected: unknown): boolean {
	return JSON.stringify(actual) === JSON.stringify(expected);
}

function splitKey(key: SettingKey): [table: string, leaf: string] {
	const dot = key.lastIndexOf(".");
	return dot === -1 ? ["", key] : [key.slice(0, dot), key.slice(dot + 1)];
}

/** Canonical dotted form of a TOML key or table name, resolving quotes and whitespace. */
function canonicalKey(text: string, kind: "key" | "header"): string {
	try {
		let node = parseToml(kind === "key" ? `${text} = 0` : `[${text}]`) as Record<string, unknown>;
		const parts: string[] = [];
		for (;;) {
			const keys = Object.keys(node);
			if (keys.length !== 1) break;
			parts.push(keys[0]!);
			const child = node[keys[0]!];
			if (typeof child !== "object" || child === null || Array.isArray(child)) break;
			node = child as Record<string, unknown>;
		}
		return parts.join(".");
	} catch {
		return text.trim();
	}
}

/** The comment after a single-line value: the first `#` whose prefix is a complete entry. */
function trailingComment(line: string): string {
	for (let k = line.indexOf("#"); k !== -1; k = line.indexOf("#", k + 1)) {
		if (parses(line.slice(0, k))) return line.slice(line.slice(0, k).trimEnd().length);
	}
	return "";
}

function parses(text: string): boolean {
	try {
		parseToml(text);
		return true;
	} catch {
		return false;
	}
}

function splice(lines: readonly string[], at: number, remove: number, insert: readonly string[]): string[] {
	return [...lines.slice(0, at), ...insert, ...lines.slice(at + remove)];
}

function joinLines(lines: readonly string[], eol: string): string {
	return lines.length === 0 ? "" : `${lines.join(eol)}${eol}`;
}

function firstLine(message: string): string {
	return message.split("\n")[0] ?? message;
}
