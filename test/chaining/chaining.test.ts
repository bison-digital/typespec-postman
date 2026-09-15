import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type Compiled,
	codes,
	compileFixture,
	type PostmanCollection,
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
			["teamId", ""],
			["memberId", ""],
			["projectSlug", ""],
			["widgetId", ""],
		]);
	});

	it("sets it from the created body's key after asserting the key came back", () => {
		const script = scriptOf(requestNamed(collection, "create", "Teams"));
		// The response checks come first; the key follows them.
		expect(script.slice(script.indexOf('pm.test("Response has an id", function () {'))).toEqual([
			'pm.test("Response has an id", function () {',
			'    pm.expect(pm.response.json()["id"]).to.be.a("string");',
			"});",
			'pm.collectionVariables.set("teamId", pm.response.json()["id"]);',
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
		expect(path("read", "Teams")).toEqual(["teams", "{{teamId}}"]);
	});

	it("fill both levels of a nested route", () => {
		expect(path("read", "Members")).toEqual(["teams", "{{teamId}}", "members", "{{memberId}}"]);
	});

	it("fill a POST's own trailing id, which names the parent it creates under", () => {
		expect(path("invite", "Teams")).toEqual(["teams", "{{teamId}}"]);
	});

	it("fill a parameter named for the variable anywhere in a route", () => {
		expect(path("report")).toEqual(["reports", "{{teamId}}"]);
	});

	it("fill a PUT-create's read, but never the PUT-create's own new id", () => {
		expect(path("create", "Projects")).toEqual(["projects", ":slug"]);
		expect(path("read", "Projects")).toEqual(["projects", "{{projectSlug}}"]);
	});
});

describe("what is not chained", () => {
	it("a parameter in the id position whose value is a different kind of value", () => {
		expect(path("exists", "Teams")).toEqual(["teams", ":name"]);
	});

	it("a 201 that declares no Location header", () => {
		expect(path("read", "Tickets")).toEqual(["tickets", ":ticketId"]);
		expect(scriptOf(requestNamed(collection, "create", "Tickets")).join("\n")).not.toContain(
			"collectionVariables",
		);
	});

	it("a created body with no model name, which is reported", () => {
		expect(codes(compiled)).toEqual(["typespec-postman/unnamed-resource"]);
		expect(scriptOf(requestNamed(collection, "createNote")).join("\n")).not.toContain(
			"collectionVariables",
		);
	});
});
