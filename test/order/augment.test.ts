import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Compiled, compileFixture } from "../support/compile.js";

/**
 * **The collection is ordered by what the spec declares, not by what another library's decorator
 * made the checker meet first** - see `inDeclarationOrder`.
 *
 * Compiled twice: the service alone, and beside a file whose only statement is an augment decorator
 * naming one of its operations, as a GraphQL surface's `@link` does. The compiler checks that
 * argument with the model it decorates, so `@typespec/http` lists `Gadgets` before `Status` and
 * `Widgets` in the second compile.
 */

const here = join(fileURLToPath(new URL(".", import.meta.url)), "augment");

let alone: Compiled;
let augmented: Compiled;
beforeAll(async () => {
	alone = await compileFixture(here, "rest-only", { outName: "order-augment-alone" });
	augmented = await compileFixture(here, "augmented", { outName: "order-augment-augmented" });
}, 300_000);

describe("an augment decorator naming an operation", () => {
	it("changes no byte of the collection", () => {
		expect(augmented.text()).toBe(alone.text());
	});

	it("leaves the error cases and the variables in the order the spec declares the operations", () => {
		expect(augmented.collection().variable?.map((variable) => variable.key)).toEqual(
			expect.arrayContaining(["widgetId", "gadgetId"]),
		);
		const keys = (augmented.collection().variable ?? []).map((variable) => variable.key);
		expect(keys.indexOf("widgetId")).toBeLessThan(keys.indexOf("gadgetId"));
		const errorCases = augmented.collection().item.find((item) => item.name === "Error cases");
		const urls = (errorCases?.item ?? []).map((item) =>
			typeof item.request === "object" ? item.request.url.raw : undefined,
		);
		expect(urls).toEqual([
			"{{baseUrl}}/widgets/does-not-exist",
			"{{baseUrl}}/gadgets/does-not-exist",
		]);
	});
});
