import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **The committed worked example is exactly what the emitter writes for the committed spec.** This is
 * the drift check a consumer runs in CI, run on this repository's own example: compile with the
 * example's own `tspconfig.yaml`, and require the file on disk to match byte for byte.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));

describe("the worked example", () => {
	it("is byte-identical to a fresh compile of example/main.tsp", async () => {
		const outDir = join(here, ".out", "example");
		rmSync(outDir, { recursive: true, force: true });
		await new Promise<void>((resolve, reject) => {
			execFile(
				join(root, "node_modules", ".bin", "tsp"),
				["compile", "example", "--option", `typespec-postman.emitter-output-dir=${outDir}`],
				{ cwd: root },
				(error, stdout, stderr) =>
					error === null ? resolve() : reject(new Error(`${stdout}${stderr}`)),
			);
		});
		const fresh = readFileSync(join(outDir, "postman_collection.json"), "utf8");
		const committed = readFileSync(join(root, "example", "postman_collection.json"), "utf8");
		expect(committed).toBe(fresh);
	}, 180_000);
});
