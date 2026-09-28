import { isAbsolute } from "node:path";
import { resolveUserPath } from "./paths.js";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const FORMATS = ["text", "json"] as const;
export type OutputFormat = (typeof FORMATS)[number];

/** A configuration layer that can supply a value. Built-in defaults are not a layer. */
export type Layer = "cli" | "project" | "global";

export interface Source {
	kind: Layer | "default";
	/** Config file that supplied the value (project/global layers). */
	path?: string;
}

export interface ShipshapeConfig {
	/** Provider-qualified model selector, e.g. "anthropic/<model-id>". No default. */
	model: string | undefined;
	thinking: ThinkingLevel;
	format: OutputFormat;
	/** Absolute path of the credential file (Pi auth.json format). */
	auth_file: string;
	review: {
		fail_on: Severity;
		/** Whole-review deadline; 0 disables it. */
		timeout_seconds: number;
		exclude: string[];
		/** Appended to the built-in review instructions; empty means none. */
		instructions: string;
		/** Absolute path of a file replacing the built-in focus section; undefined means built-in. */
		focus_file: string | undefined;
		/** Repository-relative files injected as documented standards. */
		standards_files: string[];
	};
}

export type SettingKey =
	| "model"
	| "thinking"
	| "format"
	| "auth_file"
	| "review.fail_on"
	| "review.timeout_seconds"
	| "review.exclude"
	| "review.instructions"
	| "review.focus_file"
	| "review.standards_files";

export interface ParseContext {
	/** Directory that relative paths in this layer resolve against. */
	baseDir: string;
}

export interface DefaultContext {
	globalConfigDir: string;
}

/** How a value is written on the command line (`config set`) and in TOML. */
export type SettingKind = "string" | "integer" | "list";

export interface SettingDef {
	key: SettingKey;
	kind: SettingKind;
	/** Layers allowed to set this key. Setting it elsewhere is a configuration error. */
	layers: readonly Layer[];
	/** Parse and validate a raw value; throws `SettingError` with a message describing the expectation. */
	parse(raw: unknown, ctx: ParseContext): unknown;
	default(ctx: DefaultContext): unknown;
	/** Human description of the accepted values, used in errors and help. */
	expects: string;
}

export class SettingError extends Error {}

/** Largest deadline Node timers can represent (2^31 - 1 ms). */
export const MAX_TIMEOUT_SECONDS = 2_147_483;

const ALL_LAYERS: readonly Layer[] = ["cli", "project", "global"];

function enumSetting<T extends string>(key: SettingKey, values: readonly T[], fallback: T): SettingDef {
	const expects = `one of ${values.join(", ")}`;
	return {
		key,
		kind: "string",
		layers: ALL_LAYERS,
		expects,
		default: () => fallback,
		parse(raw) {
			if (typeof raw !== "string" || !(values as readonly string[]).includes(raw)) {
				throw new SettingError(`expected ${expects}; got ${describe(raw)}`);
			}
			return raw;
		},
	};
}

function stringList(raw: unknown, what: string): string[] {
	if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string" && item.length > 0)) {
		throw new SettingError(`expected a list of non-empty ${what} strings; got ${describe(raw)}`);
	}
	return [...raw];
}

export const SETTINGS: readonly SettingDef[] = [
	{
		key: "model",
		kind: "string",
		layers: ALL_LAYERS,
		expects: `a provider-qualified model such as "anthropic/<model-id>"`,
		default: () => undefined,
		parse(raw) {
			if (typeof raw !== "string" || parseModelSelector(raw) === undefined) {
				throw new SettingError(`expected a provider-qualified model such as "anthropic/<model-id>"; got ${describe(raw)}`);
			}
			return raw;
		},
	},
	enumSetting("thinking", THINKING_LEVELS, "medium"),
	enumSetting("format", FORMATS, "text"),
	{
		key: "auth_file",
		kind: "string",
		// A project file is repository content. Pi's auth format can run `!command`
		// keys, so a repository must never choose which credential file is loaded.
		layers: ["cli", "global"],
		expects: "a path to a credential file",
		default: (ctx) => `${ctx.globalConfigDir}/auth.json`,
		parse(raw, ctx) {
			if (typeof raw !== "string" || raw.length === 0) {
				throw new SettingError(`expected a non-empty path; got ${describe(raw)}`);
			}
			return resolveUserPath(raw, ctx.baseDir);
		},
	},
	enumSetting("review.fail_on", SEVERITIES, "high"),
	{
		key: "review.timeout_seconds",
		kind: "integer",
		layers: ALL_LAYERS,
		expects: "a whole number of seconds (0 disables the deadline)",
		default: () => 600,
		parse(raw) {
			const value = typeof raw === "bigint" ? Number(raw) : raw;
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_TIMEOUT_SECONDS) {
				throw new SettingError(`expected a whole number of seconds from 0 to ${MAX_TIMEOUT_SECONDS}; got ${describe(raw)}`);
			}
			return value;
		},
	},
	{
		key: "review.exclude",
		kind: "list",
		layers: ALL_LAYERS,
		expects: "a list of glob patterns",
		default: () => [],
		parse: (raw) => stringList(raw, "glob"),
	},
	{
		key: "review.instructions",
		kind: "string",
		layers: ALL_LAYERS,
		expects: "a string (empty for none)",
		default: () => "",
		parse(raw) {
			if (typeof raw !== "string") throw new SettingError(`expected a string; got ${describe(raw)}`);
			return raw;
		},
	},
	{
		key: "review.focus_file",
		kind: "string",
		layers: ALL_LAYERS,
		expects: "a path to a focus file (empty for the built-in focus)",
		default: () => undefined,
		parse(raw, ctx) {
			if (typeof raw !== "string") throw new SettingError(`expected a path; got ${describe(raw)}`);
			return raw === "" ? undefined : resolveUserPath(raw, ctx.baseDir);
		},
	},
	{
		key: "review.standards_files",
		kind: "list",
		layers: ALL_LAYERS,
		expects: "a list of repository-relative paths",
		default: () => ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"],
		parse(raw) {
			const paths = stringList(raw, "path");
			// Standards are repository files; anything else could send arbitrary local files to the provider.
			const escaping = paths.find((path) => isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.split(/[\\/]/).includes(".."));
			if (escaping) throw new SettingError(`expected paths inside the repository; got ${JSON.stringify(escaping)}`);
			return paths;
		},
	},
];

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((def) => [def.key, def]));

export interface ModelSelector {
	provider: string;
	id: string;
}

/** Split "provider/id" at the first slash; model ids may themselves contain slashes. */
export function parseModelSelector(value: string): ModelSelector | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function severityRank(severity: Severity): number {
	return SEVERITIES.length - SEVERITIES.indexOf(severity);
}

function describe(value: unknown): string {
	if (value === undefined) return "nothing";
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return "a list";
	if (typeof value === "object" && value !== null) return "a table";
	return String(value);
}
