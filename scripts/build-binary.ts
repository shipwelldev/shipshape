// Build one release archive: the compiled binary plus LICENSE.
//
//   bun scripts/build-binary.ts [--target linux-x64] [--version 0.1.0] [--out release]
//
// The version and target are baked into the binary (`shipshape --version`, `shipshape update`).
// Defaults: the host's target and package.json's version.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { assetName, binaryName, parseVersion } from "../src/update.js";

/**
 * Release targets and the Bun runtime each uses when cross-compiling. x64 uses Bun's baseline
 * build, which runs on CPUs without AVX2. A build for this machine's own target compiles with
 * the running Bun instead, with no runtime download; release CI installs the baseline Bun on
 * x64 runners so native builds are baseline too.
 */
const BUN_TARGETS: Record<string, string> = {
	"linux-x64": "bun-linux-x64-baseline",
	"linux-arm64": "bun-linux-arm64",
	"darwin-arm64": "bun-darwin-arm64",
	"windows-x64": "bun-windows-x64-baseline",
};

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
	options: { target: { type: "string" }, version: { type: "string" }, out: { type: "string" } },
});
const hostTarget = `${platform() === "win32" ? "windows" : platform()}-${arch()}`;
const target = values.target ?? hostTarget;
const bunTarget = BUN_TARGETS[target];
if (!bunTarget) fail(`Unknown target "${target}". Targets: ${Object.keys(BUN_TARGETS).join(", ")}`);
const version = (values.version ?? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).replace(/^v/, "");
if (!parseVersion(version)) fail(`"${version}" is not a semantic version.`);
const outDir = resolve(values.out ?? join(root, "release"));

const stage = mkdtempSync(join(tmpdir(), "shipshape-build-"));
try {
	run("npm", ["run", "build", "--silent"], { shell: platform() === "win32" });
	const binary = join(stage, binaryName(target));
	run(process.execPath, [
		"build",
		"--compile",
		"--no-compile-autoload-bunfig",
		...(target === hostTarget ? [] : [`--target=${bunTarget}`]),
		"--define",
		`SHIPSHAPE_BUILD_VERSION=${JSON.stringify(version)}`,
		"--define",
		`SHIPSHAPE_BUILD_TARGET=${JSON.stringify(target)}`,
		"dist/cli/binary.js",
		"--outfile",
		binary,
	]);
	copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));

	// A binary for this machine must report exactly the version it was built as.
	if (target === hostTarget) {
		const reported = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
		if (reported !== version) fail(`Built binary reports "${reported}", expected "${version}".`);
	}

	mkdirSync(outDir, { recursive: true });
	const archive = join(outDir, assetName(target));
	rmSync(archive, { force: true });
	if (archive.endsWith(".zip")) {
		// Windows' bundled bsdtar writes zip; elsewhere use the zip tool.
		if (platform() === "win32") {
			const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
			run(tar, ["-a", "-cf", archive, "-C", stage, binaryName(target), "LICENSE"]);
		} else {
			run("zip", ["-q", "-j", archive, binary, join(stage, "LICENSE")]);
		}
	} else {
		run("tar", ["-czf", archive, "-C", stage, binaryName(target), "LICENSE"]);
	}
	const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
	console.log(`${sha256}  ${archive}`);
} finally {
	rmSync(stage, { recursive: true, force: true });
}

function run(command: string, args: string[], options: { shell?: boolean } = {}): void {
	execFileSync(command, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"], ...options });
}

function fail(message: string): never {
	console.error(`build-binary: ${message}`);
	process.exit(1);
}
