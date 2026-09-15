import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import converter, { type CollectionResult } from "openapi-to-postmanv2";
import { beforeAll, describe, expect, it } from "vitest";
import {
	compileSpec,
	type PostmanAuth,
	type PostmanCollection,
	type PostmanItem,
} from "../support/compile.js";

/**
 * **Postman's own importer is the reference for what a collection of an API looks like.**
 *
 * `openapi-to-postmanv2` is the converter behind "Import OpenAPI" in the Postman app. For every
 * scenario in `@typespec/http-specs`, openapi3 publishes a document from the same program, the
 * importer converts it, and the two collections must agree on every facet a request is made of: its
 * method and route, path variables, query keys, header names, effective auth type, and body mode and
 * media type.
 *
 * **Every difference is listed below with the reason it exists**, and both directions fail: a
 * difference not listed is a defect, and a listed one that no longer occurs is a stale excuse.
 * Values, folders, names and tests are not compared. Postman's importer fills fields with
 * placeholders, groups by path and writes no assertions; the brief asks for the opposite of each.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const specsRoot = fileURLToPath(
	new URL("../../node_modules/@typespec/http-specs/specs/", import.meta.url),
);

type Facet = "route" | "variables" | "query" | "headers" | "auth" | "body";

interface Deviation {
	readonly scenario: string;
	readonly request: string;
	readonly facet: Facet;
	readonly reason: string;
}

const CUSTOM_SCHEME =
	"a custom HTTP scheme has no Postman auth helper; the importer drops the credential, this emitter sends it as the Authorization header the scheme defines";
const OPTIONAL_ANONYMOUS =
	"`NoAuth | OAuth2` allows either; the importer takes the first option, this emitter the one that carries a credential, which the spec accepts too";
const BINARY =
	"a binary body is Postman's file mode; the importer writes a raw text body a binary server cannot accept";
const OPTIONAL_SEGMENT =
	"`{/name}` expands to a path segment of its own; the importer renders it `optional{{name}}`, which is neither the route nor a variable Postman fills";

const DEVIATIONS: readonly Deviation[] = [
	{
		scenario: "authentication/http/custom",
		request: "GET /authentication/http/custom/valid",
		facet: "headers",
		reason: CUSTOM_SCHEME,
	},
	{
		scenario: "authentication/http/custom",
		request: "GET /authentication/http/custom/invalid",
		facet: "headers",
		reason: CUSTOM_SCHEME,
	},
	{
		scenario: "authentication/noauth/union",
		request: "GET /authentication/noauth/union/valid",
		facet: "auth",
		reason: OPTIONAL_ANONYMOUS,
	},
	{
		scenario: "authentication/noauth/union",
		request: "GET /authentication/noauth/union/validtoken",
		facet: "auth",
		reason: OPTIONAL_ANONYMOUS,
	},
	...["default", "octet-stream", "custom-content-type"].map((name) => ({
		scenario: "encode/bytes",
		request: `POST /encode/bytes/body/request/${name}`,
		facet: "body" as const,
		reason: BINARY,
	})),
	...[
		"specific-content-type",
		"json-content-type",
		"multiple-content-types",
		"default-content-type",
	].map((name) => ({
		scenario: "type/file",
		request: `POST /type/file/body/request/${name}`,
		facet: "body" as const,
		reason: BINARY,
	})),
	{
		scenario: "parameters/path",
		request: "GET /parameters/path/optional/name",
		facet: "route",
		reason: OPTIONAL_SEGMENT,
	},
	{
		scenario: "parameters/path",
		request: "GET /parameters/path/optional{}",
		facet: "route",
		reason: OPTIONAL_SEGMENT,
	},
];

/** Scenarios openapi3 publishes no document for, so there is nothing to convert. */
const NO_DOCUMENT = ["response/status-code-range", "routes", "special-words"];

interface RequestFacets {
	readonly variables: readonly string[];
	readonly query: readonly string[];
	readonly headers: readonly string[];
	readonly auth: string;
	readonly body: string | null;
}

/** `noauth` and no auth object send the same request. */
const authType = (auth: PostmanAuth | undefined | null) =>
	auth === undefined || auth === null || auth.type === "noauth" ? "none" : auth.type;

