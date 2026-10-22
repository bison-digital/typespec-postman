import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { bookshopHandlers, bookshopRewrite, type Mutant } from "./bookshop.fixture.js";
import { edgesHandlers, LEDGER } from "./edges.fixture.js";
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
 * This is the collection at its real entry point: the CLI a team runs, the file the emitter
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

/**
 * Stated, not derived, as a reader counts them in `example/main.tsp`.
 *
 * Requests: ten operations, then six error cases. The two reads declare `NotFound` (2); the two
 * creates declare `Invalid` and have a required property to leave out (2); and the operations
 * declaring `Unauthorized` carry two distinct credentialed requirements, bearer alone and bearer with
 * the shop key (2). `update`'s patch has no required property and `health` needs no credential.
 *
 * Assertions, success cases (37):
 * - every request: its status (10);
 * - every JSON body: its Content-Type and its schema (8 bodies, 16);
 * - both creates: the `location` header, and that the id came back (4);
 * - both deletes: no body (2);
 * - both lists are arrays, both reads return what was asked for, and the update holds `bio` (5).
 *
 * Error cases (18): each asserts its status, the error body's Content-Type and its schema (6 x 3).
 */
const EXPECTED_REQUESTS = 16;
const EXPECTED_ASSERTIONS = 55;

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
		/** Run as a person who has not been told what the collection needs. */
		readonly withoutCredentials?: boolean;
	} = {},
): Promise<RunResult> {
	const mutant = options.mutant ?? "none";
	const rewriteBody = bookshopRewrite(mutant);
	served = await serveGenerated(
		compiled.serverDir,
		compiled.document(),
		"/v1",
		bookshopHandlers(mutant),
		{ ...(rewriteBody === undefined ? {} : { rewriteBody }), ...options.server },
	);
	let file = join(compiled.outDir, "postman_collection.json");
	if (options.collection !== undefined) {
		file = join(compiled.outDir, `${name}.postman_collection.json`);
		writeFileSync(file, JSON.stringify(options.collection(compiled.collection())));
	}
	return runCollection(
		file,
		{ endpoint: served.origin, ...(options.withoutCredentials === true ? {} : CREDENTIALS) },
		join(here, ".out", "reports", `${name}.json`),
	);
}

/**
 * The document path a request's URL is for: each templated segment of the path template matches
 * any one segment of the URL, and a literal must be equal. An error case sends a literal id where a
 * success case sends `{{authorId}}`, and both are the same operation.
 */
function templateFor(templates: readonly string[], path: readonly string[]): string | undefined {
	return templates.find((template) => {
		const parts = template.split("/").filter((part) => part !== "");
		return (
			parts.length === path.length &&
			parts.every((part, index) => /^\{[^}]+\}$/.test(part) || part === path[index])
		);
	});
}

/**
 * **Failed, which a skipped test is not.** Postman's own JSON reporter spells a `pm.test.skip` as
 * `skipped` and leaves the run's exit code alone; a guarded request reports its checks that way while
 * the value it needs is the one nothing created. Anything that is neither is still a failure here.
 */
function failedTests(result: RunResult): string[] {
	return result.executions.flatMap((execution) =>
		execution.tests
			.filter((test) => test.status !== "passed" && test.status !== "skipped")
			.map((test) => `${execution.name}: ${test.name}`),
	);
}

