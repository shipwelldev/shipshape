import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate every test file from the developer's machine: no real Ship Shape or Pi
// config, no provider keys from the shell, no user/system git config, no downloads.
const root = mkdtempSync(join(tmpdir(), "shipshape-test-"));
process.env.PI_CODING_AGENT_DIR = join(root, "pi");
process.env.PI_TELEMETRY = "0";
process.env.PI_OFFLINE = "1";
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_CACHE_HOME = join(root, "cache");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.com";
delete process.env.NO_COLOR;
delete process.env.FORCE_COLOR;
for (const key of Object.keys(process.env)) {
	if (/(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN|^HF_TOKEN|^COPILOT_GITHUB_TOKEN)$/.test(key)) delete process.env[key];
}
