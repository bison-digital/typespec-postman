import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type Compiled,
	compileFixture,
	type PostmanCollection,
	requestNamed,
} from "../support/compile.js";

/** The refusals no topic fixture raises on its own: a name claimed twice, and an example that cannot be serialized. */

const here = fileURLToPath(new URL(".", import.meta.url));
let compiled: Compiled;
let collection: PostmanCollection;

beforeAll(async () => {
	compiled = await compileFixture(here, "diagnostics", { outName: "diagnostics" });
	collection = compiled.collection();
}, 180_000);

const messages = () => compiled.diagnostics.map((diagnostic) => diagnostic.message);

describe("variable-collision", () => {
	it("keeps the first of two resources whose variables share a name, naming both creators", () => {
		expect(messages()).toContain(
			"Collection variable 'itemId' is claimed by the resource created by 'Store.create' and by the resource created by 'Warehouse.create'. The first claim is kept, and the second does not get a variable of its own.",
		);
	});

	it("keeps a server variable over a credential of the same name, and declares the variable once", () => {
		expect(messages()).toContain(
			"Collection variable 'shopKey' is claimed by server variable 'shopKey' and by the credential 'shopKey'. The first claim is kept, and the second does not get a variable of its own.",
		);
		expect(
			(collection.variable ?? []).filter((variable) => variable.key === "shopKey"),
		).toHaveLength(1);
	});
});

describe("unserializable-example", () => {
	it("reports the serializer's reason and sends a generated value instead", () => {
		expect(messages()).toContain(
			"The example for 'since' could not be serialized (Cannot serialize scalar 'utcDateTime' with constructor 'now'. Supported constructors: fromISO), so a generated value is used instead.",
		);
		expect(requestNamed(collection, "changes").request?.url.query).toEqual([
			{ key: "since", value: "1970-01-01T00%3A00%3A00Z" },
		]);
	});
});
