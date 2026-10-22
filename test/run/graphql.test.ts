import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookshopHandlers, type Mutant } from "./bookshop.fixture.js";
import {
	type Compiled,
	compileSpec,
	type PostmanCollection,
	type PostmanItem,
	requestsOf,
} from "../support/compile.js";
import { type RunResult, runCollection } from "../support/postman.js";
import { type Served, serveGenerated } from "../support/server.js";

/**
 * **The collection runs green against a server serving the spec over REST and over GraphQL**, the
 * GraphQL surface typespec-http-graphql emitted mounted at `/v1/graphql` through GraphQL Yoga beside
 * the REST routes, both calling one handler object.
 *
 * The REST half is the worked example's own collection, so its counts are `run.test.ts`'s. Every
 * expectation below is stated from `graphql.tsp`, not read off this emitter.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Stated, as a reader counts them.
 *
 * Requests: the example's sixteen; then the GraphQL folder's copies of the two creates the GraphQL
 * reads need (authors' and books'), and one request for each of the ten root fields `graphql.tsp`
 * declares.
 *
 * Assertions: the example's fifty-five; each copied create's five (its status, its body's
 * Content-Type and schema, its `location`, and that the id came back), and one per GraphQL request.
 */
const EXPECTED_REQUESTS = 16 + 2 + 10;
const EXPECTED_ASSERTIONS = 55 + 2 * 5 + 10;

const CREDENTIALS = { bearerAuth: "token", shopKey: "key" } as const;

let compiled: Compiled;
let served: Served | undefined;
/** Every handler call, by the surface it came through, with the input it received. */
let calls: { readonly operationId: string; readonly surface: string; readonly input: unknown }[];

beforeAll(async () => {
	compiled = await compileSpec(join(here, "graphql.tsp"), join(here, ".out", "graphql"), {
		openapi: true,
		hono: true,
		graphql: "before",
	});
	expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
}, 600_000);

afterEach(async () => {
	await served?.close();
	served = undefined;
});

async function run(
	name: string,
	options: {
		readonly mutant?: Mutant;
		readonly collection?: (collection: PostmanCollection) => PostmanCollection;
	} = {},
): Promise<RunResult> {
	calls = [];
	const handlers = bookshopHandlers(options.mutant ?? "none");
	const logged = Object.fromEntries(
		Object.entries(handlers).map(([operationId, handler]) => [
			operationId,
			(ctx: unknown, input: Record<string, unknown>) => {
				calls.push({ operationId, surface: (ctx as { surface?: string }).surface ?? "", input });
				return handler(ctx, input);
			},
		]),
	);
	served = await serveGenerated(compiled.serverDir, compiled.document(), "/v1", logged, {
		graphql: true,
	});
	let file = join(compiled.outDir, "postman_collection.json");
	if (options.collection !== undefined) {
		file = join(compiled.outDir, `${name}.postman_collection.json`);
		writeFileSync(file, JSON.stringify(options.collection(compiled.collection())));
	}
	return runCollection(
		file,
		{ endpoint: served.origin, ...CREDENTIALS },
		join(here, ".out", "graphql-reports", `${name}.json`),
	);
}

const GRAPHQL = /^(query|mutation) /;

function failedTests(result: RunResult): string[] {
	return result.executions.flatMap((execution) =>
		execution.tests
			.filter((test) => test.status !== "passed" && test.status !== "skipped")
			.map((test) => `${execution.name}: ${test.name}`),
	);
}

/** An id is a fresh uuid on each surface, so inputs are compared with each one masked. */
function masked(value: unknown): unknown {
	return JSON.parse(
		JSON.stringify(value).replaceAll(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
			"<id>",
		),
	);
}

/** The collection with one GraphQL request changed. */
function changing(name: string, change: (item: PostmanItem) => PostmanItem) {
	return (collection: PostmanCollection): PostmanCollection => {
		const walk = (items: readonly PostmanItem[]): PostmanItem[] =>
			items.map((item) =>
				item.item !== undefined
					? { ...item, item: walk(item.item) }
					: item.name === name
						? change(item)
						: item,
			);
		return { ...collection, item: walk(collection.item) };
	};
}

describe("a collection with GraphQL requests, run against REST and GraphQL served together", () => {
	it("exits 0, every request and assertion passing, counted as a reader counts them", async () => {
		const result = await run("green");
		expect(failedTests(result), result.output).toEqual([]);
		expect(result.exitCode, result.output).toBe(0);
		expect(requestsOf(compiled.collection())).toHaveLength(EXPECTED_REQUESTS);
		expect(result.executions).toHaveLength(EXPECTED_REQUESTS);
		expect(result.executions.flatMap((execution) => execution.tests)).toHaveLength(
			EXPECTED_ASSERTIONS,
		);
	});

	it("calls each GraphQL request's operation with the input its REST request sends", async () => {
		await run("inputs");
		const graphql = calls.filter((call) => call.surface === "graphql");
		expect(graphql.map((call) => call.operationId).toSorted()).toEqual(
			[
				"Authors_create",
				"Authors_delete",
				"Authors_list",
				"Authors_read",
				"Authors_update",
				"Books_create",
				"Books_delete",
				"Books_list",
				"Books_read",
				"health",
			].toSorted(),
		);
		for (const call of graphql) {
			const rest = calls.find(
				(candidate) => candidate.surface === "rest" && candidate.operationId === call.operationId,
			);
			expect(masked(call.input), call.operationId).toEqual(masked(rest?.input));
		}
	});
});

describe("the GraphQL requests go red on a server that does not answer them", () => {
	it("on a variable of the wrong type", async () => {
		const result = await run("wrong-variable", {
			collection: changing("query author", (item) => ({
				...item,
				request: {
					...(item.request as NonNullable<PostmanItem["request"]>),
					body: {
						mode: "graphql",
						graphql: { query: graphqlOf(item).query, variables: '{ "authorId": 7 }' },
					},
				},
			})),
		});
		expect(failedTests(result).filter((test) => test.startsWith("query author"))).not.toEqual([]);
		expect(result.exitCode).not.toBe(0);
	});

	it("on a request sent without its credential", async () => {
		const result = await run("no-credential", {
			collection: changing("query author", (item) => ({
				...item,
				request: {
					...(item.request as NonNullable<PostmanItem["request"]>),
					auth: { type: "noauth" },
				},
			})),
		});
		expect(failedTests(result).filter((test) => test.startsWith("query author"))).not.toEqual([]);
	});

	it("on a read answering 404, which GraphQL answers null", async () => {
		const result = await run("read-misses", { mutant: "read-misses" });
		expect(failedTests(result).filter((test) => test.startsWith("query author"))).not.toEqual([]);
	});

	it("on a mutation answering its declared refusal, a member of its result union", async () => {
		const result = await run("create-misses", { mutant: "create-book-misses" });
		expect(
			failedTests(result).filter((test) => test.startsWith("mutation createBook")),
		).not.toEqual([]);
	});

	it("names every failing GraphQL request by its field", async () => {
		const result = await run("read-misses-names", { mutant: "read-misses" });
		expect(failedTests(result).filter((test) => GRAPHQL.test(test))).toEqual([
			"query author: GraphQL answers author",
		]);
	});
});

function graphqlOf(item: PostmanItem): { readonly query: string; readonly variables: string } {
	const body = item.request?.body as
		| { readonly graphql?: { readonly query: string; readonly variables: string } }
		| undefined;
	if (body?.graphql === undefined) throw new Error(`${item.name} is no GraphQL request`);
	return body.graphql;
}
