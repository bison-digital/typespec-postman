import { execFile } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * **Postman's own tooling reads the collection, and has nothing to say about it.**
 *
 * Acceptance asks that the collection import into the Postman app without warnings. The app is not
 * scriptable without a signed-in workspace and an import there syncs to Postman's cloud, but two of
 * the Postman CLI's commands read a collection FILE with the same parser and say what they find:
 *
 * - `postman collection migrate` converts v2.1 to the v3 format, which is the app's own reading of
 *   the file: every folder, request, script, auth block and variable has to survive it;
 * - `postman collection lint` then runs Postman's linter over the result.
 *
 * Both must be clean, and the migration must keep what the collection is FOR: one file per request,
 * the schema checks, and the scripts that chain a created id. A person still confirms the app import
 * once per release (`docs/releasing.md`); this is what can be checked on every commit.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const example = fileURLToPath(new URL("../../example/postman_collection.json", import.meta.url));

interface Ran {
	readonly exitCode: number;
	readonly output: string;
}

function run(args: readonly string[], cwd: string): Promise<Ran> {
	return new Promise((resolve, reject) => {
		execFile(
			"postman",
			[...args],
			{ cwd, maxBuffer: 16 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
					reject(new Error("The `postman` CLI is not on PATH."));
					return;
				}
				resolve({
					exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
					output: `${stdout}${stderr}`,
				});
			},
		);
	});
}

const workspace = join(here, ".out", "lint");
let migrated: Ran;
let linted: Ran;
let files: string[] = [];

beforeAll(async () => {
	rmSync(workspace, { recursive: true, force: true });
	const { mkdirSync, copyFileSync } = await import("node:fs");
	mkdirSync(workspace, { recursive: true });
	copyFileSync(example, join(workspace, "postman_collection.json"));
	migrated = await run(["collection", "migrate", "postman_collection.json"], workspace);
	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((entry) => {
			const full = join(dir, entry);
			return statSync(full).isDirectory() ? walk(full) : [full];
		});
	files = migrated.exitCode === 0 ? walk(join(workspace, "Bookshop")) : [];
	linted = await run(["collection", "lint", "Bookshop"], workspace);
}, 300_000);

describe("Postman's own parser and linter on the committed collection", () => {
	it("migrates the v2.1 file to v3 without failing", () => {
		expect(migrated.exitCode, migrated.output).toBe(0);
	});

	it("lints the result with no errors and no warnings", () => {
		expect(linted.exitCode, linted.output).toBe(0);
		expect(linted.output).toMatch(/Errors: 0 \| Warnings: 0/);
		// Non-vacuity: the linter reports how many items it read, and it read all of them.
		expect(linted.output).toMatch(/Scanned: 16\b/);
	});

	/**
	 * **And the pair can fail.** A collection whose request carries a method no HTTP verb spells is
	 * still valid JSON and still valid against the v2.1 schema; Postman's own tooling is what refuses
	 * it. Without this arm, a migration that silently produced nothing would report the same success.
	 */
	it("refuses a collection Postman cannot read", async () => {
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const broken = join(workspace, "broken");
		rmSync(broken, { recursive: true, force: true });
		mkdirSync(broken, { recursive: true });
		const collection = JSON.parse(readFileSync(example, "utf8")) as {
			item: { request?: { method?: unknown; url?: unknown } }[];
		};
		collection.item = [
			{ request: { method: 42, url: { raw: "{{baseUrl}}/x", host: [], path: [] } } },
		];
		writeFileSync(join(broken, "postman_collection.json"), JSON.stringify(collection));
		const attempt = await run(["collection", "migrate", "postman_collection.json"], broken);
		const after =
			attempt.exitCode === 0 ? await run(["collection", "lint", "Bookshop"], broken) : attempt;
		expect(
			attempt.exitCode !== 0 || after.exitCode !== 0 || /Errors: [1-9]/.test(after.output),
			`${attempt.output}${after.output}`,
		).toBe(true);
	}, 300_000);

	it("keeps every request, its schema check and the scripts that chain a created id", () => {
		const requests = files.filter((file) => file.endsWith(".request.yaml"));
		expect(requests).toHaveLength(16);
		const text = requests.map((file) => readFileSync(file, "utf8"));
		expect(text.filter((source) => source.includes("jsonSchema"))).toHaveLength(14);
		expect(text.filter((source) => source.includes("collectionVariables.set"))).toHaveLength(2);
		// The folders the collection is grouped by, nested as the routes are.
		expect(files.some((file) => file.includes(join("Authors", "Books")))).toBe(true);
		expect(files.some((file) => file.includes("Error cases"))).toBe(true);
	});
});
