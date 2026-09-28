import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { globalConfigDir, globalConfigPath, PROJECT_CONFIG_FILE } from "../config/paths.js";
import { editSetting, tomlLiteral, valueFromArgs } from "../config/edit.js";
import { type CliSettings, ConfigError, loadConfig } from "../config/resolve.js";
import {
	SETTINGS,
	SETTINGS_BY_KEY,
	SettingError,
	type SettingKey,
	type ShipshapeConfig,
	type Source,
} from "../config/schema.js";
import { colored, plain, renderJson, renderText, type Styler } from "../report/render.js";
import type { CancelSignal } from "../review/policy.js";
import { review, type ReviewProgress } from "../review/review.js";
import { createModelRuntime, type ModelRuntimeFactory, modelsFilePath } from "../runtime/pi.js";
import { GitError } from "../target/git.js";
import { locateProject, TargetError } from "../target/resolve.js";
import { DEFAULT_RELEASES_URL, runUpdate, UpdateError } from "../update.js";
import { BUILD_TARGET, VERSION } from "../version.js";
import { type Command, type ConfigEditCommand, parseCommand, UsageError } from "./args.js";
import { helpText } from "./help.js";

export interface Output {
	write(text: string): void;
	isTTY?: boolean;
}

export interface Prompter {
	ask(message: string, options?: { secret?: boolean; signal?: AbortSignal }): Promise<string>;
	close(): void;
}

export interface CliContext {
	cwd: string;
	env: Record<string, string | undefined>;
	stdout: Output;
	stderr: Output;
	/** Whether a person can answer prompts (stdin and stderr are terminals). */
	interactive: boolean;
	createPrompter(): Prompter;
	signal: AbortSignal;
	cancelSignal(): CancelSignal | undefined;
	createModelRuntime?: ModelRuntimeFactory;
	/** Test overrides for the self-update identity; an explicit undefined buildTarget means "running from source". */
	version?: string;
	buildTarget?: string;
	executable?: string;
}

export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
	let command: Command;
	try {
		command = parseCommand(argv);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		ctx.stderr.write(`shipshape: ${error.message}\n`);
		return 2;
	}
	switch (command.name) {
		case "help":
			ctx.stdout.write(helpText(command.topic));
			return 0;
		case "version":
			ctx.stdout.write(`${VERSION}\n`);
			return 0;
		case "review":
			return reviewCommand(command, ctx);
		case "config-show":
			return configShowCommand(command, ctx);
		case "config-set":
		case "config-unset":
			return configEditCommand(command, ctx);
		case "login":
			return loginCommand(command, ctx);
		case "logout":
			return logoutCommand(command, ctx);
		case "update":
			return updateCommand(command, ctx);
	}
}

async function reviewCommand(command: Extract<Command, { name: "review" }>, ctx: CliContext): Promise<number> {
	const errStyle = styler(ctx.stderr, ctx.env);
	const { result, format } = await review({
		kind: command.kind,
		base: command.base,
		head: command.head,
		dir: resolve(ctx.cwd, command.cwd ?? "."),
		cli: command.settings,
		invocationDir: ctx.cwd,
		configOverride: command.config === undefined ? undefined : resolve(ctx.cwd, command.config),
		env: ctx.env,
		signal: ctx.signal,
		cancelSignal: ctx.cancelSignal,
		cliFormat: command.format,
		onProgress: (event) => ctx.stderr.write(describeProgress(event, errStyle)),
		createModelRuntime: ctx.createModelRuntime,
	});
	if (format === "json") {
		ctx.stdout.write(renderJson(result));
		const detail = result.problem ? `: ${result.problem.message}` : "";
		ctx.stderr.write(`shipshape: ${result.status}${detail}\n`);
	} else {
		ctx.stdout.write(renderText(result, styler(ctx.stdout, ctx.env)));
	}
	return result.exit_code;
}

