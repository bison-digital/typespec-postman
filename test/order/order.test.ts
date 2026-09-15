import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type Compiled,
	compileFixture,
	type PostmanCollection,
	type PostmanItem,
} from "../support/compile.js";

/**
 * **Requests run in an order where dependencies come first**, inferred from the chaining convention
 * alone. The fixture declares every consumer before what it consumes, so declaration order would
 * fail every chained request; the order below is the one a run needs.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
let compiled: Compiled;
let collection: PostmanCollection;

beforeAll(async () => {
	compiled = await compileFixture(here, "order", { outName: "order" });
	collection = compiled.collection();
}, 180_000);

/** The collection as an outline: folders as `Name/`, requests as `METHOD name`. */
function outline(items: readonly PostmanItem[], depth = 0): string[] {
	return items.flatMap((item) =>
		item.item === undefined
			? [`${"  ".repeat(depth)}${item.request?.method ?? ""} ${item.name}`]
			: [`${"  ".repeat(depth)}${item.name}/`, ...outline(item.item, depth + 1)],
	);
}

describe("dependency order", () => {
	it("creates before use, nests the child folder inside its parent, and deletes last", () => {
		expect(outline(collection.item).slice(0, 10)).toEqual([
			"Shelves/",
			"  POST create",
			"  Books/",
			"    POST create",
			"    GET read",
			"    DELETE remove",
			"  GET read",
			"  GET list",
			"  DELETE remove",
			"GET audit",
		]);
	});
});

describe("dependencies no folder order can satisfy", () => {
	it("keeps the creations in order and ends each folder with its deletes", () => {
		expect(outline(collection.item).slice(10)).toEqual([
			"Tags/",
			"  POST create",
			"  GET byLabel",
			"  DELETE remove",
			"Labels/",
			"  POST create",
			"  GET byTag",
			"  DELETE remove",
		]);
	});

	it("reports exactly the dependencies the emitted order breaks, by qualified name", () => {
		const reported = compiled.diagnostics.filter((d) => d.code === "typespec-postman/order-cycle");
		expect(reported).toHaveLength(1);
		expect(reported[0]?.message).toContain(
			"These are not kept: 'Labels.create' before 'Tags.byLabel', 'audit' before 'Shelves.remove', 'Labels.byTag' before 'Tags.remove'.",
		);
	});
});
