import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type Compiled,
	codes,
	compileFixture,
	type PostmanCollection,
	type PostmanItem,
	requestNamed,
	scriptOf,
} from "../support/compile.js";

/**
 * **The chaining convention, which must work for any resource with no annotation in the spec.**
 *
 * A `201` whose response declares a `Location` header and returns a named model with a key creates
 * a resource. Its id goes into a collection variable named for the resource and its key, and every
 * path parameter that names that resource, by position under the collection path or by the
 * variable's own name, and carries the same kind of value, is filled from it.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
let compiled: Compiled;
let collection: PostmanCollection;

beforeAll(async () => {
	compiled = await compileFixture(here, "chaining", { outName: "chaining" });
	collection = compiled.collection();
}, 180_000);

const path = (name: string, folder?: string) =>
	requestNamed(collection, name, folder).request?.url.path;

describe("a created resource", () => {
	it("gets a collection variable named for the resource and its key, starting empty", () => {
		expect((collection.variable ?? []).map((variable) => [variable.key, variable.value])).toEqual([
			["baseUrl", ""],
			["authorId", ""],
			["bookId", ""],
			["projectSlug", ""],
			["widgetId", ""],
			["ticketId", ""],
			["shelfId", ""],
			// The one thing nothing in the service creates; every other variable a run fills in.
			["archiveId", "00000000-0000-0000-0000-000000000000"],
		]);
	});

	it("sets it from the created body's key after asserting the key came back", () => {
		const script = scriptOf(requestNamed(collection, "create", "Authors"));
		// The response checks come first; the key follows them.
		expect(script.slice(script.indexOf('pm.test("Response has an id", function () {'))).toEqual([
			'pm.test("Response has an id", function () {',
			'    pm.expect(pm.response.json()["id"]).to.be.a("string");',
			"});",
			'pm.collectionVariables.set("authorId", pm.response.json()["id"]);',
			// And the Location says the same id, at the place the spec says the author now lives.
			'pm.test("location identifies the created author", function () {',
			'    const collection = new URL(pm.variables.replaceIn("{{baseUrl}}/authors/")).pathname;',
			'    const location = pm.response.headers.get("location");',
			'    pm.expect(location, "location header").to.be.a("string");',
			"    const resolved = new URL(location, pm.request.url.toString()).pathname;",
			'    pm.expect(resolved).to.eql(collection + pm.collectionVariables.get("authorId"));',
			"});",
		]);
	});

	it("reads a @key property rather than one called id, and names the variable for it", () => {
		expect(scriptOf(requestNamed(collection, "create", "Projects"))).toContain(
			'pm.collectionVariables.set("projectSlug", pm.response.json()["slug"]);',
		);
	});

	it("asserts a numeric key is a number", () => {
		expect(scriptOf(requestNamed(collection, "create", "Widgets"))).toContain(
			'    pm.expect(pm.response.json()["id"]).to.be.a("number");',
		);
	});
});

describe("requests that need it", () => {
	it("fill the parameter after the collection path, whatever it is called", () => {
		expect(path("read", "Authors")).toEqual(["authors", "{{authorId}}"]);
	});

	it("fill both levels of a nested route", () => {
		expect(path("read", "Books")).toEqual(["authors", "{{authorId}}", "books", "{{bookId}}"]);
	});

	it("fill a POST's own trailing id, which names the parent it creates under", () => {
		expect(path("nominate", "Authors")).toEqual(["authors", "{{authorId}}"]);
	});

	it("fill a parameter named for the variable anywhere in a route", () => {
		expect(path("report")).toEqual(["reports", "{{authorId}}"]);
	});

	it("fill a PUT-create's read, but never the PUT-create's own new id", () => {
		expect(path("create", "Projects")).toEqual(["projects", ":slug"]);
		expect(path("read", "Projects")).toEqual(["projects", "{{projectSlug}}"]);
	});
});

describe("what is not chained", () => {
	it("a parameter in the id position whose value is a different kind of value", () => {
		expect(path("exists", "Authors")).toEqual(["authors", ":name"]);
	});

	/**
	 * A 201 with no `Location` still creates: its body carries the key and its route is the one the
	 * item route names. What the missing header costs is the check, not the chain - there is nothing
	 * to say where the ticket was created, so nothing asserts it.
	 */
	it("a 201 with no Location header is checked for nothing but still chains", () => {
		expect(path("read", "Tickets")).toEqual(["tickets", "{{ticketId}}"]);
		const script = scriptOf(requestNamed(collection, "create", "Tickets")).join("\n");
		expect(script).toContain('pm.collectionVariables.set("ticketId", pm.response.json()["id"]);');
		expect(script).not.toContain("location");
	});

	it("a created body with no model name, which is reported", () => {
		expect(codes(compiled)).toEqual([
			"typespec-postman/unnamed-resource",
			"typespec-postman/keyless-create",
		]);
		expect(scriptOf(requestNamed(collection, "createNote")).join("\n")).not.toContain(
			"collectionVariables",
		);
	});
});

/**
 * **Where the created id comes from when the body does not carry one.** RFC 9110 9.3.1 makes the
 * `Location` of a 201 the created resource's identifier, so a body that wraps the resource, or
 * carries none of it, still states the id - in the one place HTTP defines for it.
 */
