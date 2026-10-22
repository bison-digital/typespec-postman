import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **Identical input, identical bytes.** The collection is committed and CI regenerates it and fails
 * on any diff, so anything that varies between compiles (a timestamp, a random id, a map iterated
 * in insertion order that depends on timing) is a CI failure with no change behind it.
 *
 * **Two separate `tsp compile` processes**, not one program compiled twice: a cache shared inside one
 * process could make two compiles agree that two machines would not.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../..", import.meta.url));
const tsp = join(root, "node_modules", ".bin", "tsp");

function compileOnce(main: string, outDir: string): Promise<Buffer> {
	rmSync(outDir, { recursive: true, force: true });
	return new Promise((resolve, reject) => {
		execFile(
			tsp,
			[
				"compile",
				main,
				"--emit",
				"typespec-postman",
				"--option",
				`typespec-postman.emitter-output-dir=${outDir}`,
			],
			{ cwd: root },
			(error, stdout, stderr) => {
				if (error !== null) reject(new Error(`${stdout}${stderr}`));
				else resolve(readFileSync(join(outDir, "postman_collection.json")));
			},
		);
	});
}

describe("the same spec compiled twice", () => {
	const example = join(root, "example", "main.tsp");

	it("produces byte-identical collections from two separate processes", async () => {
		const [first, second] = await Promise.all([
			compileOnce(example, join(here, ".out", "determinism-a")),
			compileOnce(example, join(here, ".out", "determinism-b")),
		]);
		expect(first.length).toBeGreaterThan(1000);
		expect(first.equals(second)).toBe(true);
	}, 180_000);

	it("and the comparison can fail: a one-word doc change produces different bytes", async () => {
		const changed = join(here, ".out", "determinism-changed");
		mkdirSync(changed, { recursive: true });
		copyFileSync(example, join(changed, "main.tsp"));
		const source = readFileSync(join(changed, "main.tsp"), "utf8");
		writeFileSync(join(changed, "main.tsp"), source.replace("A small bookshop", "A tiny bookshop"));
		const [original, edited] = await Promise.all([
			compileOnce(example, join(here, ".out", "determinism-c")),
			compileOnce(join(changed, "main.tsp"), join(here, ".out", "determinism-d")),
		]);
		expect(original.equals(edited)).toBe(false);
	}, 180_000);
});