function facetsOf(collection: PostmanCollection): Map<string, RequestFacets> {
	const facets = new Map<string, RequestFacets>();
	const walk = (items: readonly PostmanItem[], inherited: PostmanAuth | undefined) => {
		for (const item of items) {
			if (item.item !== undefined) {
				walk(item.item, item.auth ?? inherited);
				continue;
			}
			const request = item.request;
			if (request === undefined) continue;
			const route = `/${request.url.path
				.map((segment) => segment.replace(/^:.*$/, "{}").replace(/\{\{[^}]*\}\}/g, "{}"))
				.join("/")}`;
			// The importer writes `header: null` where an operation has none.
			const headers = request.header ?? [];
			const contentType = headers.find(
				(header) => header.key.toLowerCase() === "content-type",
			)?.value;
			facets.set(`${request.method} ${route}`, {
				variables: (request.url.variable ?? []).map((variable) => variable.key).toSorted(),
				query: [...new Set((request.url.query ?? []).map((param) => param.key))].toSorted(),
				headers: [...new Set(headers.map((header) => header.key.toLowerCase()))].toSorted(),
				auth: authType(
					request.auth === undefined || request.auth === null ? inherited : request.auth,
				),
				body:
					request.body?.mode === undefined
						? null
						: `${request.body.mode} ${contentType ?? ""}`.trim(),
			});
		}
	};
	walk(collection.item, collection.auth);
	return facets;
}

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

const observed: Deviation[] = [];
let compared = 0;
const converted: string[] = [];

beforeAll(async () => {
	for (const scenario of scenarios()) {
		if (NO_DOCUMENT.includes(scenario)) continue;
		const outDir = join(here, ".out", "importer", scenario.replaceAll("/", "__"));
		const compiled = await compileSpec(join(specsRoot, scenario, "main.tsp"), outDir, {
			openapi: true,
		});
		const documents = existsSync(join(outDir, "openapi"))
			? readdirSync(join(outDir, "openapi"))
			: [];
		const collections = readdirSync(outDir).filter((name) =>
			name.endsWith("postman_collection.json"),
		);
		// One service each in this corpus; a scenario with several would need pairing by name.
		if (documents.length !== 1 || collections.length !== 1)
			throw new Error(
				`${scenario}: ${documents.length} documents, ${collections.length} collections`,
			);
		const document = readFileSync(join(outDir, "openapi", documents[0] ?? ""), "utf8");
		const result = await new Promise<CollectionResult>((resolve, reject) =>
			converter.convertV2(
				{ type: "string", data: document },
				{ parametersResolution: "Example" },
				(error, value) =>
					error !== null || value === undefined
						? reject(new Error(error?.message ?? "no result"))
						: resolve(value),
			),
		);
		if (!result.result) throw new Error(`${scenario}: the importer refused the document`);
		converted.push(scenario);
		const ours = facetsOf(compiled.collection(collections[0]));
		const theirs = facetsOf(result.output?.[0]?.data as PostmanCollection);
		for (const request of new Set([...ours.keys(), ...theirs.keys()])) {
			const a = ours.get(request);
			const b = theirs.get(request);
			if (a === undefined || b === undefined) {
				observed.push({
					scenario,
					request,
					facet: "route",
					reason: a === undefined ? "only the importer has it" : "only this emitter has it",
				});
				continue;
			}
			compared++;
			for (const facet of ["variables", "query", "headers", "auth", "body"] as const) {
				if (JSON.stringify(a[facet]) !== JSON.stringify(b[facet])) {
					observed.push({
						scenario,
						request,
						facet,
						reason: `this emitter ${JSON.stringify(a[facet])}, importer ${JSON.stringify(b[facet])}`,
					});
				}
			}
		}
	}
}, 1_800_000);

const key = (deviation: Pick<Deviation, "scenario" | "request" | "facet">) =>
	`${deviation.scenario} | ${deviation.request} | ${deviation.facet}`;

describe("the collection agrees with Postman's own importer", () => {
	it("compared the corpus request by request, not a sample of it", () => {
		expect(converted.length).toBe(scenarios().length - NO_DOCUMENT.length);
		// Measured at 641 requests on http-specs 0.1.0-alpha.43; a floor, so a corpus that shrank would say so.
		expect(compared).toBeGreaterThanOrEqual(600);
	});

	it("differs only where a listed reason says it must", () => {
		const listed = new Set(DEVIATIONS.map(key));
		expect(observed.filter((deviation) => !listed.has(key(deviation)))).toEqual([]);
	});

	it("still differs everywhere the list says, so no reason outlives its difference", () => {
		const seen = new Set(observed.map(key));
		expect(DEVIATIONS.filter((deviation) => !seen.has(key(deviation))).map(key)).toEqual([]);
	});
});
