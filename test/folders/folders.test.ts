import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture, type PostmanCollection } from "../support/compile.js";

/**
 * **Folders are the containers the spec author declared operations in**, not OpenAPI tags: an
 * interface, or a namespace inside the service. Operations declared on the service namespace itself
 * sit at the collection root.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
let collection: PostmanCollection;

beforeAll(async () => {
	collection = (await compileFixture(here, "folders", { outName: "folders" })).collection();
}, 180_000);

describe("folders", () => {
	it("follow the declaring interface and namespace, with the service's own operations at the root", () => {
		expect(
			collection.item.map((item) => [item.name, item.item?.map((inner) => inner.name) ?? null]),
		).toEqual([
			["status", null],
			["Catalogue", ["Browse the catalogue"]],
			["Admin", ["reindex"]],
			["Admin.Users", ["list"]],
		]);
	});

	it("carry the container's doc comment, and the collection carries the service's", () => {
		expect(collection.item[1]).toMatchObject({ description: "Everything a shopper browses." });
		expect(collection.info).toMatchObject({
			name: "Folders",
			description: "The bookstore's public catalogue.",
		});
	});

	it("name a request by its @summary, and by the operation name where there is none", () => {
		expect(collection.item[0]?.name).toBe("status");
		expect(collection.item[1]?.item?.[0]?.name).toBe("Browse the catalogue");
	});
});
