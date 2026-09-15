import { getNamespaceFullName, type Program } from "@typespec/compiler";
import type { HttpOperation, HttpService } from "@typespec/http";
import { getOpenAPI3 } from "@typespec/openapi3";
import { type ConvertedSchema, toDraft07 } from "./draft07.js";
import { reportDiagnostic } from "./lib.js";

/**
 * The JSON Schema each response body must satisfy, read from the document `@typespec/openapi3` builds
 * from the same program, in the same process.
 *
 * **`getOpenAPI3`, not `openapi.json`.** The emitter reads the program; the document is built from it
 * here, with openapi3's own schema emitter, so every rule that decides a schema (visibility, encodings,
 * discriminators, nullability) is the reference implementation's and none is restated. Measured: the
 * in-process document is deep-equal to the file openapi3 writes.
 *
 * **3.1, unsealed.** 3.1 is JSON Schema; sealing would refuse properties a server may add, which the
 * document of an unsealed spec permits. What the consumer's own openapi3 options are does not matter:
 * this is the contract a response is checked against, not a document anyone reads.
 */
export interface ResponseSchemas {
	/** The converted schema for one response body, or `undefined` when the document states none. */
	forResponse(
		operation: HttpOperation,
		status: number,
		contentType: string,
	): ConvertedSchema | undefined;
}

const NONE: ResponseSchemas = { forResponse: () => undefined };

interface DocumentShape {
	readonly paths?: Readonly<
		Record<
			string,
			Readonly<
				Record<
					string,
					{
						readonly responses?: Readonly<
							Record<string, { readonly content?: Readonly<Record<string, { schema?: unknown }>> }>
						>;
					}
				>
			>
		>
	>;
	readonly components?: { readonly schemas?: Readonly<Record<string, unknown>> };
}

export async function loadResponseSchemas(
	program: Program,
	service: HttpService,
): Promise<ResponseSchemas> {
	const fullName = getNamespaceFullName(service.namespace);
	let document: DocumentShape | undefined;
	try {
		const records = await getOpenAPI3(program, { "openapi-versions": ["3.1.0"] });
		const record = records.find(
			(candidate) => getNamespaceFullName(candidate.service.type) === fullName,
		);
		if (record === undefined) return NONE;
		/**
		 * The LAST version, as the collection itself is projected to it. Each record's diagnostics are
		 * not reported to the program by `getOpenAPI3`, so an error in one is surfaced here rather than
		 * silently producing a document with holes.
		 */
		const chosen = record.versioned ? record.versions.at(-1) : record;
		if (chosen === undefined) return NONE;
		const errors = chosen.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
		if (errors.length > 0) {
			reportDiagnostic(program, {
				code: "schema-unavailable",
				format: {
					service: fullName,
					reason: [...new Set(errors.map((diagnostic) => diagnostic.code))].join(", "),
				},
				target: service.namespace,
			});
		}
		// Normalised: the in-process document carries undefined-valued keys and builder prototypes.
		document = JSON.parse(JSON.stringify(chosen.document)) as DocumentShape;
	} catch (error) {
		reportDiagnostic(program, {
			code: "schema-unavailable",
			format: {
				service: fullName,
				reason: (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "",
			},
			target: service.namespace,
		});
		return NONE;
	}
	const components = document.components?.schemas ?? {};
	const cache = new Map<string, ConvertedSchema | undefined>();
	return {
		forResponse(operation, status, contentType) {
			const key = `${operation.verb} ${operation.path} ${status} ${contentType}`;
			if (!cache.has(key)) {
				const schema =
					document?.paths?.[operation.path]?.[operation.verb]?.responses?.[String(status)]
						?.content?.[contentType]?.schema;
				cache.set(key, schema === undefined ? undefined : toDraft07(schema, components));
			}
			return cache.get(key);
		},
	};
}