function skippedTests(result: RunResult): string[] {
	return result.executions.flatMap((execution) =>
		execution.tests.filter((test) => test.status === "skipped").map((test) => test.name),
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
			const path = `/${item.request.url.path.join("/")}`;
			const template = templateFor(Object.keys(document.paths), item.request.url.path);
			const operation =
				template === undefined
					? undefined
					: document.paths[template]?.[item.request.method.toLowerCase()];
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
			"GET read: not found 404",
			"GET read: not found 404",
			"POST create: invalid body 400",
			"POST create: invalid body 400",
			"POST create: unauthorized 401",
			"DELETE delete: unauthorized 401",
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
		});
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("create: Response has an id");
	});

	it("when a create returns an id of the wrong type", async () => {
		const result = await run("mutant-numeric-id", {
			mutant: "create-numeric-id",
		});
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("create: Response has an id");
	});

	it("when a list returns something that is not a list", async () => {
		const result = await run("mutant-list", {
			mutant: "list-returns-object",
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
		});
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("list: Response is an array");
	});

	it("when an update ignores the patch it was sent", async () => {
		const result = await run("mutant-update", { mutant: "update-ignores-patch" });
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("update: bio was updated");
	});

	it("when a response is served with a media type the operation does not declare", async () => {
		const result = await run("mutant-content-type", { server: { contentType: "text/plain" } });
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("read: Content-Type header is application/json");
	});

	it("when a create answers without the Location header its response requires", async () => {
		const result = await run("mutant-no-location", { server: { dropHeader: "location" } });
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("create: location identifies the created author");
	});

	/**
	 * **The case a presence check calls correct.** A proxy serving the API under a base path forwards
	 * a `Location` the service wrote without one; the header arrives, is a string, and resolves from
	 * the caller's side to a URL with the base path gone. Every byte of it is well formed and no
	 * client can follow it.
	 */
	it("when a create answers a Location that resolves outside the collection", async () => {
		const result = await run("mutant-stripped-location", {
			server: { rewriteLocation: (location) => location.replace("/v1", "") },
		});
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("create: location identifies the created author");
	});

	/**
	 * **And the case the check must NOT fail.** A service is entitled to answer its own canonical
	 * absolute URL where the run reaches it through another origin, which is why the path is compared
	 * and the origin is not. This arm is the control for the two above: without it, tightening the
	 * comparison to the whole URL would read as an improvement.
	 */
	it("stays green when a create answers an absolute Location at another origin", async () => {
		const result = await run("absolute-location", {
			server: { rewriteLocation: (location) => `https://api.example.test${location}` },
		});
		expect(failedTests(result), result.output).toEqual([]);
		expect(result.exitCode, result.output).toBe(0);
	});

	/** And a Location that is under the collection but names another resource entirely. */
	it("when a create answers a Location naming a resource it did not create", async () => {
		const result = await run("mutant-other-location", {
			server: {
				rewriteLocation: (location) =>
					location.replace(/[^/]+$/, "11111111-1111-1111-1111-111111111111"),
			},
		});
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("create: location identifies the created author");
	});

	it("when a response carries a body where the operation declares none", async () => {
		// A 204 cannot carry a body on the wire, so the mutant answers 200 with one.
		const result = await run("mutant-body-where-none", {
			server: { bodyWhereNone: true, rewriteStatus: { from: 204, to: 200 } },
		});
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("delete: Response has no body");
	});

	it("when a response body breaks the schema the operation declares", async () => {
		const result = await run("mutant-schema", {
			mutant: "read-returns-malformed",
		});
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("read: Response matches the schema");
	});

	it("when a read finds a resource nothing created", async () => {
		const result = await run("mutant-finds-anything", { mutant: "read-finds-anything" });
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("read: not found: Status code is 404");
	});

	it("when the server accepts a body the spec refuses", async () => {
		const result = await run("mutant-accepts-invalid", {
			server: { acceptInvalid: true },
		});
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("create: invalid body: Status code is 400");
	});

	/**
	 * **A run with no credential set is not a service that refuses correct calls.** Postman sends an
	 * unset variable as an empty one, so every request comes back 401 and the report reads as a broken
	 * service. The collection says what is missing instead, and stops.
	 */
	it("when the run has not been given the credentials the spec requires", async () => {
		const result = await run("no-credentials", { withoutCredentials: true });
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("This collection authenticates with bearerAuth and shopKey");
		expect(result.output).toContain("--env-var bearerAuth=...");
		// Stopped, rather than the same message once per request or a run of 401s.
		expect(failedTests(result)).toEqual([]);
		expect(result.executions.length).toBe(1);
	});

	it("when the server admits a caller with no credential", async () => {
		const result = await run("mutant-ignores-auth", { server: { ignoreAuth: true } });
		expect(result.exitCode).not.toBe(0);
		expect(failedTests(result)).toContain("create: unauthorized: Status code is 401");
	});

	it("when the server requires a header the collection does not send", async () => {
		const result = await run("mutant-header", { server: { requireHeader: "X-Region" } });
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
describe("the collection runs green where a key is a number, unread, wrapped or uncreatable", () => {
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
			"create: Content-Type header is application/json",
			"create: Response matches the schema",
			"create: Response has an id",
			"create: location identifies the created widget",
			"read: Status code is 200",
			"read: Content-Type header is application/json",
			"read: Response matches the schema",
			"read: Returns the requested widget",
			"create: Status code is 201",
			"create: Content-Type header is application/json",
			"create: Response matches the schema",
			"create: Response has an id",
			"create: location identifies the created member",
			"read: Status code is 200",
			"read: Content-Type header is application/json",
			"read: Response matches the schema",
			"read: Returns the requested member",
			"update: Status code is 200",
			"update: Content-Type header is application/json",
			"update: Response matches the schema",
			"update: name was updated",
			/**
			 * The batch's id is in no part of the body the create answers with. It is captured from the
			 * `Location`, and the read that follows reaches the batch that was actually created - which
			 * is the whole of what item the wrapping cost before.
			 */
			"create: Status code is 201",
			"create: Content-Type header is application/json",
			"create: Response matches the schema",
			"create: location identifies the created batch",
			"read: Status code is 200",
			"read: Content-Type header is application/json",
			"read: Response matches the schema",
			"read: Returns the requested batch",
			// Nothing creates a ledger, so every check on reading one is reported skipped, not failed.
			"read: Status code is 200 (needs ledgerId)",
			"read: Content-Type header is application/json (needs ledgerId)",
			"read: Response matches the schema (needs ledgerId)",
			"read: Returns the requested ledger (needs ledgerId)",
			// Error cases: every read declares NotFound, and the ledger's needs no real id at all.
			"read: not found: Status code is 404",
			"read: not found: Content-Type header is application/json",
			"read: not found: Response matches the schema",
			"read: not found: Status code is 404",
			"read: not found: Content-Type header is application/json",
			"read: not found: Response matches the schema",
			"read: not found: Status code is 404",
			"read: not found: Content-Type header is application/json",
			"read: not found: Response matches the schema",
			"read: not found: Status code is 404",
			"read: not found: Content-Type header is application/json",
			"read: not found: Response matches the schema",
		]);
		expect(result.executions.flatMap((execution) => execution.tests).length).toBe(46);
		// Skipped, and nothing else is: every other check in this collection ran.
		expect(skippedTests(result)).toEqual([
			"Status code is 200 (needs ledgerId)",
			"Content-Type header is application/json (needs ledgerId)",
			"Response matches the schema (needs ledgerId)",
			"Returns the requested ledger (needs ledgerId)",
		]);
	});

	/**
	 * **A flag passed with nothing in it is not a value.** A runner that always passes the flag and
	 * lets an unset shell variable expand to nothing sends an empty id, which is not the placeholder
	 * the guard compares against - so the checks would run, against `/ledgers/`, and fail. An empty
	 * value has to count as unset too.
	 */
	it("still skips when the run passes the id with nothing in it", async () => {
		served = await serveGenerated(edges.serverDir, edges.document(), "", edgesHandlers());
		const result = await runCollection(
			join(edges.outDir, "postman_collection.json"),
			{ endpoint: served.origin, ledgerId: "" },
			join(here, ".out", "reports", "edges-empty.json"),
		);
		expect(failedTests(result), result.output).toEqual([]);
		expect(result.exitCode, result.output).toBe(0);
		expect(skippedTests(result)).toEqual([
			"Status code is 200 (needs ledgerId)",
			"Content-Type header is application/json (needs ledgerId)",
			"Response matches the schema (needs ledgerId)",
			"Returns the requested ledger (needs ledgerId)",
		]);
	});

	/**
	 * **The same collection, given the id it asked for.** The skipped checks are the same checks: they
	 * run, against a ledger the service has and the collection could not have made, and they pass. A
	 * guard that silently never un-skipped would look identical without this.
	 */
	it("runs the skipped checks for real once the run supplies the id", async () => {
		served = await serveGenerated(edges.serverDir, edges.document(), "", edgesHandlers());
		const result = await runCollection(
			join(edges.outDir, "postman_collection.json"),
			{ endpoint: served.origin, ledgerId: LEDGER },
			join(here, ".out", "reports", "edges-supplied.json"),
		);
		expect(failedTests(result), result.output).toEqual([]);
		expect(result.exitCode, result.output).toBe(0);
		const names = result.executions.flatMap((execution) =>
			execution.tests.map((test) => test.name),
		);
		expect(names).toContain("Returns the requested ledger");
		expect(skippedTests(result)).toEqual([]);
		// The same count either way, so a collection that quietly stopped checking cannot look green.
		expect(names.length).toBe(46);
	});
});
