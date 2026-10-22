import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, NodeHost } from "@typespec/compiler";
import { beforeAll, describe, expect, it } from "vitest";
import {
	codes,
	type Compiled,
	compileFixture,
	folderNamed,
	headerOf,
	type PostmanItem,
	requestNamed,
	scriptOf,
} from "../support/compile.js";

/**
 * **A spec with a GraphQL surface gets a collection that calls it**: one `graphql`-mode request for
 * each root field typespec-http-graphql served, in a folder of its own, its document the one that
 * emitter wrote and its variables the values the REST request for the same operation sends.
 *
 * The documents are typespec-http-graphql's, read here as this emitter reads them, from the copy the
 * compiler ran, so this suite grades where each goes and what it carries, not how it is written.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

interface GraphQLRequest {
	readonly field: string;
	readonly document: string;
}

/** The documents typespec-http-graphql recorded for the compile, by field. */
function documentsOf(compiled: Compiled): ReadonlyMap<string, string> {
	const ref = compiled.program.emitters.find(
		(emitter) => emitter.metadata.name === "typespec-http-graphql",
	);
	const read = (
		ref?.library.entrypoint?.esmExports as
			| {
					graphqlRequestsOf?: (
						program: unknown,
					) => readonly { readonly requests: readonly GraphQLRequest[] }[] | undefined;
			  }
			| undefined
	)?.graphqlRequestsOf;
	return new Map(
		(read?.(compiled.program) ?? []).flatMap((service) =>
			service.requests.map((request) => [request.field, request.document] as const),
		),
	);
}

const graphqlOf = (item: PostmanItem) =>
	item.request?.body as
		| {
				readonly mode: string;
				readonly graphql: { readonly query: string; readonly variables: string };
		  }
		| undefined;

let compiled: Compiled;

beforeAll(async () => {
	compiled = await compileFixture(here, "main", { graphql: "before" });
	expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
}, 300_000);

describe("a collection for a spec with a GraphQL surface", () => {
	it("holds a GraphQL folder after the REST requests and before the error cases", () => {
		const names = compiled.collection().item.map((item) => item.name);
		expect(names.slice(-2)).toEqual(["GraphQL", "Error cases"]);
	});

	it("starts the folder with the creates its reads need, then a request per root field, in REST order", () => {
		expect(folderNamed(compiled.collection(), "GraphQL").item?.map((item) => item.name)).toEqual([
			"create (Authors)",
			"create (Books)",
			"mutation createAuthor",
			"query author",
			"query book",
			"mutation deleteAuthor",
		]);
	});

	it("posts to {{baseUrl}}/graphql in graphql mode, the document typespec-http-graphql wrote", () => {
		const documents = documentsOf(compiled);
		expect([...documents.keys()].toSorted()).toEqual([
			"author",
			"book",
			"createAuthor",
			"deleteAuthor",
		]);
		for (const [field, document] of documents) {
			const kind = field === "author" || field === "book" ? "query" : "mutation";
			const request = requestNamed(compiled.collection(), `${kind} ${field}`, "GraphQL");
			expect(request.request?.method).toBe("POST");
			expect(request.request?.url.raw).toBe("{{baseUrl}}/graphql");
			expect(headerOf(request, "Content-Type")?.value).toBe("application/json");
			expect(graphqlOf(request)?.mode).toBe("graphql");
			expect(graphqlOf(request)?.graphql.query).toBe(document);
		}
	});

	it("fills a variable from the id the run created, unquoted where the id is a number", () => {
		const collection = compiled.collection();
		expect(graphqlOf(requestNamed(collection, "query author", "GraphQL"))?.graphql.variables).toBe(
			'{\n  "authorId": "{{authorId}}"\n}',
		);
		expect(graphqlOf(requestNamed(collection, "query book", "GraphQL"))?.graphql.variables).toBe(
			'{\n  "authorId": "{{authorId}}",\n  "bookId": {{bookId}}\n}',
		);
		expect(
			graphqlOf(requestNamed(collection, "mutation deleteAuthor", "GraphQL"))?.graphql.variables,
		).toBe('{\n  "input": {\n    "authorId": "{{authorId}}"\n  }\n}');
	});

	it("sends a mutation's input as the REST request sends its body", () => {
		const collection = compiled.collection();
		const rest = JSON.parse(
			requestNamed(collection, "create", "Authors").request?.body?.raw ?? "null",
		);
		const variables = JSON.parse(
			graphqlOf(requestNamed(collection, "mutation createAuthor", "GraphQL"))?.graphql.variables ??
				"null",
		);
		expect(variables).toEqual({ input: rest });
	});

	it("authenticates each request as the REST request for its operation is", () => {
		const collection = compiled.collection();
		expect(collection.auth?.type).toBe("bearer");
		expect(folderNamed(collection, "GraphQL").auth).toBeUndefined();
		expect(requestNamed(collection, "query author", "GraphQL").request?.auth).toBeUndefined();
		expect(requestNamed(collection, "mutation deleteAuthor", "GraphQL").request?.auth).toEqual({
			type: "noauth",
		});
	});

	it("checks an answer with no errors and a value, and a mutation's success member", () => {
		const collection = compiled.collection();
		const query = scriptOf(requestNamed(collection, "query author", "GraphQL")).join("\n");
		expect(query).toContain("pm.response.to.have.status(200);");
		expect(query).toContain('pm.expect(body.errors, "errors").to.be.undefined;');
		expect(query).toContain('pm.expect(body.data["author"], "author").to.not.be.null;');
		const mutation = scriptOf(requestNamed(collection, "mutation createAuthor", "GraphQL")).join(
			"\n",
		);
		expect(mutation).toContain(
			'pm.expect(["Author"]).to.include(body.data["createAuthor"].__typename);',
		);
	});

	it("copies the creates into the folder, each setting the id the requests after it read", () => {
		const collection = compiled.collection();
		const original = requestNamed(collection, "create", "Authors");
		const copy = requestNamed(collection, "create (Authors)", "GraphQL");
		expect(copy.request).toEqual(original.request);
		expect(scriptOf(copy)).toEqual(scriptOf(original));
		expect(copy.id).not.toBe(original.id);
	});
});