function describeProgress(event: ReviewProgress, style: Styler): string {
	switch (event.type) {
		case "start":
			return `${style("bold", "shipshape:")} reviewing ${event.description} · ${event.files} file(s) · ${event.model}\n`;
		case "no_changes":
			return `${style("bold", "shipshape:")} nothing to review in ${event.description}\n`;
		case "tool":
			return style("dim", `  ${event.name} ${event.detail}`.trimEnd()) + "\n";
		case "tool_error":
			return style("dim", `  ${event.name} failed: ${event.message}`) + "\n";
		case "retry":
			return style("yellow", `  provider error, retrying (${event.attempt}/${event.maxAttempts}): ${event.message}`) + "\n";
		case "compaction":
			return style("dim", "  compacting conversation context") + "\n";
		case "repair":
			return style("yellow", `  ${event.message}`) + "\n";
	}
}

async function configShowCommand(command: Extract<Command, { name: "config-show" }>, ctx: CliContext): Promise<number> {
	try {
		const project = await locateProject(resolve(ctx.cwd, command.cwd ?? "."));
		const configOverride = command.config === undefined ? undefined : resolve(ctx.cwd, command.config);
		const { config, sources } = await loadConfig({
			cli: command.settings,
			invocationDir: ctx.cwd,
			projectRoot: project.root,
			projectConfigOverride: configOverride,
			env: ctx.env,
		});
		const lines: string[] = [];
		if (command.sources) {
			const projectFile = configOverride ?? resolve(project.root, PROJECT_CONFIG_FILE);
			const globalFile = globalConfigPath(ctx.env);
			lines.push(`# project config: ${projectFile}${(await exists(projectFile)) ? "" : " (not found)"}`);
			lines.push(`# global config:  ${globalFile}${(await exists(globalFile)) ? "" : " (not found)"}`, "");
		}
		lines.push(...formatConfig(config, sources, command.sources));
		ctx.stdout.write(`${lines.join("\n")}\n`);
		return 0;
	} catch (error) {
		if (error instanceof ConfigError || error instanceof GitError || error instanceof TargetError) {
			ctx.stderr.write(`shipshape: ${error.message}\n`);
			return 2;
		}
		throw error;
	}
}

function settingValues(config: ShipshapeConfig): Record<SettingKey, unknown> {
	return {
		model: config.model,
		thinking: config.thinking,
		format: config.format,
		auth_file: config.auth_file,
		"review.fail_on": config.review.fail_on,
		"review.timeout_seconds": config.review.timeout_seconds,
		"review.exclude": config.review.exclude,
		"review.instructions": config.review.instructions,
		"review.focus_file": config.review.focus_file,
		"review.standards_files": config.review.standards_files,
	};
}

function formatConfig(config: ShipshapeConfig, sources: Record<SettingKey, Source>, withSources: boolean): string[] {
	const values = settingValues(config);
	const unsetNotes: Partial<Record<SettingKey, string>> = {
		model: "(not set; required for reviews)",
		"review.focus_file": "(built-in focus)",
	};
	const rows: Array<[string, string, SettingKey] | [string]> = [];
	let inReview = false;
	for (const def of SETTINGS) {
		const name = def.key.startsWith("review.") ? def.key.slice("review.".length) : def.key;
		if (def.key.startsWith("review.") && !inReview) {
			rows.push([""], ["[review]"]);
			inReview = true;
		}
		const value = values[def.key];
		const text = value === undefined ? `# ${name} = ${unsetNotes[def.key] ?? "(not set)"}` : `${name} = ${JSON.stringify(value)}`;
		rows.push([text, describeSource(sources[def.key]), def.key]);
	}
	const width = Math.min(44, Math.max(...rows.map((row) => row[0].length)));
	return rows.map((row) => (withSources && row.length === 3 ? `${row[0].padEnd(width)}  # ${row[1]}` : row[0]));
}

