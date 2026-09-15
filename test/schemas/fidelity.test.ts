import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, NodeHost } from "@typespec/compiler";
import { createMetadataInfo, getAllHttpServices, Visibility } from "@typespec/http";
import { getOpenAPI3 } from "@typespec/openapi3";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { beforeAll, describe, expect, it } from "vitest";
import { toDraft07 } from "../../src/draft07.js";
import { synthesiseBody } from "../../src/values.js";

/**
 * **Every response schema the collection checks gives the verdict the document gives.**
 *
 * The collection asserts response bodies with `pm.response.to.have.jsonSchema`, which is Ajv 6.12.5
 * speaking draft-07, so each OpenAPI 3.1 schema is converted (`src/draft07.ts`). A conversion that is
 * wrong either false-fails a correct server or waves through a body the contract refuses, and nothing
 * else here would see which. So for every JSON response body across `@typespec/http-specs`:
 *
 * - a body generated at Read visibility, and mutations of it (each top-level property removed, each
 *   flipped to a value of another JSON type, one unknown key added), are each judged twice: by Ajv
 *   2020-12 against the document `@typespec/openapi3` builds from the same program, and by
 *   **`ajv@6.12.5`, the version the Postman sandbox pins**, against the converted schema;
 * - the two verdicts must agree. The only exception allowed is a conversion that reports it LOOSENED
 *   (a constraint draft-07 cannot state was dropped), and then only in the direction of accepting.
 *
 * **Neither verdict comes from this emitter**: one is openapi3's document under the reference JSON
 * Schema validator, the other is the validator Postman runs.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const specsRoot = fileURLToPath(
	new URL("../../node_modules/@typespec/http-specs/specs/", import.meta.url),
);

/** Scenarios openapi3 cannot build a document for, with its own reason. Named, never counted. */
const NO_DOCUMENT: Readonly<Record<string, string>> = {
	"special-words": "@typespec/openapi3 throws while emitting examples",
};

interface AjvSix {
	validate(schema: unknown, data: unknown): boolean;
}
/** Constructed per assertion with the assertion's options, as chai-postman constructs it. */
const Ajv6 = createRequire(import.meta.url)("ajv6") as new (options: object) => AjvSix;

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

/** A value of a different JSON type than `value`, for a type-flip mutation. */
function flipped(value: unknown): unknown {
	if (typeof value === "string") return 12345;
	if (typeof value === "number" || typeof value === "boolean") return "flipped";
	if (Array.isArray(value)) return "flipped";
	if (value === null) return "flipped";
	return 12345;
}

interface Disagreement {
	readonly where: string;
	readonly value: string;
	readonly document: boolean;
	readonly postman: boolean;
	readonly loosened: boolean;
}

const disagreements: Disagreement[] = [];
const refused: string[] = [];
let judged = 0;
let bodies = 0;
let loosenedAccepts = 0;
/** How many judged schemas exercised each rewrite, so the agreement above is not vacuous. */
const rewrites = { components: 0, prefixItems: 0, unevaluatedProperties: 0, unknownFormats: 0 };

/** The corpus, then this suite's own fixture for the rewrites no corpus response exercises. */
function sources(): { readonly name: string; readonly file: string }[] {
	return [
		...scenarios().map((scenario) => ({
			name: scenario,
			file: join(specsRoot, scenario, "main.tsp"),
		})),
		{ name: "rewrites", file: join(here, "rewrites.tsp") },
	];
}

