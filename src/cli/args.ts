import { parseArgs } from "node:util";
import type { CliSettings } from "../config/resolve.js";
import { FORMATS, type OutputFormat, type SettingKey } from "../config/schema.js";
import type { TargetKind } from "../target/resolve.js";

export class UsageError extends Error {}

interface SettingFlag {
	key: SettingKey;
	multiple?: boolean;
	convert?: (raw: string) => unknown;
}

/** Flags that override configuration settings. None has a parser default: absent means inherit. */
const SETTING_FLAGS: Record<string, SettingFlag> = {
	model: { key: "model" },
	thinking: { key: "thinking" },
	format: { key: "format" },
	"auth-file": { key: "auth_file" },
	"fail-on": { key: "review.fail_on" },
	timeout: { key: "review.timeout_seconds", convert: (raw) => (/^\d+$/.test(raw) ? Number(raw) : raw) },
	exclude: { key: "review.exclude", multiple: true },
	instructions: { key: "review.instructions" },
	"focus-file": { key: "review.focus_file" },
};

type OptionSpec = { type: "string" | "boolean"; multiple?: boolean; short?: string };

const settingOptions: Record<string, OptionSpec> = Object.fromEntries(
	Object.entries(SETTING_FLAGS).map(([name, flag]) => [name, { type: "string", ...(flag.multiple ? { multiple: true } : {}) }]),
);

const common = {
	help: { type: "boolean", short: "h" },
	"non-interactive": { type: "boolean" },
} satisfies Record<string, OptionSpec>;

const projectOptions = {
	config: { type: "string" },
	cwd: { type: "string", short: "C" },
} satisfies Record<string, OptionSpec>;

export type Command =
	| { name: "help"; topic?: string }
	| { name: "version" }
	| {
			name: "review";
			kind: TargetKind;
			base?: string;
			head?: string;
			cwd?: string;
			config?: string;
			settings: CliSettings;
			format?: OutputFormat;
			nonInteractive: boolean;
	  }
	| { name: "config-show"; sources: boolean; cwd?: string; config?: string; settings: CliSettings }
	| ConfigEditCommand<"config-set">
	| ConfigEditCommand<"config-unset">
	| AuthCommand<"login">
	| AuthCommand<"logout">;

export interface ConfigEditCommand<Name extends "config-set" | "config-unset"> {
	name: Name;
	key: string;
	/** Values for `config set` (several for list settings). */
	values: string[];
	scope: "global" | "project";
	cwd?: string;
	config?: string;
}

interface AuthCommand<Name extends "login" | "logout"> {
	name: Name;
	provider?: string;
	settings: CliSettings;
	nonInteractive: boolean;
}

export function parseCommand(argv: readonly string[]): Command {
	const [first, ...rest] = argv;
	if (first === undefined || first === "help" || first === "--help" || first === "-h") {
		return { name: "help", topic: first === "help" ? rest[0] : undefined };
	}
	if (first === "--version" || first === "-V" || first === "version") return { name: "version" };

	switch (first) {
		case "review":
			return parseReview(rest);
		case "config": {
			const [sub, ...configArgs] = rest;
			if (sub === "show") return parseConfigShow(configArgs);
			if (sub === "set" || sub === "unset") return parseConfigEdit(sub, configArgs);
			if (sub === undefined || sub === "--help" || sub === "-h") return { name: "help", topic: "config" };
			throw new UsageError(`Unknown config subcommand "${sub}". Use show, set, or unset.`);
		}
		case "login":
		case "logout":
			return parseAuth(first, rest);
		default:
			throw new UsageError(`Unknown command "${first}". Run "shipshape --help" for usage.`);
	}
}

function parseReview(args: string[]): Command {
	const { values } = parse(args, {
		...settingOptions,
		...common,
		...projectOptions,
		staged: { type: "boolean" },
		base: { type: "string" },
		head: { type: "string" },
		all: { type: "boolean" },
	});
	if (values.help) return { name: "help", topic: "review" };

	const modes = [values.staged && "--staged", values.base !== undefined && "--base", values.all && "--all"].filter(Boolean);
	if (modes.length > 1) throw new UsageError(`${modes.join(" and ")} cannot be combined; choose one review target.`);
	if (values.head !== undefined && values.base === undefined) {
		throw new UsageError("--head requires --base.");
	}
	const kind: TargetKind = values.staged ? "staged" : values.base !== undefined ? "branch" : values.all ? "all" : "worktree";
	const format = values.format as string | undefined;
	return {
		name: "review",
		kind,
		base: values.base as string | undefined,
		head: values.head as string | undefined,
		cwd: values.cwd as string | undefined,
		config: values.config as string | undefined,
		settings: collectSettings(values),
		...(format && (FORMATS as readonly string[]).includes(format) ? { format: format as OutputFormat } : {}),
		nonInteractive: values["non-interactive"] === true,
	};
}

function parseConfigShow(args: string[]): Command {
	const { values } = parse(args, { ...settingOptions, ...common, ...projectOptions, sources: { type: "boolean" } });
	if (values.help) return { name: "help", topic: "config" };
	return {
		name: "config-show",
		sources: values.sources === true,
		cwd: values.cwd as string | undefined,
		config: values.config as string | undefined,
		settings: collectSettings(values),
	};
}

function parseConfigEdit(sub: "set" | "unset", args: string[]): Command {
	const { values, positionals } = parse(
		args,
		{ ...common, ...projectOptions, global: { type: "boolean" }, project: { type: "boolean" } },
		true,
	);
	if (values.help) return { name: "help", topic: "config" };
	if (values.global && values.project) throw new UsageError("Choose one of --global or --project.");
	if (!values.global && !values.project) {
		throw new UsageError(`Choose where to ${sub} the value: --global (your user config) or --project (.shipshape.toml).`);
	}
	if (values.config !== undefined && !values.project) throw new UsageError("--config selects a project file; use it with --project.");
	const [key, ...rest] = positionals;
	if (key === undefined) throw new UsageError(`Usage: shipshape config ${sub} KEY${sub === "set" ? " VALUE..." : ""} --global|--project`);
	if (sub === "unset" && rest.length > 0) throw new UsageError("config unset takes only a key.");
	return {
		name: sub === "set" ? "config-set" : "config-unset",
		key,
		values: rest,
		scope: values.global ? "global" : "project",
		cwd: values.cwd as string | undefined,
		config: values.config as string | undefined,
	};
}

function parseAuth(name: "login" | "logout", args: string[]): Command {
	const { values, positionals } = parse(args, { "auth-file": { type: "string" }, ...common }, true);
	if (values.help) return { name: "help", topic: name };
	if (positionals.length > 1) throw new UsageError(`shipshape ${name} takes at most one provider.`);
	return {
		name: name === "login" ? "login" : "logout",
		provider: positionals[0],
		settings: collectSettings(values),
		nonInteractive: values["non-interactive"] === true,
	};
}

function parse(args: string[], options: Record<string, OptionSpec>, allowPositionals = false) {
	try {
		return parseArgs({ args, options, strict: true, allowPositionals });
	} catch (error) {
		throw new UsageError((error as Error).message);
	}
}

/** Keep only setting flags that were actually supplied, preserving provenance for each. */
function collectSettings(values: Record<string, unknown>): CliSettings {
	const settings: CliSettings = new Map();
	for (const [name, flag] of Object.entries(SETTING_FLAGS)) {
		const raw = values[name];
		if (raw === undefined) continue;
		const converted = flag.convert && typeof raw === "string" ? flag.convert(raw) : raw;
		settings.set(flag.key, { raw: converted, flag: `--${name}` });
	}
	return settings;
}
