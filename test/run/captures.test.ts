import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type Compiled,
	compileFixture,
	type PostmanItem,
	requestNamed,
} from "../support/compile.js";
import { type RunResult, runCollection } from "../support/postman.js";

/**
 * **A create mutation's capture script, run by the Postman CLI against the answers a GraphQL server
 * can give**, so Postman's own sandbox grades it, not a reading of its text. Each answer is followed
 * by a request that checks the variable and sets it back to what the REST folders would have left
 * in it: the id of the member that names one, and nothing at all where the answer names none.
 *
 * The scripts are `located.tsp`'s: `createReview`, whose success members hold the id at different
 * paths, one at none, so its script looks the path up by `__typename`; and `createBook`, whose one
 * member holds it at one path, read there.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const STALE = "left by the REST folders";

interface Scenario {
	readonly mutation: "mutation createReview" | "mutation createBook";
	readonly variable: "reviewId" | "bookId";
	readonly answer: unknown;
	/** Whether "Response has an id" passes, and what the variable holds after it. */
	readonly captured: boolean;
	readonly holds: string | undefined;
}

const SCENARIOS: readonly Scenario[] = [
	{
		mutation: "mutation createReview",
		variable: "reviewId",
		answer: { data: { createReview: { __typename: "Review", id: "r1", rating: 4 } } },
		captured: true,
		holds: "r1",
	},
	{
		mutation: "mutation createReview",
		variable: "reviewId",
		answer: { data: { createReview: { __typename: "CreateReviewAccepted", success: true } } },
		captured: false,
		holds: undefined,
	},
	{
		mutation: "mutation createReview",
		variable: "reviewId",
		answer: { data: null, errors: [{ message: "refused" }] },
		captured: false,
		holds: undefined,
	},
	{
		mutation: "mutation createBook",
		variable: "bookId",
		answer: { data: { createBook: { __typename: "Book", id: "b1", title: "Dune" } } },
		captured: true,
		holds: "b1",
	},
	{
		mutation: "mutation createBook",
		variable: "bookId",
		answer: { data: { createBook: { __typename: "Book", id: 7, title: "Dune" } } },
		captured: false,
		holds: undefined,
	},
	{
		mutation: "mutation createBook",
		variable: "bookId",
		answer: { data: { createBook: null }, errors: [{ message: "refused" }] },
		captured: false,
		holds: undefined,
	},
];

let compiled: Compiled;
let server: Server;
let run: RunResult;

beforeAll(async () => {
	compiled = await compileFixture(join(here, "..", "graphql"), "located", {
		graphql: "before",
		outName: "captures",
	});
	server = createServer((request, response) => {
		const index = /^\/scenario\/(\d+)$/.exec(request.url ?? "")?.[1];
		const answer = index === undefined ? {} : SCENARIOS[Number(index)]?.answer;
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(answer ?? {}));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	const collection = compiled.collection();
	const items: PostmanItem[] = SCENARIOS.flatMap((scenario, index): PostmanItem[] => {
		const mutation = requestNamed(collection, scenario.mutation, "GraphQL");
		const expected =
			scenario.holds === undefined
				? "to.be.undefined"
				: `to.equal(${JSON.stringify(scenario.holds)})`;
		return [
			{
				...mutation,
				id: `answer-${index}`,
				name: `answer ${index}`,
				request: { ...mutation.request, url: `{{baseUrl}}/scenario/${index}` } as never,
			},
			{
				id: `check-${index}`,
				name: `check ${index}`,
				request: { method: "GET", url: "{{baseUrl}}/check" } as never,
				event: [
					{
						listen: "test",
						script: {
							exec: [
								`pm.test("holds", function () { pm.expect(pm.collectionVariables.get(${JSON.stringify(scenario.variable)})).${expected}; });`,
								`pm.collectionVariables.set(${JSON.stringify(scenario.variable)}, ${JSON.stringify(STALE)});`,
							],
						},
					},
				],
			} as PostmanItem,
		];
	});
	const out = join(here, ".out", "captures");
	mkdirSync(out, { recursive: true });
	const file = join(out, "captures.postman_collection.json");
	writeFileSync(
		file,
		JSON.stringify({
			info: {
				name: "captures",
				schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
			},
			item: items,
			variable: [
				{ key: "reviewId", value: STALE },
				{ key: "bookId", value: STALE },
			],
		}),
	);
	run = await runCollection(
		file,
		{ baseUrl: `http://127.0.0.1:${port}` },
		join(out, "report.json"),
	);
}, 600_000);

afterAll(async () => {
	await new Promise((resolve) => server?.close(resolve));
});

describe("a create mutation's capture, run by the Postman CLI", () => {
	it("runs every answer and every check", () => {
		expect(run.executions.map((execution) => execution.name)).toEqual(
			SCENARIOS.flatMap((_, index) => [`answer ${index}`, `check ${index}`]),
		);
	});

	it.each(SCENARIOS.map((scenario, index) => [index, scenario] as const))(
		"answer %i: captures only an id of the declared type the member names, and unsets the variable otherwise",
		(index, scenario) => {
			const answered = run.executions.find((execution) => execution.name === `answer ${index}`);
			const captured = answered?.tests.find((test) => test.name === "Response has an id");
			expect(captured?.status, run.output).toBe(scenario.captured ? "passed" : "failed");
			const check = run.executions.find((execution) => execution.name === `check ${index}`);
			expect(check?.tests, run.output).toEqual([{ name: "holds", status: "passed" }]);
		},
	);
});