async function configEditCommand(
	command: ConfigEditCommand<"config-set"> | ConfigEditCommand<"config-unset">,
	ctx: CliContext,
): Promise<number> {
	const def = SETTINGS_BY_KEY.get(command.key);
	if (!def) {
		ctx.stderr.write(`shipshape: unknown setting "${command.key}". Known settings: ${SETTINGS.map((s) => s.key).join(", ")}\n`);
		return 2;
	}
	const key = def.key;
	try {
		const selectedDir = resolve(ctx.cwd, command.cwd ?? ".");
		const project =
			command.scope === "project" ? await locateProject(selectedDir) : await locateProject(selectedDir).catch(() => undefined);
		const explicit = command.config !== undefined;
		const path =
			command.scope === "global"
				? globalConfigPath(ctx.env)
				: explicit
					? resolve(ctx.cwd, command.config!)
					: join(project!.root, PROJECT_CONFIG_FILE);
		const value = command.name === "config-set" ? valueFromArgs(def, command.values) : undefined;
		const { changed } = await editSetting({ path, layer: command.scope, explicit, key, value });

		if (command.name === "config-set") {
			const literal = tomlLiteral(value);
			ctx.stdout.write(changed ? `Set ${key} = ${literal} in ${path}\n` : `${key} is already ${literal} in ${path}\n`);
		} else {
			ctx.stdout.write(changed ? `Removed ${key} from ${path}\n` : `${key} is not set in ${path}\n`);
		}

		// Say so when another layer, not the file just edited, decides the effective value.
		const effective = await loadConfig({
			cli: new Map(),
			invocationDir: ctx.cwd,
			projectRoot: project?.root,
			projectConfigOverride: command.scope === "project" && explicit ? path : undefined,
			env: ctx.env,
		}).catch(() => undefined);
		const source = effective?.sources[key];
		if (effective && source && source.path !== path) {
			const current = settingValues(effective.config)[key];
			const shown = current === undefined ? "(not set)" : JSON.stringify(current);
			ctx.stderr.write(
				command.name === "config-set"
					? `Note: the effective ${key} is ${shown}, from ${describeSource(source)}, which takes precedence.\n`
					: `${key} now resolves to ${shown} (${describeSource(source)}).\n`,
			);
		}
		return 0;
	} catch (error) {
		if (error instanceof SettingError) {
			ctx.stderr.write(`shipshape: ${key}: ${error.message}\n`);
			return 2;
		}
		if (error instanceof ConfigError || error instanceof TargetError || error instanceof GitError) {
			ctx.stderr.write(`shipshape: ${error.message}\n`);
			return 2;
		}
		throw error;
	}
}

function describeSource(source: Source): string {
	if (source.kind === "cli") return "command line";
	if (source.kind === "default") return "default";
	return `${source.kind}: ${source.path}`;
}