describe("where typespec-http-graphql is listed after this emitter", () => {
	let after: Compiled;
	beforeAll(async () => {
		after = await compileFixture(here, "main", { graphql: "after", outName: "after" });
	}, 300_000);

	it("warns that it must come first, and writes no GraphQL folder", () => {
		expect(codes(after)).toContain("typespec-postman/graphql-emitted-later");
		expect(after.collection().item.map((item) => item.name)).not.toContain("GraphQL");
	});
});

describe("where the compile does not emit typespec-http-graphql", () => {
	let alone: Compiled;
	beforeAll(async () => {
		alone = await compileFixture(here, "main", { outName: "alone" });
	}, 300_000);

	it("writes no GraphQL folder, and says nothing", () => {
		expect(alone.collection().item.map((item) => item.name)).not.toContain("GraphQL");
		expect(codes(alone).filter((code) => code.includes("graphql"))).toEqual([]);
	});
});

describe("graphql-url", () => {
	let moved: Compiled;
	let perService: Compiled;
	beforeAll(async () => {
		moved = await compileFixture(here, "main", {
			graphql: "before",
			outName: "moved",
			postman: { "graphql-url": "{{endpoint}}/api/graphql" },
		});
		perService = await compileFixture(here, "main", {
			graphql: "before",
			outName: "per-service",
			postman: {
				"graphql-url": "{{endpoint}}/api/graphql",
				services: { GraphQLFixture: { "graphql-url": "{{baseUrl}}/v2/graphql" } },
			},
		});
	}, 300_000);

	it("names where the GraphQL requests go", () => {
		const request = requestNamed(moved.collection(), "query author", "GraphQL").request;
		expect(request?.url.raw).toBe("{{endpoint}}/api/graphql");
		expect(request?.url.path).toEqual(["api", "graphql"]);
	});

	it("is set per service, over the emitter's own", () => {
		expect(requestNamed(perService.collection(), "query author", "GraphQL").request?.url.raw).toBe(
			"{{baseUrl}}/v2/graphql",
		);
	});
});

describe("graphql-url that names no host", () => {
	let invalid: Compiled;
	beforeAll(async () => {
		invalid = await compileFixture(here, "main", {
			graphql: "before",
			outName: "invalid-url",
			postman: { "graphql-url": "/graphql" },
		});
	}, 300_000);

	it("is warned, and the requests go to {{baseUrl}}/graphql", () => {
		expect(codes(invalid)).toContain("typespec-postman/graphql-url-invalid");
		expect(requestNamed(invalid.collection(), "query author", "GraphQL").request?.url.raw).toBe(
			"{{baseUrl}}/graphql",
		);
	});
});

