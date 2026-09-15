import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookshopHandlers, type Mutant } from "./bookshop.fixture.js";
import { edgesHandlers } from "./edges.fixture.js";
import {
	type Compiled,
	compileSpec,
	type PostmanCollection,
	requestsOf,
} from "../support/compile.js";
import { type RunResult, runCollection } from "../support/postman.js";
import { type Served, serveGenerated } from "../support/server.js";

/**
 * **The collection runs green against a server implementing the same spec, through the Postman CLI.**
 *
 * This is acceptance criterion 2 at its real entry point: the CLI a team runs, the file the emitter
 * wrote, and a typespec-hono server generated from the same `.tsp`. It is the only suite here that
 * executes a request, so it is the only one that can see a body the server refuses, a header the
 * collection forgot, or an id that never reaches the request that needs it.
 *
 * **Every expectation comes from outside this emitter**: statuses from `@typespec/openapi3`'s
 * document, auth locations from its `securitySchemes`, and request and assertion counts stated
 * below as literals. Grading the run against counts the emitter itself derived would grade it
 * against itself.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const example = fileURLToPath(new URL("../../example/main.tsp", import.meta.url));

/** Stated, not derived: ten operations, and the assertions a reader can count in the spec. */
const EXPECTED_REQUESTS = 10;
const EXPECTED_ASSERTIONS = 17;

const CREDENTIALS = { bearerAuth: "token", shopKey: "key" } as const;

let compiled: Compiled;
let served: Served | undefined;

