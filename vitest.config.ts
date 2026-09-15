import { defineConfig } from "vitest/config";

/**
 * The emitter is a build-time tool and runs in plain Node. Suites compile TypeSpec, serve generated
 * servers and shell out to the Postman CLI, so they need headroom well past the 5s default.
 *
 * **No `globalSetup`.** Each suite compiles what it needs through its own harness.
 *
 * **Two projects, split by what a suite COSTS rather than by what it grades.** `system` holds the
 * suites that run the Postman CLI or sweep the whole corpus; `unit` is everything else. `pnpm test`
 * runs both, so the split is for the edit loop (`pnpm test:unit`) and never takes a suite out of the
 * gate.
 */
const SYSTEM = ["test/run/**/*.test.ts", "test/corpus/**/*.test.ts", "test/reference/**/*.test.ts"];

export default defineConfig({
	test: {
		testTimeout: 180_000,
		projects: [
			{
				test: {
					name: "unit",
					environment: "node",
					include: ["test/**/*.test.ts"],
					exclude: SYSTEM,
					testTimeout: 180_000,
				},
			},
			{
				test: {
					name: "system",
					environment: "node",
					include: SYSTEM,
					testTimeout: 1_800_000,
					hookTimeout: 1_800_000,
				},
			},
		],
	},
});
