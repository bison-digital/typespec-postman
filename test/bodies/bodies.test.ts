import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type Compiled,
	codes,
	compileFixture,
	type PostmanCollection,
	requestNamed,
} from "../support/compile.js";

/**
 * **Request bodies: the example the author wrote, otherwise a body that satisfies the spec.** A
 * generated body is what a server validating against the spec accepts: every property required at
 * the request's visibility, wire names, formats, bounds and lengths honoured. Never `"<string>"`.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
let compiled: Compiled;
let collection: PostmanCollection;

beforeAll(async () => {
	compiled = await compileFixture(here, "bodies", { outName: "bodies" });
	collection = compiled.collection();
}, 180_000);

const json = (name: string): unknown =>
	JSON.parse(requestNamed(collection, name).request?.body?.raw ?? "null");

describe("bodies from examples", () => {
	it("sends the body an @opExample declares, split from its parameters, under wire names", () => {
		expect(json("operationExample")).toEqual({ name: "from the operation", colourCode: "blue" });
	});

	it("sends a model's @example when the operation has none", () => {
		expect(json("modelExample")).toEqual({ name: "a declared example", colourCode: "red" });
	});

	it("uses a property's @example where synthesis reaches it", () => {
		expect(json("patterned")).toEqual({ code: "123" });
	});
});

describe("bodies generated from the model", () => {
	it("includes every property required when creating, and nothing read-only or optional", () => {
		expect(json("create")).toEqual({
			name: "namexxxx",
			colourCode: "colourCode",
			secret: "secret",
			contact: "user@example.com",
			created: "1970-01-01T00:00:00Z",
			count: 1,
			ratio: 0.5,
			enabled: false,
			kind: "gadget-kind",
			label: "label",
			size: "small",
			tags: ["tags", "tags"],
			attributes: {},
		});
	});

	it("sets a discriminated base's discriminator by synthesising its first derived model", () => {
		expect(json("pet")).toEqual({ kind: "dog", name: "name", bark: false });
	});

	it("wraps a discriminated union in its declared envelope", () => {
		expect(json("shape")).toEqual({ kind: "circle", value: { radius: 0 } });
	});

	it("stops at an optional self-reference rather than recursing", () => {
		expect(json("node")).toEqual({ name: "name" });
	});

	it("reports a pattern no generated value satisfies, naming the property", () => {
		const diagnostic = compiled.diagnostics.find(
			(d) => d.code === "typespec-postman/unsatisfiable-value",
		);
		expect(diagnostic?.message).toContain("'code'");
		expect(diagnostic?.message).toContain('"^[A-Z]+$"');
		expect(
			compiled.diagnostics.filter((d) => d.code === "typespec-postman/unsatisfiable-value"),
		).toHaveLength(1);
	});
});

describe("a GET that declares a body", () => {
	it("tells Postman not to prune it, so the body is actually sent", () => {
		const item = requestNamed(collection, "searchWithBody") as {
			protocolProfileBehavior?: unknown;
		};
		expect(item.protocolProfileBehavior).toEqual({ disableBodyPruning: true });
		expect(json("searchWithBody")).toEqual({ term: "term" });
	});

	it("and a request that sends no body, or is not a GET, carries no such flag", () => {
		for (const name of ["create", "node"]) {
			expect(
				(requestNamed(collection, name) as { protocolProfileBehavior?: unknown })
					.protocolProfileBehavior,
			).toBeUndefined();
		}
	});
});

describe("bodies that are not JSON", () => {
	it("sends a urlencoded body as fields", () => {
		expect(requestNamed(collection, "urlencoded").request?.body).toEqual({
			mode: "urlencoded",
			urlencoded: [
				{ key: "name", value: "name" },
				{ key: "age", value: "0" },
			],
		});
	});

	it("sends multipart text parts and leaves a file part for a person to choose, reporting it", () => {
		expect(requestNamed(collection, "form").request?.body).toEqual({
			mode: "formdata",
			formdata: [
				// The part's resolved media type, which `@typespec/http` gives an HttpPart<string> as text/plain.
				{ key: "name", value: "name", type: "text", contentType: "text/plain" },
				{ key: "avatar", type: "file", src: [] },
			],
		});
	});

	it("uses Postman's file mode for a binary body, reporting it", () => {
		expect(requestNamed(collection, "upload").request?.body).toEqual({
			mode: "file",
			file: { src: null },
		});
		expect(
			codes(compiled).filter((code) => code === "typespec-postman/body-not-runnable"),
		).toHaveLength(2);
	});
});
