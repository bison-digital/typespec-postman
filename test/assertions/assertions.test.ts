import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type Compiled,
	compileFixture,
	type PostmanCollection,
	requestNamed,
	scriptOf,
} from "../support/compile.js";

/**
 * **The assertions a good hand-written collection carries, and no more.** Each rendered script is
 * stated literally here, in the form Postman's own snippets write it, so a change to what the
 * collection checks is a change a reader sees in this file.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
let compiled: Compiled;
let collection: PostmanCollection;

beforeAll(async () => {
	compiled = await compileFixture(here, "assertions", { outName: "assertions" });
	collection = compiled.collection();
}, 180_000);

const script = (name: string, folder?: string) => scriptOf(requestNamed(collection, name, folder));

describe("the status", () => {
	it("is asserted exactly where one 2xx is declared", () => {
		expect(script("read", "Accounts").slice(0, 3)).toEqual([
			'pm.test("Status code is 200", function () {',
			"    pm.response.to.have.status(200);",
			"});",
		]);
	});

	it("is asserted as one of several where several are declared", () => {
		expect(script("either")).toEqual([
			'pm.test("Status code is one of 200, 202", function () {',
			"    pm.expect(pm.response.code).to.be.oneOf([200, 202]);",
			"});",
		]);
	});

	it("is asserted within a declared range", () => {
		expect(script("ranged")).toEqual([
			'pm.test("Status code is 200 to 299", function () {',
			"    pm.expect(pm.response.code).to.be.within(200, 299);",
			"});",
		]);
	});

	it("is not asserted, and that is reported, where no 2xx is declared", () => {
		expect(script("failing")).toEqual([]);
		expect(compiled.diagnostics.map((d) => d.message)).toContain(
			"Operation 'failing' declares no 2xx response, so no status assertion is generated for it.",
		);
	});
});

describe("what the chaining convention adds", () => {
	it("a list is asserted to be an array", () => {
		expect(script("list", "Accounts").slice(3)).toEqual([
			'pm.test("Response is an array", function () {',
			'    pm.expect(pm.response.json()).to.be.an("array");',
			"});",
		]);
	});

	it("a read returns the resource that was asked for", () => {
		expect(script("read", "Accounts").slice(3)).toEqual([
			'pm.test("Returns the requested account", function () {',
			'    pm.expect(String(pm.response.json()["id"])).to.eql(pm.variables.get("accountId"));',
			"});",
		]);
	});

	it("an update holds each example field it sent, leaving out a date-time a server may re-spell", () => {
		expect(script("update", "Accounts").slice(3)).toEqual([
			'pm.test("name was updated", function () {',
			'    pm.expect(pm.response.json()["name"]).to.eql("Renamed");',
			"});",
			'pm.test("seats was updated", function () {',
			'    pm.expect(pm.response.json()["seats"]).to.eql(3);',
			"});",
		]);
	});

	it("an update with no example asserts its status alone, and says why", () => {
		expect(script("replace", "Accounts")).toHaveLength(3);
		const messages = compiled.diagnostics.map((d) => d.message);
		expect(messages).toContain(
			"Update operation 'replace' has no @opExample, so no assertion that a field was updated can be derived.",
		);
		expect(messages).toContain(
			"Update operation 'update' has no @opExample and its body has no required property, so the request sends an empty object and no assertion that a field was updated can be derived.",
		);
	});
});
