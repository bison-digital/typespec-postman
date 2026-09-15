import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileFixture } from "../support/compile.js";

/**
 * **A versioned service is emitted at its latest version**, as `@typespec/openapi3` and the sibling
 * emitters project it. Without the projection the collection would call an operation the current
 * server removed and miss one it added.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

describe("a versioned service", () => {
	it("contains the operations of its last declared version and no others", async () => {
		const collection = (
			await compileFixture(here, "versioned", { outName: "versioned" })
		).collection();
		expect(collection.item.map((item) => item.name)).toEqual(["list", "gadgets"]);
	});
});
