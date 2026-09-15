import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileSpec, requestNamed, requestsOf, scriptOf } from "../support/compile.js";

/**
 * **A spec change reaches the regenerated collection with no manual step.** One base spec and three
 * edits a real API makes: an operation added, a field renamed, a status changed. Each is compiled
 * from an edited copy and compared with the base.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const base = readFileSync(join(here, "base.tsp"), "utf8");

async function compileEdited(name: string, edit: (source: string) => string) {
	const dir = join(here, ".out", `evolution-${name}-source`);
	mkdirSync(dir, { recursive: true });
	const source = edit(base);
	expect(source, "the edit must change the spec").not.toBe(name === "base" ? "" : base);
	writeFileSync(join(dir, "main.tsp"), source);
	return (
		await compileSpec(join(dir, "main.tsp"), join(here, ".out", `evolution-${name}`))
	).collection();
}

describe("a spec change", () => {
	it("adding an operation adds its request", async () => {
		const before = await compileEdited("base", (source) => source);
		const after = await compileEdited("added", (source) =>
			source.replace(
				"  @post create",
				'  @route("/{petId}") @delete remove(@path @format("uuid") petId: string): void;\n  @post create',
			),
		);
		expect(requestsOf(before).map(({ item }) => item.name)).toEqual(["create", "update"]);
		expect(requestsOf(after).map(({ item }) => item.name)).toEqual(["create", "update", "remove"]);
	});

	it("renaming a field renames it in the body sent and in the assertion on it", async () => {
		const after = await compileEdited("renamed", (source) =>
			source
				.replace("  name: string;\n}", "  displayName: string;\n}")
				.replace("model PetPatch { name?: string; }", "model PetPatch { displayName?: string; }")
				.replace('patch: #{ name: "Rex" }', 'patch: #{ displayName: "Rex" }'),
		);
		expect(JSON.parse(requestNamed(after, "create").request?.body?.raw ?? "")).toEqual({
			displayName: "displayName",
		});
		expect(scriptOf(requestNamed(after, "update"))).toContain(
			'pm.test("displayName was updated", function () {',
		);
	});

	it("changing a status changes the status asserted", async () => {
		const after = await compileEdited("status", (source) =>
			source.replace("@statusCode statusCode: 201;", "@statusCode statusCode: 200;"),
		);
		expect(scriptOf(requestNamed(after, "create")).slice(0, 2)).toEqual([
			'pm.test("Status code is 200", function () {',
			"    pm.response.to.have.status(200);",
		]);
	});
});
