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

/** A script's `pm.test` blocks by their names, each with its lines, plus any line outside a block. */
function blocks(lines: readonly string[]): { readonly name: string; readonly lines: string[] }[] {
	const out: { name: string; lines: string[] }[] = [];
	for (const line of lines) {
		const opened = /^pm\.test\((".*?"), function \(\) \{$/.exec(line);
		if (opened !== null) out.push({ name: JSON.parse(opened[1] ?? '""') as string, lines: [line] });
		else if (out.length > 0 && !line.startsWith("pm.collectionVariables"))
			out.at(-1)?.lines.push(line);
		else out.push({ name: "", lines: [line] });
	}
	return out;
}

/** The response checks every request carries, which the role arms below leave to their own describe. */
const RESPONSE_CHECK =
	/^(Status code|Content-Type header|.* header is present$|Response has no body$|Response matches the schema)/;

/** The script minus the status and response checks: what the chaining convention's role adds. */
const roleScript = (name: string, folder?: string) =>
	blocks(script(name, folder))
		.filter((block) => !RESPONSE_CHECK.test(block.name))
		.flatMap((block) => block.lines);

describe("the status", () => {
	it("is asserted exactly where one 2xx is declared", () => {
		expect(script("read", "Accounts").slice(0, 3)).toEqual([
			'pm.test("Status code is 200", function () {',
			"    pm.response.to.have.status(200);",
			"});",
		]);
	});

	it("is asserted as one of several where several are declared", () => {
		expect(script("either").slice(0, 3)).toEqual([
			'pm.test("Status code is one of 200, 202", function () {',
			"    pm.expect(pm.response.code).to.be.oneOf([200, 202]);",
			"});",
		]);
	});

	it("is asserted within a declared range", () => {
		expect(script("ranged").slice(0, 3)).toEqual([
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
		expect(roleScript("list", "Accounts")).toEqual([
			'pm.test("Response is an array", function () {',
			'    pm.expect(pm.response.json()).to.be.an("array");',
			"});",
		]);
	});

	it("a read returns the resource that was asked for", () => {
		expect(roleScript("read", "Accounts")).toEqual([
			'pm.test("Returns the requested account", function () {',
			'    pm.expect(String(pm.response.json()["id"])).to.eql(pm.variables.get("accountId"));',
			"});",
		]);
	});

	it("an update holds each example field it sent, leaving out a date-time a server may re-spell", () => {
		expect(roleScript("update", "Accounts")).toEqual([
			'pm.test("name was updated", function () {',
			'    pm.expect(pm.response.json()["name"]).to.eql("Renamed");',
			"});",
			'pm.test("seats was updated", function () {',
			'    pm.expect(pm.response.json()["seats"]).to.eql(3);',
			"});",
		]);
	});

	it("an update with no example asserts its status alone, and says why", () => {
		expect(roleScript("replace", "Accounts")).toEqual([]);
		const messages = compiled.diagnostics.map((d) => d.message);
		expect(messages).toContain(
			"Update operation 'replace' has no @opExample, so no assertion that a field was updated can be derived.",
		);
		expect(messages).toContain(
			"Update operation 'update' has no @opExample and its body has no required property, so the request sends an empty object and no assertion that a field was updated can be derived.",
		);
	});
});

describe("a resource whose model carries a property the response never does", () => {
	/**
	 * `@typespec/http` resolves such a response body to an anonymous copy of the model at Read
	 * visibility, and `@typespec/openapi3` publishes it as the named model through
	 * `getEffectivePayloadType`. The roles follow the model the document names.
	 */
	it("still reads the resource it created", () => {
		expect(roleScript("read", "Members")).toEqual([
			'pm.test("Returns the requested member", function () {',
			'    pm.expect(String(pm.response.json()["id"])).to.eql(pm.variables.get("memberId"));',
			"});",
		]);
	});

	it("asserts only the example fields a response carries, never a write-only one", () => {
		expect(roleScript("update", "Members")).toEqual([
			'pm.test("name was updated", function () {',
			'    pm.expect(pm.response.json()["name"]).to.eql("Renamed");',
			"});",
		]);
	});
});

describe("the response contract every request checks", () => {
	it("checks the declared media type with include, so a charset parameter still passes", () => {
		expect(
			blocks(script("read", "Accounts")).find((block) => block.name.startsWith("Content-Type"))
				?.lines,
		).toEqual([
			'pm.test("Content-Type header is application/json", function () {',
			'    pm.expect(String(pm.response.headers.get("Content-Type")).toLowerCase()).to.include("application/json");',
			"});",
		]);
	});

	it("checks each header every declared response requires", () => {
		expect(
			blocks(script("create", "Accounts")).find((block) => block.name.endsWith("header is present"))
				?.lines,
		).toEqual([
			'pm.test("location header is present", function () {',
			'    pm.response.to.have.header("location");',
			"});",
		]);
	});

	it("checks that a response declared without a body has none", () => {
		expect(blocks(script("either")).map((block) => block.name)).toEqual([
			"Status code is one of 200, 202",
			"Response has no body",
		]);
	});

	it("checks the body against its draft-07 schema, declaring the formats Ajv 6 does not know", () => {
		const [line] =
			blocks(script("read", "Accounts"))
				.find((block) => block.name === "Response matches the schema")
				?.lines.slice(1, 2) ?? [];
		const match =
			/^ {4}pm\.response\.to\.have\.jsonSchema\((.*), \{ unknownFormats: (\[.*\]) \}\);$/.exec(
				line ?? "",
			);
		expect(match).not.toBeNull();
		const schema = JSON.parse(match?.[1] ?? "null") as { $defs?: Record<string, unknown> };
		expect(Object.keys(schema.$defs ?? {})).toEqual(["Account"]);
		expect(JSON.parse(match?.[2] ?? "[]")).toEqual(["int32"]);
	});
});