describe("a typespec-http-graphql that publishes no requests", () => {
	let older: Compiled;
	beforeAll(async () => {
		const outDir = join(here, ".out", "older");
		rmSync(outDir, { recursive: true, force: true });
		const program = await compile(NodeHost, join(here, "rest.tsp"), {
			outputDir: outDir,
			emit: [join(here, "older"), "typespec-postman"],
			options: { "typespec-postman": { "emitter-output-dir": outDir } },
		});
		older = {
			...(await compileFixture(here, "rest", { outName: "older-rest" })),
			diagnostics: program.diagnostics.map((diagnostic) => ({
				code: diagnostic.code,
				severity: diagnostic.severity,
				message: diagnostic.message,
			})),
		};
	}, 300_000);

	it("is warned, naming its version", () => {
		const warning = older.diagnostics.find(
			(diagnostic) => diagnostic.code === "typespec-postman/graphql-requests-unavailable",
		);
		expect(warning?.message).toContain("(version 0.2.1)");
	});
});

describe("a versioned service, at its latest version", () => {
	let versioned: Compiled;
	beforeAll(async () => {
		versioned = await compileFixture(here, "versioned", { graphql: "before" });
		expect(versioned.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual(
			[],
		);
	}, 300_000);

	/**
	 * **Two interfaces from one template share their operations' declaration**, so an operation read
	 * by its declaration is ambiguous here: `Shelves.read` and `Racks.read` are one node. Each GraphQL
	 * request is matched by method, route and declared name, and the auth and the ids below are those
	 * of the one its field calls.
	 */
	it("is a service whose interfaces share their operations' declaration", () => {
		const shelves = versioned.program.resolveTypeReference("VersionedFixture.Shelves.read")[0];
		const racks = versioned.program.resolveTypeReference("VersionedFixture.Racks.read")[0];
		expect(shelves?.node).toBeDefined();
		expect(shelves?.node).toBe(racks?.node);
	});

	it("matches each GraphQL request to its own operation", () => {
		const collection = versioned.collection();
		/** The auth a request is sent with: its own, else its folder's, else the collection's. */
		const authOf = (name: string, folder: string) =>
			requestNamed(collection, name, folder).request?.auth ??
			folderNamed(collection, folder).auth ??
			collection.auth;
		expect(authOf("query shelf", "GraphQL")).toEqual(authOf("read", "Shelves"));
		expect(authOf("query rack", "GraphQL")).toEqual(authOf("read", "Racks"));
		expect(authOf("query shelf", "GraphQL")).not.toEqual(authOf("query rack", "GraphQL"));
		expect(graphqlOf(requestNamed(collection, "query shelf", "GraphQL"))?.graphql.variables).toBe(
			'{\n  "id": "{{shelfId}}"\n}',
		);
		expect(graphqlOf(requestNamed(collection, "query rack", "GraphQL"))?.graphql.variables).toBe(
			'{\n  "id": "{{rackId}}"\n}',
		);
		expect(
			graphqlOf(requestNamed(collection, "query searchShelves", "GraphQL"))?.graphql.variables,
		).toContain('"name"');
		expect(
			graphqlOf(requestNamed(collection, "query searchRacks", "GraphQL"))?.graphql.variables,
		).toContain('"size"');
	});

	it("sends the latest version's input: a renamed property by its new name, a removed one not at all", () => {
		const collection = versioned.collection();
		const rest = JSON.parse(
			requestNamed(collection, "create", "Shelves").request?.body?.raw ?? "null",
		) as Readonly<Record<string, unknown>>;
		const variables = JSON.parse(
			graphqlOf(requestNamed(collection, "mutation createShelf", "GraphQL"))?.graphql.variables ??
				"null",
		) as { readonly input: Readonly<Record<string, unknown>> };
		expect(variables).toEqual({ input: rest });
		expect(Object.keys(rest)).toContain("name");
		expect(Object.keys(rest)).not.toContain("label");
		expect(Object.keys(rest)).not.toContain("colour");
	});
});
