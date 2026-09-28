import { readFileSync } from "node:fs";

// src/version.ts and dist/version.js both sit one level below package.json.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export const VERSION = pkg.version;
