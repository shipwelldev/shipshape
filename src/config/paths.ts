import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

/** Platform user configuration directory, mirroring Go's os.UserConfigDir. */
export function userConfigDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return env.APPDATA ?? join(homedir(), "AppData", "Roaming");
	if (platform === "darwin") return join(homedir(), "Library", "Application Support");
	const xdg = env.XDG_CONFIG_HOME;
	return xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config");
}

/** Platform user cache directory, mirroring Go's os.UserCacheDir. */
export function userCacheDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
	if (platform === "darwin") return join(homedir(), "Library", "Caches");
	const xdg = env.XDG_CACHE_HOME;
	return xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache");
}

export function globalConfigDir(env: Env = process.env): string {
	return join(userConfigDir(env), "shipshape");
}

export function globalConfigPath(env: Env = process.env): string {
	return join(globalConfigDir(env), "config.toml");
}

/**
 * Directory handed to Pi as its agent directory. Pi downloads managed `rg`/`fd`
 * binaries and writes caches here; keeping it separate means Ship Shape never
 * reads or writes a user's ~/.pi installation implicitly.
 */
export function piStateDir(env: Env = process.env): string {
	return join(userCacheDir(env), "shipshape", "pi");
}

export const PROJECT_CONFIG_FILE = ".shipshape.toml";

/** Expand a leading `~/` and resolve relative paths against `baseDir`. */
export function resolveUserPath(path: string, baseDir: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return resolve(baseDir, path);
}
