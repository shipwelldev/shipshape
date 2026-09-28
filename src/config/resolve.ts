import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { parse as parseToml, TomlError } from "smol-toml";
import { globalConfigDir, globalConfigPath, PROJECT_CONFIG_FILE } from "./paths.js";
import {
	type DefaultContext,
	type Layer,
	SETTINGS,
	SETTINGS_BY_KEY,
	type SettingKey,
	SettingError,
	type ShipshapeConfig,
	type Source,
} from "./schema.js";

/** Actionable configuration failure; carries every problem found, not just the first. */
export class ConfigError extends Error {
	constructor(readonly problems: string[]) {
		super(problems.length === 1 ? problems[0] : `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
	}
}

export interface LayerValues {
	layer: Layer;
	/** Config file for file layers; used for provenance and error messages. */
	path?: string;
	values: Map<SettingKey, unknown>;
}

export interface ResolvedConfig {
	config: ShipshapeConfig;
	sources: Record<SettingKey, Source>;
}

/** Raw CLI values keyed by setting, plus the flag name each came from (for error messages). */
export type CliSettings = Map<SettingKey, { raw: unknown; flag: string }>;

export interface LoadConfigOptions {
	cli: CliSettings;
	/** Directory the command was invoked from; CLI paths resolve against it. */
	invocationDir: string;
	/** Project root (Git top level or the selected directory); undefined skips the project layer. */
	projectRoot: string | undefined;
	/** `--config PATH`, already resolved against the invocation directory. Replaces the project file. */
	projectConfigOverride?: string;
	env?: Record<string, string | undefined>;
}

export async function loadConfig(options: LoadConfigOptions): Promise<ResolvedConfig> {
	const env = options.env ?? process.env;
	const problems: string[] = [];
	const layers: LayerValues[] = [];

	layers.push(parseCliLayer(options.cli, options.invocationDir, problems));

	const projectPath =
		options.projectConfigOverride ?? (options.projectRoot ? join(options.projectRoot, PROJECT_CONFIG_FILE) : undefined);
	if (projectPath) {
		const project = await loadConfigFile(projectPath, "project", options.projectConfigOverride !== undefined, problems);
		if (project) layers.push(project);
	}

	const global = await loadConfigFile(globalConfigPath(env), "global", false, problems);
	if (global) layers.push(global);

	if (problems.length > 0) throw new ConfigError(problems);
	return resolveLayers(layers, { globalConfigDir: globalConfigDir(env) });
}

/**
 * Apply precedence per leaf setting: the first layer (CLI, project, global) that
 * supplies a key wins; otherwise the built-in default applies. Lists are replaced,
 * never merged, so an empty list clears an inherited one.
 */
export function resolveLayers(layers: readonly LayerValues[], defaults: DefaultContext): ResolvedConfig {
	const flat = new Map<SettingKey, unknown>();
	const sources = {} as Record<SettingKey, Source>;
	for (const def of SETTINGS) {
		const layer = layers.find((candidate) => candidate.values.has(def.key));
		if (layer) {
			flat.set(def.key, layer.values.get(def.key));
			sources[def.key] = layer.path ? { kind: layer.layer, path: layer.path } : { kind: layer.layer };
		} else {
			flat.set(def.key, def.default(defaults));
			sources[def.key] = { kind: "default" };
		}
	}
	const get = <T>(key: SettingKey) => flat.get(key) as T;
	const config: ShipshapeConfig = {
		model: get("model"),
		thinking: get("thinking"),
		format: get("format"),
		auth_file: get("auth_file"),
		review: {
			fail_on: get("review.fail_on"),
			timeout_seconds: get("review.timeout_seconds"),
			exclude: get("review.exclude"),
			instructions: get("review.instructions"),
			focus_file: get("review.focus_file"),
			standards_files: get("review.standards_files"),
		},
	};
	return { config, sources };
}

function parseCliLayer(cli: CliSettings, invocationDir: string, problems: string[]): LayerValues {
	const values = new Map<SettingKey, unknown>();
	for (const [key, { raw, flag }] of cli) {
		const def = SETTINGS_BY_KEY.get(key);
		if (!def) continue;
		try {
			values.set(key, def.parse(raw, { baseDir: invocationDir }));
		} catch (error) {
			if (!(error instanceof SettingError)) throw error;
			problems.push(`${flag}: ${error.message}`);
		}
	}
	return { layer: "cli", values };
}

/** Load and validate one TOML file. A missing file is only an error when it was explicitly requested. */
export async function loadConfigFile(
	path: string,
	layer: "project" | "global",
	required: boolean,
	problems: string[],
): Promise<LayerValues | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !required) return undefined;
		problems.push(`${path}: cannot read configuration: ${(error as Error).message}`);
		return undefined;
	}
	return validateConfigText(text, path, layer, required, problems);
}

/**
 * Parse and validate configuration text as if it were the file at `path`. `explicit` marks
 * a file the caller chose (--config) rather than one discovered in the repository.
 */
export async function validateConfigText(
	text: string,
	path: string,
	layer: "project" | "global",
	explicit: boolean,
	problems: string[],
): Promise<LayerValues | undefined> {
	let document: Record<string, unknown>;
	try {
		document = parseToml(text) as Record<string, unknown>;
	} catch (error) {
		const detail = error instanceof TomlError ? `line ${error.line}, column ${error.column}: ${firstLine(error.message)}` : String(error);
		problems.push(`${path}: invalid TOML at ${detail}`);
		return undefined;
	}

	const values = new Map<SettingKey, unknown>();
	const ctx = { baseDir: dirname(path) };
	const visit = (table: Record<string, unknown>, prefix: string) => {
		for (const [name, raw] of Object.entries(table)) {
			const key = prefix + name;
			if (key === "review") {
				if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
					problems.push(`${path}: review: expected a [review] table`);
				} else {
					visit(raw as Record<string, unknown>, "review.");
				}
				continue;
			}
			const def = SETTINGS_BY_KEY.get(key);
			if (!def) {
				problems.push(`${path}: unknown setting "${key}". Known settings: ${SETTINGS.map((s) => s.key).join(", ")}`);
				continue;
			}
			if (!def.layers.includes(layer)) {
				problems.push(
					`${path}: "${key}" cannot be set in ${layer} configuration; set it in the ${def.layers
						.filter((l) => l !== "cli")
						.join(" or ")} config file or pass it on the command line`,
				);
				continue;
			}
			try {
				values.set(def.key, def.parse(raw, ctx));
			} catch (error) {
				if (!(error instanceof SettingError)) throw error;
				problems.push(`${path}: ${key}: ${error.message}`);
			}
		}
	};
	visit(document, "");

	// A discovered .shipshape.toml is repository content. Its focus file is sent to the model
	// provider, so it must really live inside the repository (symlinks included). An explicit
	// --config file is trusted by whoever passed it and may point anywhere.
	const focusFile = values.get("review.focus_file");
	if (layer === "project" && !explicit && typeof focusFile === "string") {
		const problem = await containmentProblem(focusFile, dirname(path));
		if (problem) problems.push(`${path}: review.focus_file: ${problem}`);
	}
	return { layer, path, values };
}

async function containmentProblem(file: string, root: string): Promise<string | undefined> {
	const [realFile, realRoot] = await Promise.all([realpath(file).catch(() => undefined), realpath(root)]);
	if (!realFile) return `${file} does not exist`;
	const rel = relative(realRoot, realFile);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		return `${file} resolves outside the project; use --config to select a trusted configuration that points elsewhere`;
	}
	return undefined;
}

function firstLine(message: string): string {
	return message.split("\n")[0] ?? message;
}
