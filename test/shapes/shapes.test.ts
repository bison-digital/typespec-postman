import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	codes,
	type Compiled,
	compileFixture,
	type PostmanCollection,
	requestNamed,
	scriptOf,
} from "../support/compile.js";

/**
 * **The shapes a create and an item route can take, graded as a space rather than as the cases that
 * happened to be written first.**
 *
 * A shape no fixture declares is one the oracles cannot see, however sound they are. Each shape here
 * is one a real HTTP API uses.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
let compiled: Compiled;
let collection: PostmanCollection;

beforeAll(async () => {
	compiled = await compileFixture(here, "shapes", { outName: "shapes" });
	collection = compiled.collection();
}, 300_000);

const variables = () =>
	Object.fromEntries((collection.variable ?? []).map((variable) => [variable.key, variable.value]));
const path = (name: string, folder?: string) =>
	requestNamed(collection, name, folder).request?.url.path;
const script = (name: string, folder?: string) =>
	scriptOf(requestNamed(collection, name, folder)).join("\n");

describe("a 201 with a Location and no body at all", () => {
	it("chains from the header, which is the only thing the response carries", () => {
		expect(script("create", "Crates")).toContain('pm.collectionVariables.set("crateId", id);');
		expect(path("read", "Crates")).toEqual(["crates", "{{crateId}}"]);
	});

	it("asserts the response has no body, and still says where the resource lives", () => {
		expect(script("create", "Crates")).toContain("Response has no body");
		expect(script("create", "Crates")).toContain("location identifies the created crate");
	});
});

/**
 * A POST that answers 200 with the resource creates it just as plainly as one that answers 201; the
 * status is a statement about the response, not about what happened. Read any other way, the
 * collection would create a pallet and then ask for its id to be supplied.
 */
describe("a POST that answers 200 with the resource", () => {
	it("chains from its body", () => {
		expect(script("create", "Pallets")).toContain(
			'pm.collectionVariables.set("palletId", pm.response.json()["id"]);',
		);
		expect(variables()["palletId"]).toBe("");
	});

	it("leaves the read checking, rather than skipped for want of an id", () => {
		expect(script("read", "Pallets")).not.toContain("pm.test.skip");
		expect(script("read", "Pallets")).toContain("Returns the requested pallet");
	});
});

/**
 * 202 means accepted, and RFC 9110 15.3.3 does not say its `Location` identifies a created resource
 * the way 9.3.1 does for a 201. The body still carries the id, so the chain holds; the header is
 * asserted present and nothing more, because nothing more is known about it.
 */
describe("a POST that answers 202 while the work finishes", () => {
	it("chains from the body", () => {
		expect(script("start", "Jobs")).toContain(
			'pm.collectionVariables.set("jobId", pm.response.json()["id"]);',
		);
		expect(path("read", "Jobs")).toEqual(["jobs", "{{jobId}}"]);
	});

	it("claims no more about its Location than that it is there", () => {
		expect(script("start", "Jobs")).toContain("location header is present");
		expect(script("start", "Jobs")).not.toContain("location identifies");
	});
});

describe("a read that answers a detail view rather than the model the create takes", () => {
	it("is still the resource's read: one variable for the route, not two", () => {
		expect(Object.keys(variables())).not.toContain("parcelDetailId");
		expect(path("read", "Parcels")).toEqual(["parcels", "{{parcelId}}"]);
	});

	it("keeps the check that it returned what was asked for, and its not-found case", () => {
		expect(script("read", "Parcels")).toContain("Returns the requested parcel");
		expect(script("read: not found", "Error cases")).toContain("Status code is 404");
	});
});

describe("a resource nothing creates, with a child that is created under it", () => {
	it("asks the run for the parent and derives the child", () => {
		expect(variables()["depotId"]).toBe("00000000-0000-0000-0000-000000000000");
		expect(variables()["bayId"]).toBe("");
	});

	it("guards every request that cannot run without the parent, the child's create included", () => {
		expect(script("create", "Bays")).toContain(
			'pm.test.skip("Status code is 201 (needs depotId)", function () {});',
		);
		expect(path("read", "Bays")).toEqual(["depots", "{{depotId}}", "bays", "{{bayId}}"]);
	});
});

describe("a PUT that names the id it creates", () => {
	it("chains from the Location where its body wraps the resource", () => {
		expect(script("assign", "Slots")).toContain('pm.collectionVariables.set("slotName", id);');
		expect(path("read", "Slots")).toEqual(["slots", "{{slotName}}"]);
	});
});

/**
 * RFC 9110 9.3.4: a PUT answers 201 when it created the resource and 200 when it replaced one that
 * was already there, so the status is the only thing that tells those apart. Treating every PUT as a
 * create gave a replace a capture of the id it had just been sent.
 */
describe("a PUT at an item route that answers 200", () => {
	it("is a replace, and creates nothing", () => {
		expect(script("replace", "Labels")).not.toContain("collectionVariables.set");
		expect(script("create", "Labels")).toContain(
			'pm.collectionVariables.set("labelId", pm.response.json()["id"]);',
		);
	});
});

/**
 * Two ids a run has to supply for one request, one of them a number. A collection variable is always
 * declared `type: "string"`, so the number reads back as text and the guard has to compare it as one.
 */
describe("several resources nothing creates, needed by one request", () => {
	it("holds a numeric key as the text a collection variable carries", () => {
		expect(variables()["rackId"]).toBe("0");
	});

	it("guards on every one of them, and names them all", () => {
		expect(script("read", "Racks")).toContain(
			'const unmet = [["depotId","00000000-0000-0000-0000-000000000000"],["rackId","0"]].some(([name, placeholder]) =>',
		);
		expect(script("read", "Racks")).toContain(
			'pm.test.skip("Status code is 200 (needs depotId and rackId)", function () {});',
		);
	});

	it("fills both into the route", () => {
		expect(path("read", "Racks")).toEqual(["depots", "{{depotId}}", "racks", "{{rackId}}"]);
	});
});

describe("the whole survey", () => {
	it("derives a resource for every collection in it, and reports only the replace's missing example", () => {
		expect(Object.keys(variables()).toSorted()).toEqual([
			"baseUrl",
			"bayId",
			"crateId",
			"depotId",
			"endpoint",
			"jobId",
			"labelId",
			"palletId",
			"parcelId",
			"rackId",
			"slotName",
		]);
		/**
		 * The replace is an update with no `@opExample`, so there is nothing to assert a field was
		 * changed to. That is the existing rule working, and it is stated here so a NEW code appearing
		 * in this survey fails rather than passing unnoticed.
		 */
		expect(codes(compiled)).toEqual(["typespec-postman/update-without-example"]);
	});
});
