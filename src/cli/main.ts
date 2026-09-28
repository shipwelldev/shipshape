#!/usr/bin/env node
import "./environment.js";

process.title = "shipshape";
const { runCli } = await import("./app.js");
const { processContext } = await import("./terminal.js");

const code = await runCli(process.argv.slice(2), processContext());
// Flush piped output before exiting; exit explicitly so lingering provider sockets can't hold the process open.
await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((done) => stream.write("", done))));
process.exit(code);
