import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileSpec } from "../support/compile.js";
import { runCollection } from "../support/postman.js";

/**
 * **Every route a request is sent to, byte for byte, as Microsoft's own mock server expects it.**
 *
 * `@typespec/http-specs` `routes` is the corpus's scenario for RFC 6570 expansion: simple, path,
 * label, matrix, reserved and query expansion, each exploded and not, over a primitive, a list and a
 * record, plus query continuation after a literal query string. Its `mockapi.ts` states the exact
 * URI each operation must be called with for the values its scenario documents: `a`, `["a", "b"]`,
 * `{a: 1, b: 2}`, `"foo/bar baz"` and one model.
 *
 * Those values are given to each operation as an `@opExample`, the collection is run by the Postman
 * CLI against a socket that records the request line, and every recorded URL must be one the mock
 * lists. **The expectation is the mock's**, and the bytes are the CLI's. No other oracle here grades a
 * route: `@typespec/openapi3` refuses this scenario outright (`path-query`), so neither the corpus
 * document judge nor Postman's importer ever sees it.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const scenario = fileURLToPath(
	new URL("../../node_modules/@typespec/http-specs/specs/routes/", import.meta.url),
);

/**
 * The value each operation's scenario documents, by operation name. `reserved` is the one namespace
 * whose operations reuse other names for a different value.
 */
function documentedValue(operation: string, reserved: boolean): string {
	if (reserved) return '"foo/bar baz"';
	switch (operation) {
		case "array":
			return '#["a", "b"]';
		case "record":
			return "#{ a: 1, b: 2 }";
		case "model":
			return '#{ field: "status", value: "active" }';
		default:
			return '"a"';
	}
}

/** The scenario's `main.tsp` with each operation's documented value as its `@opExample`. */
function withDocumentedValues(source: string): { text: string; examples: number } {
	let reserved = false;
	let examples = 0;
	const lines = source.split("\n").map((line) => {
		if (/namespace ReservedExpansion\b/.test(line)) reserved = true;
		if (/namespace SimpleExpansion\b/.test(line)) reserved = false;
		const declared = /^(\s*)op `?(\w+)`?\((.*)\): void;$/.exec(line);
		if (declared === null || !/\bparam\b/.test(declared[3] ?? "")) return line;
		examples++;
		const value = documentedValue(declared[2] ?? "", reserved);
		return `${declared[1]}@opExample(#{ parameters: #{ param: ${value} } })\n${line}`;
	});
	return { text: lines.join("\n"), examples };
}

let server: Server;
const received: string[] = [];
let expected: string[] = [];
let examples = 0;
let exitCode = -1;

beforeAll(async () => {
	const dir = join(here, ".out", "routes");
	mkdirSync(dir, { recursive: true });
	const injected = withDocumentedValues(readFileSync(join(scenario, "main.tsp"), "utf8"));
	examples = injected.examples;
	writeFileSync(join(dir, "main.tsp"), injected.text);
	expected = [
		...readFileSync(join(scenario, "mockapi.ts"), "utf8").matchAll(/createTests\(\s*"([^"]+)"/g),
	].map((match) => match[1] ?? "");

	const compiled = await compileSpec(join(dir, "main.tsp"), join(dir, "out"));
	expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

	server = createServer((request, response) => {
		received.push(request.url ?? "");
		request.resume();
		request.on("end", () => response.writeHead(204).end());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const result = await runCollection(
		join(dir, "out", "postman_collection.json"),
		{ baseUrl: `http://127.0.0.1:${port}` },
		join(dir, "report.json"),
	);
	exitCode = result.exitCode;
}, 600_000);

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("routes are sent exactly as http-specs' mock expects them", () => {
	it("gave every parameterised operation its documented value, and sent every request", () => {
		// 45 of the scenario's 47 operations take `param`; the other two are fixed routes.
		expect(examples).toBe(45);
		expect(expected).toHaveLength(47);
		expect(received).toHaveLength(expected.length);
		expect(exitCode).toBe(0);
	});

	it("sends each request to a URL the mock lists, and reaches every URL it lists", () => {
		const listed = new Set(expected);
		const sent = new Set(received);
		expect(received.filter((url) => !listed.has(url))).toEqual([]);
		expect(expected.filter((url) => !sent.has(url))).toEqual([]);
	});
});