beforeAll(async () => {
	compiled = await compileSpec(example, join(here, ".out", "bookshop"), {
		openapi: true,
		hono: true,
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
		readonly server?: Parameters<typeof serveGenerated>[4];
		readonly collection?: (collection: PostmanCollection) => PostmanCollection;
	} = {},
): Promise<RunResult> {
	served = await serveGenerated(
		compiled.serverDir,
		compiled.document(),
		"/v1",
		bookshopHandlers(options.mutant ?? "none"),
		options.server,
	);
	let file = join(compiled.outDir, "postman_collection.json");
	if (options.collection !== undefined) {
		file = join(compiled.outDir, `${name}.postman_collection.json`);
		writeFileSync(file, JSON.stringify(options.collection(compiled.collection())));
	}
	return runCollection(
		file,
		{ endpoint: served.origin, ...CREDENTIALS },
		join(here, ".out", "reports", `${name}.json`),
	);
}

/** `/authors/:authorId` and `/authors/{{authorId}}` -> `/authors/{}`, as a document path normalises. */
function normalise(path: readonly string[]): string {
	return `/${path.map((segment) => (segment.startsWith(":") || segment.startsWith("{{") ? "{}" : segment)).join("/")}`;
}

function failedTests(result: RunResult): string[] {
	return result.executions.flatMap((execution) =>
		execution.tests
			.filter((test) => test.status !== "passed")
			.map((test) => `${execution.name}: ${test.name}`),
	);
}

describe("the generated collection runs green against a server generated from the same spec", () => {
	it("exits 0 with every request answered by a status the spec declares for it", async () => {
		const result = await run("green");
		expect(failedTests(result), result.output).toEqual([]);
		expect(result.exitCode, result.output).toBe(0);

		const document = compiled.document();
		const byId = new Map(requestsOf(compiled.collection()).map(({ item }) => [item.id, item]));
		const offenders = result.executions.flatMap((execution) => {
			const item = byId.get(execution.id);
			if (item?.request === undefined)
				return [`${execution.name}: not a request in the collection`];
			const path = normalise(item.request.url.path);
			const operation = Object.entries(document.paths).find(
				([template]) => template.replace(/\{[^}]+\}/g, "{}") === path,
			)?.[1]?.[item.request.method.toLowerCase()];
			const declared = Object.keys(operation?.responses ?? {});
			return declared.includes(String(execution.code))
				? []
				: [`${item.request.method} ${path}: ${execution.code} not in ${declared.join(",")}`];
		});
		expect(offenders).toEqual([]);
	});

	it("sends the number of requests and assertions a reader counts in the spec", async () => {
		const result = await run("counts");
		expect(result.executions).toHaveLength(EXPECTED_REQUESTS);
		expect(result.executions.flatMap((execution) => execution.tests)).toHaveLength(
			EXPECTED_ASSERTIONS,
		);
	});

	it("runs a created author's id into every request that names it, including the nested books", async () => {
		const result = await run("chain");
		const codes = result.executions.map(
			(execution) => `${execution.method} ${execution.name} ${execution.code}`,
		);
		expect(codes).toEqual([
			"GET health 200",
			"POST create 201",
			"GET list 200",
			"GET read 200",
			"PATCH update 200",
			"POST create 201",
			"GET list 200",
			"GET read 200",
			"DELETE delete 204",
			"DELETE delete 204",
		]);
	});
});

/**
 * **Each arm proves the collection can fail, on the assertion that is supposed to catch that fault.**
 * A mutant that turned the run red for some unrelated reason would prove nothing about the check it
 * names, so every arm names the failing test as well as the exit code.
 */
describe("the collection goes red against a server that disagrees with the spec", () => {
	it("when a create answers 200 instead of the 201 the spec declares", async () => {
		const result = await run("mutant-status", {
			server: { rewriteStatus: { from: 201, to: 200 } },
		});
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("create: Status code is 201");
	});

	it("when a create returns no id", async () => {
		const result = await run("mutant-no-id", {
			mutant: "create-omits-id",
			server: { unvalidated: true },
		});
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("create: Response has an id");
	});

	it("when a create returns an id of the wrong type", async () => {
		const result = await run("mutant-numeric-id", {
			mutant: "create-numeric-id",
			server: { unvalidated: true },
		});
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("create: Response has an id");
	});

	it("when a list returns something that is not a list", async () => {
		const result = await run("mutant-list", {
			mutant: "list-returns-object",
			server: { unvalidated: true },
		});
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("list: Response items is an array");
	});

	it("when a read returns a different resource from the one requested", async () => {
		const result = await run("mutant-read", { mutant: "read-returns-other" });
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("read: Returns the requested author");
	});

	it("when a list returned as a bare array returns something that is not a list", async () => {
		const result = await run("mutant-bare-list", {
			mutant: "bare-list-returns-object",
			server: { unvalidated: true },
		});
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("list: Response is an array");
	});

	it("when an update ignores the patch it was sent", async () => {
		const result = await run("mutant-update", { mutant: "update-ignores-patch" });
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("update: bio was updated");
	});

	it("when the server requires a header the collection does not send", async () => {
		const result = await run("mutant-header", { server: { requireHeader: "X-Tenant" } });
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("health: Status code is 200");
	});
});

/**
 * **And against a collection missing what the spec requires**, which proves the green run depends
 * on what the emitter derived rather than on a lenient server.
 */
describe("the collection goes red when it stops sending what the spec requires", () => {
	const stripHeader =
		(key: string) =>
		(collection: PostmanCollection): PostmanCollection =>
			JSON.parse(
				JSON.stringify(collection, (name, value: unknown) =>
					name === "header" && Array.isArray(value)
						? value.filter((header: { key: string }) => header.key !== key)
						: value,
				),
			) as PostmanCollection;

	it("without the API key the AND requirement adds to the bearer token", async () => {
		const result = await run("strip-shop-key", { collection: stripHeader("X-Shop-Key") });
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("delete: Status code is 204");
	});

	it("without the required Idempotency-Key header", async () => {
		const result = await run("strip-idempotency", { collection: stripHeader("Idempotency-Key") });
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("create: Status code is 201");
	});

	it("without the collection's bearer auth", async () => {
		const result = await run("strip-auth", {
			collection: (collection) => {
				const { auth: _auth, ...rest } = collection;
				return rest;
			},
		});
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("create: Status code is 201");
	});
});

/**
 * **Resources the worked example has no instance of**, each run against a server generated from
 * `edges.tsp`: a numeric key, which a collection variable holds as text, so the read assertion
 * compares text with text; and a property written but never read back, which an update assertion
 * must leave alone because a correct server never returns it.
 */
describe("the collection runs green where a key is a number or a field is write-only", () => {
	let edges: Compiled;

	beforeAll(async () => {
		edges = await compileSpec(join(here, "edges.tsp"), join(here, ".out", "edges"), {
			openapi: true,
			hono: true,
		});
		expect(edges.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
	}, 600_000);

	it("chains a numeric id, reads it back, and asserts only the fields a response carries", async () => {
		served = await serveGenerated(edges.serverDir, edges.document(), "", edgesHandlers());
		const result = await runCollection(
			join(edges.outDir, "postman_collection.json"),
			{ endpoint: served.origin },
			join(here, ".out", "reports", "edges.json"),
		);
		expect(failedTests(result), result.output).toEqual([]);
		expect(result.exitCode, result.output).toBe(0);
		expect(
			result.executions.flatMap((execution) =>
				execution.tests.map((test) => `${execution.name}: ${test.name}`),
			),
		).toEqual([
			"create: Status code is 201",
			"create: Response has an id",
			"read: Status code is 200",
			"read: Returns the requested widget",
			"create: Status code is 201",
			"create: Response has an id",
			"read: Status code is 200",
			"read: Returns the requested member",
			"update: Status code is 200",
			"update: name was updated",
		]);
	});
});
