import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import {
	compileSpec,
	type OpenApiDocument,
	type PostmanItem,
	requestsOf,
} from "../support/compile.js";

/**
 * **Every request the emitter generates, judged by the two artefacts a server is built from.**
 *
 * `@typespec/http-specs` is Microsoft's scenario corpus, so what it covers was chosen by nobody here.
 * Each scenario is compiled once with this emitter, `@typespec/openapi3` (sealed, as a validating
 * server is) and `typespec-hono`, and each JSON body the collection sends must:
 *
 * - validate under Ajv 2020-12 against the request schema openapi3 published for that operation;
 * - and, sent with its headers and query to the typespec-hono server generated from the same program,
 *   reach the handler without the server's validator refusing it.
 *
 * The second judge is the stronger one and the reason this suite exists: JSON Schema without a
 * discriminator keyword accepts a body a Zod validator refuses, and a document annotation such as
 * `format: int32` is not a check. **The expectation comes from neither this emitter nor its fixtures.**
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const specsRoot = fileURLToPath(
	new URL("../../node_modules/@typespec/http-specs/specs/", import.meta.url),
);

/**
 * Scenarios with no document to judge against, and why. **Named, never counted**: a number would
 * move when upstream fixes its emitter and nobody would know whether this one had regressed.
 */
const ORACLE_REFUSALS: Readonly<Record<string, string>> = {
	"response/status-code-range":
		"@typespec/openapi3 refuses a status code range (unsupported-status-code-range)",
	routes: "@typespec/openapi3 refuses a path containing a query string (path-query)",
	"special-words": "@typespec/openapi3 throws while emitting examples",
};

function scenarios(): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (entry === "main.tsp") found.push(relative(specsRoot, dir).replaceAll("\\", "/"));
		}
	};
	walk(specsRoot);
	return found.toSorted();
}

const JSON_MEDIA = /^application\/(?:[\w.+-]+\+)?json$/i;
const PLACEHOLDER = /\{\{[^}]+\}\}/g;

interface Finding {
	readonly scenario: string;
	readonly request: string;
	readonly problem: string;
}

const judged: string[] = [];
const findings: Finding[] = [];
const refused: Record<string, string> = {};
let bodiesJudged = 0;
let requestsSent = 0;

/**
 * The document as it applies to a REQUEST. OpenAPI marks a read-only property `readOnly: true` and
 * says it SHOULD NOT be sent in a request; `@typespec/openapi3` still lists it in `required`, because
 * one schema serves both directions. Ajv implements no `readOnly` semantics, so without this a create
 * body that correctly omits a server-assigned id would be judged invalid. Every validator that applies
 * a document to requests makes the same adjustment.
 */
function forRequests(document: OpenApiDocument): unknown {
	const walk = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(walk);
		if (node === null || typeof node !== "object") return node;
		const object = Object.fromEntries(
			Object.entries(node).map(([key, value]) => [key, walk(value)]),
		) as Record<string, unknown>;
		const properties = object["properties"] as Record<string, { readOnly?: boolean }> | undefined;
		if (Array.isArray(object["required"]) && properties !== undefined) {
			object["required"] = (object["required"] as string[]).filter(
				(name) => properties[name]?.readOnly !== true,
			);
		}
		return object;
	};
	return walk(document);
}

/**
 * Requests no document can accept, named per request. `type/union/discriminated`'s no-envelope
 * variants do not declare the discriminator, so the sealed document forbids the very property the
 * union serialises with: every body fails. It is the inconsistency typespec-http-zod refuses outright.
 */
const DOCUMENT_REFUSALS: Readonly<Record<string, string>> = {
	"PUT {{baseUrl}}/type/union/discriminated/no-envelope/default":
		"the sealed document forbids the discriminator its variants omit",
	"PUT {{baseUrl}}/type/union/discriminated/no-envelope/custom-discriminator":
		"the sealed document forbids the discriminator its variants omit",
};
const documentRefused: string[] = [];

/**
 * Requests the generated server refuses although they are exactly what the scenario documents: a
 * defect in the SERVER library, named with its evidence so it is fixed there rather than hidden here.
 */
const SERVER_DEFECTS: Readonly<Record<string, string>> = {
	"POST {{baseUrl}}/multipart/form-data/non-string-float":
		"typespec-http-zod emits z.number() for a text/plain multipart part carrying a float64, so the text part the scenario documents is refused",
};
const serverDefects: string[] = [];

/** Requests the in-process server judge cannot send, counted rather than silently dropped. */
const unsendable: string[] = [];

/** `/a/:b/{{c}}` -> `/a/{}/{}`, the shape a document path template normalises to. */
const shapeOf = (path: readonly string[]) =>
	`/${path.map((segment) => (segment.startsWith(":") || /^\{\{.*\}\}$/.test(segment) ? "{}" : segment)).join("/")}`;

/**
 * Scenarios the SERVER library refuses as an error, so there is no generated server to send to. The
 * document judge still runs on them. Named for the same reason as the list above.
 */
