import { describe, expect, it, vi } from "vitest";
import { cli, FAUX_MODEL, fauxRuntime, makeRepo, submit, writeFiles } from "./helpers.js";

// Abort while the Pi session is being created, before the cancellation listener exists.
const { controller } = vi.hoisted(() => ({ controller: new AbortController() }));
vi.mock("../src/runtime/pi.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/runtime/pi.js")>();
	return {
		...actual,
		createReviewSession: async (...args: Parameters<typeof actual.createReviewSession>) => {
			const session = await actual.createReviewSession(...args);
			controller.abort();
			return session;
		},
	};
});

describe("cancellation while the session starts", () => {
	it("stops before sending any model request", async () => {
		const repo = makeRepo({ "a.txt": "1\n" });
		writeFiles(repo, { "a.txt": "2\n" });
		const { faux, factory } = fauxRuntime([submit([])]);
		const { code, json } = await cli(["review", "--model", FAUX_MODEL, "--format", "json"], {
			cwd: repo,
			factory,
			signal: controller.signal,
		});
		expect(code).toBe(130);
		expect(json.status).toBe("cancelled");
		expect(faux.state.callCount).toBe(0);
	});
});
