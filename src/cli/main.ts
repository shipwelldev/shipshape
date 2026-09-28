#!/usr/bin/env node
import { piStateDir } from "../config/paths.js";

// Pi fixes its agent directory (managed rg/fd downloads, crash logs, caches) when its
// modules load, so point it at Ship Shape's own cache before anything imports Pi.
// This keeps a user's ~/.pi installation out of every review. Ship Shape also never
// opts into Pi's install telemetry or provider attribution headers.
process.env.PI_CODING_AGENT_DIR = piStateDir();
process.env.PI_TELEMETRY = "0";

const { runCli } = await import("./app.js");
const { processContext } = await import("./terminal.js");

const code = await runCli(process.argv.slice(2), processContext());
// Flush piped output before exiting; exit explicitly so lingering provider sockets can't hold the process open.
await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((done) => stream.write("", done))));
process.exit(code);