const SERVER_REFUSALS: Readonly<Record<string, string>> = {
	"response/status-code-range":
		"typespec-http-zod refuses a status code range (unsupported-status-code-range)",
	"type/union/discriminated":
		"typespec-http-zod refuses a discriminated union whose variants do not declare the discriminator (undeclared-discriminator)",
};
const serverRefused: Record<string, string> = {};

async function judge(scenario: string): Promise<void> {
	const outDir = join(here, ".out", scenario.replaceAll("/", "__"));
	const main = join(specsRoot, scenario, "main.tsp");
	let compiled;
	try {
		compiled = await compileSpec(main, outDir, { openapi: true, hono: true });
		const serverErrors = compiled.diagnostics.filter(
			(diagnostic) =>
				diagnostic.severity === "error" && /^typespec-(hono|http-zod)\//.test(diagnostic.code),
		);
		if (serverErrors.length > 0) {
			serverRefused[scenario] = [...new Set(serverErrors.map((error) => error.code))].join(", ");
			compiled = await compileSpec(main, outDir, { openapi: true });
		}
	} catch (error) {
		refused[scenario] = `compile threw: ${String(error).slice(0, 200)}`;
		return;
	}
	const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	const documents = existsSync(join(outDir, "openapi")) ? readdirSync(join(outDir, "openapi")) : [];
	if (errors.length > 0 || documents.length === 0) {
		refused[scenario] = errors.map((error) => error.code).join(", ") || "no document";
		return;
	}
	const collections = readdirSync(outDir).filter((name) =>
		name.endsWith("postman_collection.json"),
	);
	for (const file of collections) {
		const collection = compiled.collection(file);
		const documentFile = file
			.replace(".postman_collection.json", ".openapi.json")
			.replace(/^postman_collection\.json$/, "openapi.json");
		const document = compiled.document(
			documents.includes(documentFile) ? documentFile : (documents[0] ?? "openapi.json"),
		);
		const serverDir =
			collections.length > 1
				? join(compiled.serverDir, file.replace(".postman_collection.json", ""))
				: compiled.serverDir;
		await judgeCollection(scenario, collection.item, document, serverDir);
	}
	judged.push(scenario);
}

async function judgeCollection(
	scenario: string,
	items: readonly PostmanItem[],
	document: OpenApiDocument,
	serverDir: string,
): Promise<void> {
	const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
	addFormats.default(ajv);
	ajv.addSchema(forRequests(document) as object, "https://document.test/openapi.json");

	const refusals: Finding[] = [];
	let app: Hono | undefined;
	if (existsSync(join(serverDir, "app.gen.ts"))) {
		const generated = (await import(join(serverDir, "app.gen.ts"))) as {
			registerRoutes: (app: unknown, handlersFor: unknown, deps: unknown) => void;
		};
		app = new Hono();
		let current = "";
		const handlers = new Proxy({}, { get: () => () => undefined });
		generated.registerRoutes(app, () => handlers, {
			authorize: () => async (_c: unknown, next: () => Promise<void>) => next(),
			context: () => ({}),
			noContext: (c: { json: (b: unknown, s: number) => Response }) => c.json({}, 401),
			notAcceptable: (c: { json: (b: unknown, s: number) => Response }) => {
				refusals.push({
					scenario,
					request: current,
					problem: "406: the server offers nothing the Accept header asks for",
				});
				return c.json({}, 406);
			},
			invalid: (
				result: { success: boolean; error?: unknown },
				c: { json: (b: unknown, s: number) => Response },
			) => {
				if (result.success) return undefined;
				if (SERVER_DEFECTS[current] !== undefined) {
					serverDefects.push(current);
					return c.json({}, 400);
				}
				refusals.push({
					scenario,
					request: current,
					problem: `400 from the generated validator: ${String(result.error).slice(0, 300)}`,
				});
				return c.json({}, 400);
			},
			respond: (c: { body: (b: null, s: number) => Response }) => c.body(null, 204),
		});
		const send = async (item: PostmanItem) => {
			const request = item.request;
			if (request === undefined || app === undefined) return;
			current = `${request.method} ${request.url.raw}`;
			const variables = new Map(
				(request.url.variable ?? []).map((variable) => [variable.key, variable.value]),
			);
			const path = request.url.path
				.map((segment) =>
					segment.startsWith(":") ? (variables.get(segment.slice(1)) ?? "") : segment,
				)
				.map((segment) => segment.replace(PLACEHOLDER, "00000000-0000-0000-0000-000000000000"))
				.join("/");
			const query = (request.url.query ?? [])
				.filter((param) => param.disabled !== true)
				.map((param) => `${param.key}=${param.value.replace(PLACEHOLDER, "x")}`)
				.join("&");
			const headers = new Headers();
			for (const header of request.header) {
				if (header.disabled !== true)
					headers.append(header.key, header.value.replace(PLACEHOLDER, "x"));
			}
			const mode = request.body?.mode;
			const parts = (request.body?.["formdata"] ?? []) as {
				key: string;
				type: string;
				value?: string;
				contentType?: string;
			}[];
			if (mode === "file" || parts.some((part) => part.type === "file")) {
				// The emitter reports these as bodies a person completes (`body-not-runnable`).
				unsendable.push(`${current}: a body the emitter reports a person must complete`);
				return;
			}
			if (request.body !== undefined && (request.method === "GET" || request.method === "HEAD")) {
				unsendable.push(`${current}: fetch cannot send a ${request.method} body`);
				return;
			}
			let body: string | FormData | undefined;
			if (mode === "raw") body = request.body?.raw;
			if (mode === "formdata") {
				const form = new FormData();
				for (const part of parts) {
					form.append(
						part.key,
						part.contentType === undefined
							? (part.value ?? "")
							: new Blob([part.value ?? ""], { type: part.contentType }),
					);
				}
				body = form;
				headers.delete("content-type");
			}
			await app.request(`/${path}${query === "" ? "" : `?${query}`}`, {
				method: request.method,
				headers,
				...(body === undefined ? {} : { body }),
			});
			requestsSent++;
		};
		for (const { item } of requestsOf({
			info: { _postman_id: "", name: "", schema: "" },
			item: items,
		})) {
			await send(item);
		}
	}
	findings.push(...refusals);

	for (const { item } of requestsOf({
		info: { _postman_id: "", name: "", schema: "" },
		item: items,
	})) {
		const request = item.request;
		if (request?.body?.mode !== "raw" || request.body.raw === undefined) continue;
		const contentType =
			request.header.find((header) => header.key.toLowerCase() === "content-type")?.value ?? "";
		if (!JSON_MEDIA.test(contentType)) continue;
		const shape = shapeOf(request.url.path);
		const template = Object.keys(document.paths).find(
			(candidate) => candidate.replace(/\{[^}]+\}/g, "{}") === shape,
		);
		const method = request.method.toLowerCase();
		const operation =
			template === undefined
				? undefined
				: (document.paths[template]?.[method] as
						| { requestBody?: { content?: Record<string, unknown> } }
						| undefined);
		const media =
			operation?.requestBody?.content?.[contentType] === undefined ? undefined : contentType;
		if (template === undefined || media === undefined) {
			findings.push({
				scenario,
				request: `${request.method} ${request.url.raw}`,
				problem: "no operation in the document matches this request",
			});
			continue;
		}
		const pointer = `https://document.test/openapi.json#/paths/${template.replaceAll("~", "~0").replaceAll("/", "~1")}/${method}/requestBody/content/${media.replaceAll("~", "~0").replaceAll("/", "~1")}/schema`;
		const validate = ajv.getSchema(pointer);
		if (validate === undefined) {
			findings.push({
				scenario,
				request: `${request.method} ${request.url.raw}`,
				problem: `schema not found at ${pointer}`,
			});
			continue;
		}
		const label = `${request.method} ${request.url.raw}`;
		if (DOCUMENT_REFUSALS[label] !== undefined) {
			documentRefused.push(label);
			continue;
		}
		bodiesJudged++;
		if (!validate(JSON.parse(request.body.raw))) {
			findings.push({
				scenario,
				request: `${request.method} ${request.url.raw}`,
				problem: `openapi3 schema: ${ajv.errorsText(validate.errors)}`,
			});
		}
	}
}

