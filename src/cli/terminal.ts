import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { CancelSignal } from "../review/policy.js";
import type { CliContext, Prompter } from "./app.js";

/** Context bound to the real process: stdio, environment, and SIGINT/SIGTERM cancellation. */
export function processContext(): CliContext {
	const controller = new AbortController();
	let received: CancelSignal | undefined;
	const onSignal = (signal: CancelSignal) => {
		if (received) process.exit(signal === "SIGTERM" ? 143 : 130); // second signal: stop waiting for cleanup
		received = signal;
		process.stderr.write(`\nshipshape: ${signal} received, cancelling (press Ctrl+C again to exit immediately)\n`);
		controller.abort();
	};
	process.on("SIGINT", () => onSignal("SIGINT"));
	process.on("SIGTERM", () => onSignal("SIGTERM"));

	return {
		cwd: process.cwd(),
		env: process.env,
		stdout: process.stdout,
		stderr: process.stderr,
		interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY) && !process.env.CI,
		createPrompter: () => terminalPrompter(controller.signal),
		signal: controller.signal,
		cancelSignal: () => received,
	};
}

/** Line prompts on stderr; secret answers are not echoed. Every prompt stops when `cancelled` aborts. */
function terminalPrompter(cancelled: AbortSignal): Prompter {
	let muted = false;
	const sink = new Writable({
		write(chunk, _encoding, callback) {
			if (!muted) process.stderr.write(chunk);
			callback();
		},
	});
	const rl = createInterface({ input: process.stdin, output: sink, terminal: true });
	// In raw mode Ctrl+C reaches readline rather than the process; route it to the normal cancellation path.
	rl.on("SIGINT", () => {
		rl.close();
		process.emit("SIGINT");
	});
	return {
		async ask(message, options = {}) {
			process.stderr.write(`${message}: `);
			muted = options.secret === true;
			try {
				const signal = options.signal ? AbortSignal.any([options.signal, cancelled]) : cancelled;
				return (await rl.question("", { signal })).trim();
			} finally {
				if (muted) process.stderr.write("\n");
				muted = false;
			}
		},
		close: () => rl.close(),
	};
}