async function loginCommand(command: Extract<Command, { name: "login" }>, ctx: CliContext): Promise<number> {
	if (!ctx.interactive || command.nonInteractive) {
		ctx.stderr.write(
			"shipshape: login needs an interactive terminal. In CI or scripts, set the provider's API key environment variable instead.\n",
		);
		return 2;
	}
	const authFile = await resolveAuthFile(command.settings, ctx);
	if (authFile === undefined) return 2;
	const runtime = await (ctx.createModelRuntime ?? createModelRuntime)({
		authFile,
		modelsFile: modelsFilePath(globalConfigDir(ctx.env)),
		createAuthFile: true,
	});
	const prompter = ctx.createPrompter();
	try {
		const loginable = runtime
			.getProviders()
			.filter((provider) => provider.auth?.oauth || provider.auth?.apiKey?.login)
			.sort((a, b) => a.id.localeCompare(b.id));
		const providerId =
			command.provider ??
			(await choose(
				prompter,
				ctx.stderr,
				"Provider",
				loginable.map((p) => ({ id: p.id, label: p.id })),
				ctx.signal,
			));
		const provider = runtime.getProvider(providerId);
		if (!provider) {
			ctx.stderr.write(`shipshape: unknown provider "${providerId}". Providers: ${loginable.map((p) => p.id).join(", ")}\n`);
			return 2;
		}
		const methods: Array<{ id: "oauth" | "api_key"; label: string }> = [];
		if (provider.auth?.oauth) methods.push({ id: "oauth", label: provider.auth.oauth.loginLabel ?? `Sign in (${provider.auth.oauth.name})` });
		if (provider.auth?.apiKey?.login) methods.push({ id: "api_key", label: `Enter an API key (${provider.auth.apiKey.name})` });
		if (methods.length === 0) {
			ctx.stderr.write(
				`shipshape: "${providerId}" has no interactive login; it uses environment or cloud credentials. See the provider's documentation.\n`,
			);
			return 2;
		}
		const method =
			methods.length === 1 ? methods[0]!.id : ((await choose(prompter, ctx.stderr, "Method", methods, ctx.signal)) as "oauth" | "api_key");
		await runtime.login(providerId, method, authInteraction(prompter, ctx));
		ctx.stderr.write(`Saved ${method === "oauth" ? "OAuth" : "API key"} credentials for ${providerId} to ${authFile}\n`);
		return 0;
	} catch (error) {
		if (ctx.signal.aborted) return cancelledExit(ctx);
		ctx.stderr.write(`shipshape: login failed: ${(error as Error).message}\n`);
		return 2;
	} finally {
		prompter.close();
	}
}

async function logoutCommand(command: Extract<Command, { name: "logout" }>, ctx: CliContext): Promise<number> {
	const authFile = await resolveAuthFile(command.settings, ctx);
	if (authFile === undefined) return 2;
	if (!(await exists(authFile))) {
		ctx.stderr.write(`No credentials file at ${authFile}; nothing to remove.\n`);
		return 0;
	}
	const runtime = await (ctx.createModelRuntime ?? createModelRuntime)({ authFile });
	const stored = (await runtime.listCredentials()).map((c) => c.providerId).sort();
	let providerId = command.provider;
	if (providerId === undefined) {
		if (stored.length === 0) {
			ctx.stderr.write(`No stored credentials in ${authFile}.\n`);
			return 0;
		}
		if (!ctx.interactive || command.nonInteractive) {
			ctx.stderr.write(`shipshape: specify a provider to log out. Stored: ${stored.join(", ")}\n`);
			return 2;
		}
		const prompter = ctx.createPrompter();
		try {
			providerId = await choose(prompter, ctx.stderr, "Provider", stored.map((id) => ({ id, label: id })), ctx.signal);
		} catch (error) {
			if (ctx.signal.aborted) return cancelledExit(ctx);
			ctx.stderr.write(`shipshape: logout failed: ${(error as Error).message}\n`);
			return 2;
		} finally {
			prompter.close();
		}
	}
	if (!stored.includes(providerId)) {
		ctx.stderr.write(`No stored credentials for ${providerId} in ${authFile}.\n`);
		return 0;
	}
	await runtime.logout(providerId);
	ctx.stderr.write(`Removed credentials for ${providerId} from ${authFile}\n`);
	return 0;
}

async function updateCommand(command: Extract<Command, { name: "update" }>, ctx: CliContext): Promise<number> {
	try {
		const outcome = await runUpdate({
			checkOnly: command.checkOnly,
			currentVersion: ctx.version ?? VERSION,
			target: "buildTarget" in ctx ? ctx.buildTarget : BUILD_TARGET,
			executable: ctx.executable ?? process.execPath,
			releasesUrl: ctx.env.SHIPSHAPE_RELEASES_URL || DEFAULT_RELEASES_URL,
			log: (line) => ctx.stderr.write(`${line}\n`),
		});
		switch (outcome.status) {
			case "up_to_date": {
				// Up to date with a different version means this build is newer than the latest release.
				const ahead = outcome.current !== outcome.latest ? ` (newer than the latest release, ${outcome.latest})` : "";
				ctx.stdout.write(`shipshape ${outcome.current} is up to date${ahead}.\n`);
				return 0;
			}
			case "available":
				ctx.stdout.write(`shipshape ${outcome.latest} is available (installed: ${outcome.current}). Run "shipshape update" to install it.\n`);
				return 1;
			case "updated":
				ctx.stdout.write(`Updated shipshape ${outcome.current} -> ${outcome.latest} at ${outcome.path}\n`);
				return 0;
		}
	} catch (error) {
		if (!(error instanceof UpdateError)) throw error;
		ctx.stderr.write(`shipshape: update failed: ${error.message}\n`);
		return 2;
	}
}

