import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { compileFixture, type PostmanCollection, requestNamed } from "../support/compile.js";

/**
 * **Headers the operation declares, and the two a request needs to be understood**: the body's
 * `Content-Type`, always explicit, and an `Accept` naming what the success response returns.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
let collection: PostmanCollection;

beforeAll(async () => {
	collection = (await compileFixture(here, "headers", { outName: "headers" })).collection();
}, 180_000);

const headers = (name: string) => requestNamed(collection, name).request?.header;

describe("declared headers", () => {
	it("enables a required header and lists an optional one disabled", () => {
		expect(headers("required")).toEqual([
			{ key: "X-Request-Id", value: "requestId" },
			{ key: "X-Trace", value: "trace", disabled: true },
			{ key: "Accept", value: "application/json" },
		]);
	});

	it("takes example values, a date-time in the rfc7231 form a header carries", () => {
		expect(headers("exampled")).toEqual([
			{ key: "X-Trace", value: "abc" },
			{ key: "If-Modified-Since", value: "Thu, 02 Jan 2020 03:04:05 GMT" },
			{ key: "Accept", value: "application/json" },
		]);
	});

	it("sends cookie parameters as one Cookie header, required ones only", () => {
		expect(headers("cookies")).toEqual([{ key: "Cookie", value: "session=session" }]);
	});
});

describe("content negotiation headers", () => {
	it("states the JSON body's Content-Type", () => {
		expect(headers("json")).toEqual([
			{ key: "Content-Type", value: "application/json" },
			{ key: "Accept", value: "application/json" },
		]);
	});

	it("states a merge patch as merge patch, not as plain JSON", () => {
		expect(headers("merge")?.[0]).toEqual({
			key: "Content-Type",
			value: "application/merge-patch+json",
		});
	});

	it("states a text body as text", () => {
		expect(headers("text")).toEqual([{ key: "Content-Type", value: "text/plain" }]);
		expect(requestNamed(collection, "text").request?.body).toEqual({
			mode: "raw",
			raw: "string",
			options: { raw: { language: "text" } },
		});
	});

	it("sends neither where there is no body in either direction", () => {
		expect(headers("nothing")).toEqual([]);
	});
});
