import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileFixture, compileSpec } from "../support/compile.js";

/** The standard emitter conventions: `emitter-output-dir`, `output-file`, `noEmit` and dry runs. */

const here = fileURLToPath(new URL(".", import.meta.url));

describe("where the collection is written", () => {
	it("writes postman_collection.json into emitter-output-dir for a single service", async () => {
		const compiled = await compileFixture(here, "options", { outName: "options-default" });
		expect(readdirSync(compiled.outDir)).toEqual(["postman_collection.json"]);
	});

	it("honours output-file, including a directory in it", async () => {
		const compiled = await compileFixture(here, "options", {
			outName: "options-file",
			postman: { "output-file": "collections/{service-name}.json" },
		});
		expect(existsSync(join(compiled.outDir, "collections", "OptionsFixture.json"))).toBe(true);
	});
});

describe("compiles that must write nothing", () => {
	it("writes nothing under noEmit", async () => {
		const outDir = join(here, ".out", "options-noemit");
		await compileSpec(join(here, "options.tsp"), outDir, { noEmit: true });
		expect(existsSync(outDir)).toBe(false);
	});

	it("writes nothing on a dry run", async () => {
		const outDir = join(here, ".out", "options-dryrun");
		await compileSpec(join(here, "options.tsp"), outDir, { dryRun: true });
		expect(existsSync(join(outDir, "postman_collection.json"))).toBe(false);
	});

	it("and the compile that writes something is the same compile with neither flag", async () => {
		// Non-vacuity for the two arms above: the same harness, the same spec, a file appears.
		const outDir = join(here, ".out", "options-control");
		await compileSpec(join(here, "options.tsp"), outDir);
		expect(existsSync(join(outDir, "postman_collection.json"))).toBe(true);
	});
});
