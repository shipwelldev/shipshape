import { describe, expect, it, vi } from "vitest";
import { cli, FAUX_MODEL, fauxRuntime, makeRepo, submit, writeFiles } from "./helpers.js";

// Abort from inside the post-session stability check: the last await before a verdict.
const { controller } = vi.hoisted(() => ({ controller: new AbortController() }));
vi.mock("../src/target/resolve.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/target/resolve.js")>();
	return {
		...actual,
		resolveTarget: async (...args: Parameters<typeof actual.resolveTarget>) => {
			const target = await actual.resolveTarget(...args);
			return {
				...target,
				checkStability: async () => {
					controller.abort();
					return target.checkStability();
				},
			};
		},
	};
});

describe("late cancellation", () => {
	it("reports an interrupt during the final stability check as cancelled, not passed", async () => {
		const repo = makeRepo({ "a.txt": "1\n" });
		writeFiles(repo, { "a.txt": "2\n" });
		const { factory } = fauxRuntime([submit([])]);
		const { code, json } = await cli(["review", "--model", FAUX_MODEL, "--format", "json"], {
			cwd: repo,
			factory,
			signal: controller.signal,
		});
		expect(code).toBe(130);
		expect(json).toMatchObject({ status: "cancelled", problem: { reason: "cancelled" } });
	});
});
