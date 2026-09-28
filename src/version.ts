import { readFileSync } from "node:fs";

// Release binaries are built by scripts/build-binary.ts, which injects these with
// `bun build --define`. Runs from source leave them undefined.
declare const SHIPSHAPE_BUILD_VERSION: string | undefined;
declare const SHIPSHAPE_BUILD_TARGET: string | undefined;

function packageVersion(): string {
	// src/version.ts and dist/version.js both sit one level below package.json.
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
	return pkg.version;
}

export const VERSION = typeof SHIPSHAPE_BUILD_VERSION === "string" ? SHIPSHAPE_BUILD_VERSION : packageVersion();

/** Release target such as "linux-x64"; undefined when running from source. */
export const BUILD_TARGET = typeof SHIPSHAPE_BUILD_TARGET === "string" ? SHIPSHAPE_BUILD_TARGET : undefined;