beforeAll(async () => {
	for (const { name: scenario, file } of sources()) {
		const program = await compile(NodeHost, file, { noEmit: true });
		if (program.hasError()) continue;
		let records;
		try {
			records = await getOpenAPI3(program, { "openapi-versions": ["3.1.0"] });
		} catch {
			refused.push(scenario);
			continue;
		}
		const metadata = createMetadataInfo(program, { canonicalVisibility: Visibility.Read });
		const [services] = getAllHttpServices(program);
		for (const record of records) {
			const chosen = record.versioned ? record.versions.at(-1) : record;
			if (chosen === undefined) continue;
			const document = JSON.parse(JSON.stringify(chosen.document)) as {
				paths?: Record<
					string,
					Record<
						string,
						{ responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }
					>
				>;
				components?: { schemas?: Record<string, unknown> };
			};
			const components = document.components?.schemas ?? {};
			const ajv2020 = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
			addFormats.default(ajv2020);
			ajv2020.addSchema(document as object, "https://document.test/openapi.json");
			const service = services.find((candidate) => candidate.namespace === record.service.type);
			for (const operation of service?.operations ?? []) {
				for (const response of operation.responses) {
					if (typeof response.statusCodes !== "number") continue;
					const status = String(response.statusCodes);
					for (const content of response.responses) {
						const body = content.body;
						if (body?.bodyKind !== "single") continue;
						for (const contentType of body.contentTypes) {
							if (!/^application\/(?:[\w.+-]+\+)?json$/i.test(contentType)) continue;
							const schema =
								document.paths?.[operation.path]?.[operation.verb]?.responses?.[status]?.content?.[
									contentType
								]?.schema;
							if (schema === undefined) continue;
							const pointer = `https://document.test/openapi.json#/paths/${operation.path.replaceAll("~", "~0").replaceAll("/", "~1")}/${operation.verb}/responses/${status}/content/${contentType.replaceAll("~", "~0").replaceAll("/", "~1")}/schema`;
							const validate = ajv2020.getSchema(pointer);
							if (validate === undefined) continue;
							const converted = toDraft07(schema, components);
							const ajv6 = new Ajv6({
								allErrors: true,
								logger: false,
								unknownFormats: converted.unknownFormats,
							});
							const reachable = JSON.stringify(converted.schema);
							if (reachable.includes('"$defs"')) rewrites.components++;
							if (
								JSON.stringify(schema).includes("prefixItems") ||
								reachable.includes("additionalItems")
							)
								rewrites.prefixItems++;
							if (converted.loosened || /unevaluatedProperties/.test(JSON.stringify(components)))
								rewrites.unevaluatedProperties++;
							if (converted.unknownFormats.length > 0) rewrites.unknownFormats++;
							const valid = synthesiseBody(
								{ program, metadata },
								body.type,
								Visibility.Read,
								false,
							).value;
							bodies++;
							const values: unknown[] = [valid];
							if (valid !== null && typeof valid === "object" && !Array.isArray(valid)) {
								const object = valid as Record<string, unknown>;
								for (const key of Object.keys(object)) {
									const { [key]: _removed, ...without } = object;
									values.push(without);
									values.push({ ...object, [key]: flipped(object[key]) });
									const inner = object[key];
									// One level deeper: a list's first member, and each property of a nested object.
									if (Array.isArray(inner) && inner.length > 0) {
										values.push({ ...object, [key]: [flipped(inner[0]), ...inner.slice(1)] });
									} else if (inner !== null && typeof inner === "object") {
										for (const nested of Object.keys(inner)) {
											const record = inner as Record<string, unknown>;
											values.push({
												...object,
												[key]: { ...record, [nested]: flipped(record[nested]) },
											});
										}
									}
								}
								values.push({ ...object, unknownPropertyAddedByTheOracle: true });
							} else {
								values.push(flipped(valid));
							}
							for (const value of values) {
								judged++;
								const byDocument = validate(value) === true;
								/**
								 * A schema Ajv 6 cannot compile throws inside `pm.test`, which Postman reports as a
								 * failed assertion, so a throw is a refusal here too.
								 */
								let byPostman: boolean;
								try {
									byPostman = ajv6.validate(converted.schema, value);
								} catch {
									byPostman = false;
								}
								if (byDocument === byPostman) continue;
								if (converted.loosened && byPostman && !byDocument) {
									loosenedAccepts++;
									continue;
								}
								disagreements.push({
									where: `${scenario} ${operation.verb.toUpperCase()} ${operation.path} ${status} ${contentType}`,
									value: JSON.stringify(value).slice(0, 200),
									document: byDocument,
									postman: byPostman,
									loosened: converted.loosened,
								});
							}
						}
					}
				}
			}
		}
	}
}, 1_800_000);

describe("the converted response schemas give the document's verdict under Postman's validator", () => {
	it("judged the corpus, not a sample of it", () => {
		// 262 bodies and 1054 values on http-specs alpha.43 when written; set at half.
		expect(bodies).toBeGreaterThanOrEqual(130);
		expect(judged).toBeGreaterThanOrEqual(520);
	});

	it("refuses only the scenarios openapi3 cannot build a document for", () => {
		expect(refused.toSorted()).toEqual(Object.keys(NO_DOCUMENT).toSorted());
	});

	it("agrees on every value, loosening only toward accepting", () => {
		expect(disagreements).toEqual([]);
	});

	it("exercised every rewrite the conversion makes", () => {
		expect(rewrites.components).toBeGreaterThanOrEqual(10);
		expect(rewrites.prefixItems).toBeGreaterThanOrEqual(1);
		expect(rewrites.unevaluatedProperties).toBeGreaterThanOrEqual(1);
		expect(rewrites.unknownFormats).toBeGreaterThanOrEqual(10);
	});
});