/** auth_file comes only from the CLI or global config; project files are never consulted. */
async function resolveAuthFile(settings: CliSettings, ctx: CliContext): Promise<string | undefined> {
	try {
		const { config } = await loadConfig({ cli: settings, invocationDir: ctx.cwd, projectRoot: undefined, env: ctx.env });
		return config.auth_file;
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		ctx.stderr.write(`shipshape: ${error.message}\n`);
		return undefined;
	}
}

function authInteraction(prompter: Prompter, ctx: CliContext): AuthInteraction {
	return {
		signal: ctx.signal,
		prompt: (prompt: AuthPrompt) => {
			switch (prompt.type) {
				case "select":
					return choose(prompter, ctx.stderr, prompt.message, prompt.options, withCancel(ctx, prompt.signal));
				case "secret":
					return prompter.ask(prompt.message, { secret: true, signal: withCancel(ctx, prompt.signal) });
				default:
					return prompter.ask(prompt.placeholder ? `${prompt.message} (${prompt.placeholder})` : prompt.message, {
						signal: withCancel(ctx, prompt.signal),
					});
			}
		},
		notify: (event) => {
			switch (event.type) {
				case "auth_url":
					ctx.stderr.write(`Open this URL to sign in:\n  ${event.url}\n${event.instructions ? `${event.instructions}\n` : ""}`);
					break;
				case "device_code":
					ctx.stderr.write(`Go to ${event.verificationUri} and enter the code ${event.userCode}\n`);
					break;
				case "info":
					ctx.stderr.write(`${event.message}\n${(event.links ?? []).map((l) => `  ${l.label ? `${l.label}: ` : ""}${l.url}\n`).join("")}`);
					break;
				case "progress":
					ctx.stderr.write(`${event.message}\n`);
					break;
			}
		},
	};
}

/** A prompt must stop when the command is cancelled (SIGINT/SIGTERM) as well as on its own signal. */
function withCancel(ctx: CliContext, signal: AbortSignal | undefined): AbortSignal {
	return signal ? AbortSignal.any([signal, ctx.signal]) : ctx.signal;
}

function cancelledExit(ctx: CliContext): number {
	return ctx.cancelSignal() === "SIGTERM" ? 143 : 130;
}

async function choose(
	prompter: Prompter,
	out: Output,
	message: string,
	options: readonly { id: string; label: string; description?: string }[],
	signal?: AbortSignal,
): Promise<string> {
	out.write(`${message.replace(/:+\s*$/, "")}:\n`); // Pi's own prompts may already end in a colon
	options.forEach((option, index) => {
		out.write(`  ${index + 1}) ${option.label}${option.description ? ` - ${option.description}` : ""}\n`);
	});
	for (let attempt = 0; attempt < 3; attempt++) {
		const answer = (await prompter.ask(`Choose 1-${options.length}`, { signal })).trim();
		const byNumber = options[Number(answer) - 1];
		const match = /^\d+$/.test(answer) ? byNumber : options.find((option) => option.id === answer);
		if (match) return match.id;
		out.write(`"${answer}" is not one of the options.\n`);
	}
	throw new Error("no valid choice was made");
}

function styler(output: Output, env: Record<string, string | undefined>): Styler {
	if (env.NO_COLOR || env.TERM === "dumb") return plain;
	if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR === "0" ? plain : colored;
	return output.isTTY ? colored : plain;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