describe("a create whose body has no key of its own", () => {
	it("derives the resource from its item route, not from the shape of the body", () => {
		expect((collection.variable ?? []).map((variable) => variable.key)).toContain("shelfId");
	});

	it("captures the id from the Location, under the collection path the spec declares", () => {
		expect(scriptOf(requestNamed(collection, "create", "Shelves"))).toEqual([
			'pm.test("Status code is 201", function () {',
			"    pm.response.to.have.status(201);",
			"});",
			'pm.test("Content-Type header is application/json", function () {',
			'    pm.expect(String(pm.response.headers.get("Content-Type")).toLowerCase()).to.include("application/json");',
			"});",
			'pm.test("Response matches the schema", function () {',
			expect.stringContaining("pm.response.to.have.jsonSchema("),
			"});",
			'pm.test("location identifies the created shelf", function () {',
			'    const collection = new URL(pm.variables.replaceIn("{{baseUrl}}/shelves/")).pathname;',
			'    const location = pm.response.headers.get("location");',
			'    pm.expect(location, "location header").to.be.a("string");',
			"    const resolved = new URL(location, pm.request.url.toString()).pathname;",
			'    pm.expect(resolved.startsWith(collection), "location under " + collection).to.be.true;',
			"    const id = resolved.slice(collection.length);",
			'    pm.expect(id, "one path segment").to.not.have.string("/");',
			'    pm.collectionVariables.set("shelfId", id);',
			"});",
		]);
	});

	it("fills the read from it", () => {
		expect(path("read", "Shelves")).toEqual(["shelves", "{{shelfId}}"]);
	});

	it("reports a create whose Location nothing can be matched against", () => {
		expect(codes(compiled)).toContain("typespec-postman/keyless-create");
	});
});

/**
 * **A resource nothing creates.** Its id cannot be derived from anything the spec states, so the
 * collection asks for it the way Postman asks for every value a run supplies - a variable with a
 * description - and skips the checks that cannot mean anything until it is given.
 */
describe("a resource with an item route and no creator", () => {
	it("gets a variable carrying the value the emitter would otherwise have sent", () => {
		expect((collection.variable ?? []).find((variable) => variable.key === "archiveId")).toEqual({
			key: "archiveId",
			value: "00000000-0000-0000-0000-000000000000",
			type: "string",
			description:
				"The id of the archive. No operation creates one, so supply it to run the requests that read it.",
		});
	});

	it("fills every request that needs it, at any depth under the item route", () => {
		expect(path("read", "Archives")).toEqual(["archives", "{{archiveId}}"]);
		expect(path("manifest", "Archives")).toEqual(["archives", "{{archiveId}}", "manifest"]);
	});

	it("skips the success checks while the variable still holds the value nothing created", () => {
		const script = scriptOf(requestNamed(collection, "read", "Archives")).join("\n");
		expect(script).toContain(
			'const unmet = [["archiveId","00000000-0000-0000-0000-000000000000"]].some(([name, placeholder]) =>',
		);
		// Empty counts as unset: a runner passing the flag with nothing in it is not supplying an id.
		expect(script).toContain(
			"    !pm.variables.get(name) || pm.variables.get(name) === placeholder);",
		);
		expect(script).toContain(
			'    pm.test.skip("Status code is 200 (needs archiveId)", function () {});',
		);
	});

	it("guards nothing a run does fill in", () => {
		expect(scriptOf(requestNamed(collection, "read", "Tickets")).join("\n")).not.toContain(
			"pm.test.skip",
		);
	});
});

/**
 * **The fixture is this convention's real specification.** Every oracle here reads what the fixture
 * declares, so a shape no fixture declares is a shape nothing grades - and `test/corpus/` is no help,
 * because across all 66 `@typespec/http-specs` scenarios not one derives a resource at all. These
 * arms fail when a source of an id, or a reason one cannot be derived, stops being exercised above.
 */
describe("every way an id is derived, or cannot be, is exercised by this fixture", () => {
	const scripts = () =>
		(collection.item ?? [])
			.flatMap(function walk(node): PostmanItem[] {
				return node.item === undefined ? [node] : node.item.flatMap(walk);
			})
			.flatMap((item) => scriptOf(item));

	it("captures an id from a response body", () => {
		expect(scripts().some((line) => line.startsWith("pm.collectionVariables.set"))).toBe(true);
	});

	it("captures an id from a Location, where the body carries none", () => {
		expect(scripts().some((line) => line.includes("const id = resolved.slice"))).toBe(true);
	});

	it("checks a Location against the route the resource is read from", () => {
		expect(scripts().some((line) => line.includes("new URL(location,"))).toBe(true);
	});

	it("asks the run for an id no operation creates, and skips what it cannot check", () => {
		expect((collection.variable ?? []).some((variable) => variable.value !== "")).toBe(true);
		expect(scripts().some((line) => line.includes("pm.test.skip"))).toBe(true);
	});

	it("reports every reason an id cannot be derived", () => {
		expect(codes(compiled).toSorted()).toEqual([
			"typespec-postman/keyless-create",
			"typespec-postman/unnamed-resource",
		]);
	});
});
