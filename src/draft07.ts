/**
 * An OpenAPI 3.1 response schema as the one self-contained JSON Schema the Postman sandbox can check.
 *
 * **Postman's `pm.response.to.have.jsonSchema` is Ajv 6.12.5, which speaks draft-07.** Measured on the
 * Postman CLI 1.56.1 against a local server, each keyword with a body that must fail when the keyword
 * is honoured:
 *
 * - `$ref` to `#/$defs/...` resolves, recursion included, but a `$ref` into `#/components/...` does
 *   not ("can't resolve reference"), so every referenced component is copied into `$defs`;
 * - a 2020-12 `$schema` is refused outright, so no `$schema` is written;
 * - `prefixItems` and `unevaluatedProperties` are silently IGNORED, so a tuple or a record whose
 *   values are wrong passes unless they are rewritten into their draft-07 forms;
 * - a `format` Ajv 6 does not know (`int32`, `duration`, `byte`) throws "unknown format" on a valid
 *   body unless it is listed in `unknownFormats`;
 * - a sibling of `$ref` is ignored in draft-07 and applied in 2020-12, so such a node becomes
 *   `allOf: [{ $ref }]` beside its siblings.
 *
 * **A rewrite is only ever toward accepting MORE, never less.** `unevaluatedProperties` beside
 * `allOf`, `anyOf` or `oneOf` sees properties a draft-07 `additionalProperties` cannot, so there it is
 * dropped rather than approximated: the check says less about such a node, and can never refuse a
 * body the document accepts. `test/schemas/fidelity.test.ts` holds every conversion to the document's
 * own verdict under Ajv 2020-12, over the whole corpus.
 *
 * Pure: no compiler, so the renderer can carry the result and the conversion can be graded alone.
 */

export type JsonSchema = boolean | { readonly [key: string]: unknown };

/** The formats Ajv 6.12.5 validates out of the box. Any other must be declared, or it throws. */
const AJV6_FORMATS: ReadonlySet<string> = new Set([
	"date",
	"time",
	"date-time",
	"uri",
	"uri-reference",
	"uri-template",
	"url",
	"email",
	"hostname",
	"ipv4",
	"ipv6",
	"regex",
	"uuid",
	"json-pointer",
	"json-pointer-uri-fragment",
	"relative-json-pointer",
]);

/** Keywords that describe a value and never constrain one; draft-07 has no use for them. */
const ANNOTATIONS: ReadonlySet<string> = new Set([
	"$schema",
	"readOnly",
	"writeOnly",
	"discriminator",
	"xml",
	"externalDocs",
	"example",
	"examples",
	"deprecated",
	"contentEncoding",
	"contentMediaType",
]);

/** Keywords whose value is a map from a NAME to a schema, where the name is not a keyword. */
const SCHEMA_MAPS: ReadonlySet<string> = new Set([
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
]);

/** Keywords whose value is DATA, which is copied as written and never read as a schema. */
const DATA: ReadonlySet<string> = new Set(["enum", "const", "default", "required"]);

const COMPONENT = "#/components/schemas/";

export interface ConvertedSchema {
	readonly schema: JsonSchema;
	/** Formats the schema uses that Ajv 6 does not know, for `jsonSchema`'s `unknownFormats`. */
	readonly unknownFormats: readonly string[];
	/** Whether a constraint draft-07 cannot state was dropped, so the check accepts more than the document. */
	readonly loosened: boolean;
}

/** A JSON pointer token, as RFC 6901 escapes it. */
function pointerToken(name: string): string {
	return name.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Convert `schema`, resolving `#/components/schemas/...` references against `components`.
 */
export function toDraft07(
	schema: unknown,
	components: Readonly<Record<string, unknown>>,
): ConvertedSchema {
	const defs: Record<string, JsonSchema> = {};
	const formats = new Set<string>();
	const hoisted = new Set<string>();
	let loosened = false;

	const convert = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(convert);
		if (node === null || typeof node !== "object") return node;
		const source = node as Record<string, unknown>;
		const composed = "allOf" in source || "anyOf" in source || "oneOf" in source;
		let out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(source)) {
			if (ANNOTATIONS.has(key) || key.startsWith("x-")) continue;
			if (DATA.has(key)) {
				out[key] = value;
				continue;
			}
			if (key === "$ref" && typeof value === "string" && value.startsWith(COMPONENT)) {
				const name = value.slice(COMPONENT.length);
				out["$ref"] = `#/$defs/${pointerToken(name)}`;
				if (!hoisted.has(name)) {
					hoisted.add(name);
					defs[name] = convert(components[name] ?? {}) as JsonSchema;
				}
				continue;
			}
			if (key === "prefixItems" && Array.isArray(value)) {
				out["items"] = value.map(convert);
				out["additionalItems"] = source["items"] === undefined ? true : convert(source["items"]);
				continue;
			}
			if (key === "items" && Array.isArray(source["prefixItems"])) continue;
			if (key === "unevaluatedProperties") {
				if (composed) loosened = true;
				else out["additionalProperties"] = convert(value);
				continue;
			}
			if (key === "format" && typeof value === "string") {
				out["format"] = value;
				if (!AJV6_FORMATS.has(value)) formats.add(value);
				continue;
			}
			if (SCHEMA_MAPS.has(key) && value !== null && typeof value === "object") {
				out[key] = Object.fromEntries(
					Object.entries(value as Record<string, unknown>).map(([name, entry]) => [
						name,
						convert(entry),
					]),
				);
				continue;
			}
			out[key] = convert(value);
		}
		if (typeof out["$ref"] === "string" && Object.keys(out).length > 1) {
			const { $ref, ...rest } = out;
			out = { allOf: [{ $ref }], ...rest };
		}
		return out;
	};

	const root = convert(schema);
	/**
	 * `$defs` goes beside the root, and a root that is itself a `$ref` is wrapped first: in draft-07 a
	 * `$ref`'s siblings are ignored, so the definitions would sit where nothing reads them.
	 */
	const withDefs =
		Object.keys(defs).length === 0
			? root
			: root !== null && typeof root === "object" && !Array.isArray(root) && !("$ref" in root)
				? { ...(root as Record<string, unknown>), $defs: defs }
				: { allOf: [root], $defs: defs };
	return {
		schema: (withDefs ?? true) as JsonSchema,
		unknownFormats: [...formats].toSorted(),
		loosened,
	};
}
