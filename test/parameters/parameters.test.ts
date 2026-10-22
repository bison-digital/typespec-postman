import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture, type PostmanCollection, requestNamed } from "../support/compile.js";

/**
 * **Path and query parameters, taken from the resolved operation's URI template.** A whole-segment
 * parameter is a Postman path variable; any other expansion is written as RFC 6570 expands it,
 * because `HttpOperation.path` drops the operator and the URL would stop matching the route.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
let collection: PostmanCollection;

beforeAll(async () => {
	collection = (await compileFixture(here, "parameters", { outName: "parameters" })).collection();
}, 180_000);

const url = (name: string) => requestNamed(collection, name).request?.url;

describe("path parameters", () => {
	it("makes a whole-segment parameter a Postman path variable with a value", () => {
		expect(url("simple")?.path).toEqual(["items", ":id"]);
		expect(url("simple")?.variable).toEqual([{ key: "id", value: "0" }]);
	});

	it("writes a label expansion with its leading dot", () => {
		expect(url("label")?.path).toEqual(["labels", ".color"]);
	});

	it("writes a matrix expansion as ;name=value", () => {
		expect(url("matrix")?.path).toEqual(["matrix", ";color=color"]);
	});

	it("writes a reserved expansion and an optional segment as the segment they expand to", () => {
		expect(url("reserved")?.path).toEqual(["files", "path"]);
		expect(url("optionalSegment")?.path).toEqual(["optional", "segment"]);
	});

	it("gives a formatted parameter a value in that format", () => {
		expect(url("formats")?.variable).toEqual([
			{ key: "id", value: "00000000-0000-0000-0000-000000000000" },
		]);
	});
});

describe("query parameters", () => {
	it("enables a required parameter and lists an optional one disabled", () => {
		expect(url("search")?.query).toEqual([
			{ key: "term", value: "term" },
			{ key: "limit", value: "0", disabled: true },
			{ key: "tags", value: "tags" },
			{ key: "colors", value: "colors" },
		]);
	});

	it("never sends a required list empty, which would not be sent at all", () => {
		expect(url("search")?.raw).toBe("{{baseUrl}}/search?term=term&tags=tags&colors=colors");
	});

	/**
	 * RFC 6570 section 2.3 treats an empty associative array as undefined, so `{}` expands to nothing
	 * and a server validating a required record refuses the request. One entry, keyed by the
	 * parameter's name as a generated string is, is the least that is still sent.
	 */
	it("never sends a required record empty, in the path or the query", () => {
		expect(url("pathRecord")?.path).toEqual(["filters", "by,0"]);
		expect(url("queryRecord")?.query).toEqual([{ key: "filter", value: "filter,0" }]);
	});

	it("takes values from @opExample, enabling an optional parameter the example sets", () => {
		expect(url("exampled")?.query).toEqual([
			{ key: "term", value: "bridges" },
			{ key: "limit", value: "5" },
			{ key: "tags", value: "a" },
			{ key: "tags", value: "b" },
			{ key: "colors", value: "red,blue" },
		]);
	});

	it("satisfies declared bounds and lengths", () => {
		expect(url("bounded")?.query).toEqual([
			{ key: "page", value: "10" },
			{ key: "code", value: "codex" },
		]);
	});

	it("percent-encodes a value as form expansion requires", () => {
		expect(url("formats")?.query).toEqual([{ key: "at", value: "1970-01-01T00%3A00%3A00Z" }]);
	});
});
