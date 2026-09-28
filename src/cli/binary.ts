// Entry point for standalone binaries built with `bun build --compile`; Node runs main.ts.
//
// Pi loads OAuth flows and the Bedrock provider through variable imports that a bundler
// cannot follow. Its own Bun entry registers them statically, so reuse that setup. It is
// imported from Pi's package by path (it is not a public export) so that it registers into
// the copy of pi-ai that Pi itself uses. Imports evaluate in order.
import "../../node_modules/@earendil-works/pi-coding-agent/dist/bun/sandbox-env-setup.js";
import "./environment.js";
import "../../node_modules/@earendil-works/pi-coding-agent/dist/bun/runtime-setup.js";
import "./main.js";
