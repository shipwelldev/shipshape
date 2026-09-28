import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { piStateDir } from "../config/paths.js";
import { type ModelSelector, type ThinkingLevel } from "../config/schema.js";

export type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** Pi's read-only inspection tools. Shell and edit tools are never enabled. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface ModelRuntimeOptions {
	/** Credential file in Pi's auth.json format. */
	authFile: string;
	/** Optional Pi models.json for custom providers/models. */
	modelsFile?: string;
	/** Create the credential file when missing (login). Reviews never create it. */
	createAuthFile?: boolean;
}

export type ModelRuntimeFactory = (options: ModelRuntimeOptions) => Promise<ModelRuntime>;

export const createModelRuntime: ModelRuntimeFactory = async (options) => {
	const common = {
		modelsPath: options.modelsFile ?? null,
		// Pi would otherwise put its catalog cache next to models.json, in the config directory.
		modelsStorePath: join(piStateDir(), "models-store.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	};
	if (options.createAuthFile) {
		await mkdir(dirname(options.authFile), { recursive: true, mode: 0o700 });
		return ModelRuntime.create({ ...common, authPath: options.authFile });
	}
	if (await exists(options.authFile)) {
		return ModelRuntime.create({ ...common, authPath: options.authFile });
	}
	// No credential file: environment variables and ambient cloud credentials still apply.
	return ModelRuntime.create({ ...common, credentials: new InMemoryCredentialStore() });
};

export class SetupError extends Error {
	constructor(
		readonly reason: "model_error" | "auth_error",
		message: string,
	) {
		super(message);
	}
}

export function findModel(runtime: ModelRuntime, selector: ModelSelector): PiModel {
	const model = runtime.getModel(selector.provider, selector.id);
	if (model) return model;
	if (!runtime.getProvider(selector.provider)) {
		const known = runtime
			.getProviders()
			.map((p) => p.id)
			.sort();
		throw new SetupError("model_error", `Unknown provider "${selector.provider}". Known providers: ${known.join(", ")}.`);
	}
	const ids = runtime.getModels(selector.provider).map((m) => m.id);
	const shown = ids.slice(0, 25).join(", ");
	throw new SetupError(
		"model_error",
		`Unknown model "${selector.id}" for provider "${selector.provider}". Known models: ${shown}${ids.length > 25 ? `, and ${ids.length - 25} more` : ""}.`,
	);
}

export interface AuthInfo {
	/** Signed in with a provider subscription (OAuth), so per-token prices do not reflect what is paid. */
	subscription: boolean;
}

/** Fail before starting a session when the provider has no usable credentials. */
export async function ensureAuth(runtime: ModelRuntime, provider: string, authFile: string): Promise<AuthInfo> {
	const check = await runtime.checkAuth(provider);
	if (check || runtime.hasConfiguredAuth(provider)) {
		// Derived here because the runtime's own subscription flag is only filled by an availability refresh.
		return { subscription: check?.type === "oauth" && runtime.getProvider(provider)?.auth?.oauth?.isSubscription === true };
	}
	throw new SetupError(
		"auth_error",
		`No credentials for provider "${provider}". Set the provider's API key environment variable (for example ANTHROPIC_API_KEY or OPENAI_API_KEY), or run "shipshape login ${provider}" to store credentials in ${authFile}.`,
	);
}

export interface ReviewSessionOptions {
	workspace: string;
	agentDir: string;
	runtime: ModelRuntime;
	model: PiModel;
	thinking: ThinkingLevel;
	systemPrompt: string;
	customTools: ToolDefinition[];
}

/**
 * A fresh in-memory session with nothing discovered from disk: no extensions, skills,
 * prompt templates, context files, or Pi settings. Everything the reviewer sees is
 * supplied by Ship Shape.
 */
export async function createReviewSession(options: ReviewSessionOptions): Promise<AgentSession> {
	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => options.systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true },
		retry: { enabled: true, maxRetries: 3 },
		enableInstallTelemetry: false,
		enableAnalytics: false,
		cacheWarming: "off",
		quietStartup: true,
	});
	const { session } = await createAgentSession({
		cwd: options.workspace,
		agentDir: options.agentDir,
		modelRuntime: options.runtime,
		model: options.model,
		thinkingLevel: options.thinking,
		tools: [...READ_ONLY_TOOLS, ...options.customTools.map((tool) => tool.name)],
		customTools: options.customTools,
		resourceLoader,
		sessionManager: SessionManager.inMemory(options.workspace),
		settingsManager,
	});
	return session;
}

export function modelsFilePath(globalConfigDir: string): string {
	return join(globalConfigDir, "models.json");
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
