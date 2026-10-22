import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileSpec, requestNamed } from "../support/compile.js";

/**
 * **A create body sends a server-assigned read-only `id` exactly where the document requires it.**
 * openapi3 shares the property into the schema the request is published with, `required` and
 * `readOnly`; OAS 3.0.4 requires it "on the response only", and 3.1 made `readOnly` an annotation, so
 * the request requires it too. This collection left it out at every version, which a 3.1 server - and
 * the 3.1 document its schemas are read from - refused; it follows the version openapi3 publishes now,
 * read from the same options, as the server built beside it does.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

async function createBody(versions: readonly string[] | null): Promise<unknown> {
	const compiled = await compileSpec(
		join(here, "main.tsp"),
		join(here, ".out", `readonly-${versions?.join("_") ?? "default"}`),
		{ openapiVersions: versions },
	);
	return JSON.parse(requestNamed(compiled.collection(), "create").request?.body?.raw ?? "");
}

describe("a create body and its server-assigned read-only id", () => {
	it("leaves the id out where openapi3 publishes 3.0, its default", async () => {
		expect(await createBody(null)).toEqual({ name: "name", items: [] });
	});

	it("sends it where openapi3 publishes 3.1, whose request requires it", async () => {
		const body = (await createBody(["3.1.0"])) as Record<string, unknown>;
		expect(Object.keys(body).toSorted()).toEqual(["id", "items", "name"]);
	});
});