beforeAll(async () => {
	for (const scenario of scenarios()) await judge(scenario);
}, 1_800_000);

describe("every generated request, judged by the document and the server built from the same spec", () => {
	it("judged the corpus, not a sample of it", () => {
		expect(scenarios().length).toBeGreaterThanOrEqual(66);
		expect(judged.length + Object.keys(refused).length).toBe(scenarios().length);
		expect(bodiesJudged).toBeGreaterThanOrEqual(250);
		expect(requestsSent).toBeGreaterThanOrEqual(600);
	});

	it("refuses only the scenarios upstream cannot produce a document for, for the stated reasons", () => {
		expect(Object.keys(refused).toSorted()).toEqual(Object.keys(ORACLE_REFUSALS).toSorted());
	});

	it("sets aside a server refusal only where it is a named defect in the server library", () => {
		expect(serverDefects.toSorted()).toEqual(Object.keys(SERVER_DEFECTS).toSorted());
	});

	it("sets aside only the requests named as ones no document accepts", () => {
		expect(documentRefused.toSorted()).toEqual(Object.keys(DOCUMENT_REFUSALS).toSorted());
	});

	it("leaves unsent only bodies a person completes and GET or HEAD bodies, and says which", () => {
		writeFileSync(join(here, ".out", "unsendable.json"), JSON.stringify(unsendable, null, 2));
		expect(
			unsendable.every((entry) =>
				/a person must complete|cannot send a (GET|HEAD) body/.test(entry),
			),
		).toBe(true);
		expect(unsendable.length).toBeLessThan(40);
	});

	it("has no server to send to only where the server library itself refuses the spec", () => {
		expect(Object.keys(serverRefused).toSorted()).toEqual(Object.keys(SERVER_REFUSALS).toSorted());
	});

	it("sends no body the published schema rejects, and nothing the generated server's validator refuses", () => {
		writeFileSync(
			join(here, ".out", "findings.json"),
			JSON.stringify(
				{ findings, refused, serverRefused, bodiesJudged, requestsSent, unsendable },
				null,
				2,
			),
		);
		expect(findings).toEqual([]);
	});
});
