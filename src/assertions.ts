import {
	getEncode,
	type Model,
	type ModelProperty,
	type Program,
	resolveEncodedName,
} from "@typespec/compiler";
import { $ } from "@typespec/compiler/typekit";
import { type HttpOperation, type HttpOperationResponse, Visibility } from "@typespec/http";
import { reportDiagnostic } from "./lib.js";
import type { PlanAssertion, StatusMatch } from "./model.js";
import type { DerivedRequest } from "./requests.js";
import type { Role } from "./resources.js";
import type { ResponseSchemas } from "./schemas.js";
import type { ValueContext } from "./values.js";

/**
 * The checks a request carries, every one derived from the spec so none can drift from it.
 *
 * **The response contract, as the established generator checks it and Postman writes it.** Portman's
 * defaults are the status, the Content-Type, the required response headers and the body's schema, and
 * the Postman Learning Center writes each of those as one `pm.test`. Portman's own schema conversion
 * false-fails TypeSpec output (a `duration` field, a nullable enum, any `$ref`), so the schema is
 * converted by `draft07.ts` and graded against the document by `test/schemas/fidelity.test.ts`.
 *
 * **Then the chaining convention's roles**: a created resource came back with its id, a list is a
 * list, a fetched resource is the one asked for, and an updated field holds what was sent.
 */
export function deriveAssertions(
	context: ValueContext,
	operation: HttpOperation,
	roles: readonly Role[],
	sent: DerivedRequest["sent"],
	schemas: ResponseSchemas,
): PlanAssertion[] {
	const { program } = context;
	const assertions: PlanAssertion[] = [];
	const codes = successCodes(operation);
	if (codes.length === 0) {
		reportDiagnostic(program, {
			code: "no-success-response",
			format: { operation: operation.operation.name },
			target: operation.operation,
		});
	} else {
		assertions.push({ kind: "status", codes });
		assertions.push(...responseChecks(operation, successResponsesOf(operation), schemas));
	}
	for (const role of roles) {
		const { resource } = role;
		switch (role.kind) {
			case "create":
				assertions.push({
					kind: "has-key",
					key: resource.keyWire,
					type: resource.keyType,
					variable: resource.variable,
				});
				break;
			case "list":
				assertions.push({ kind: "is-array", path: role.items });
				break;
			case "read":
				assertions.push({
					kind: "key-matches",
					key: resource.keyWire,
					variable: resource.variable,
					resource: resource.spoken,
				});
				break;
			case "update":
				assertions.push(...updatedFields(context, operation, resource.model, sent));
				break;
			case "delete":
				break;
		}
	}
	return assertions;
}

/** An operation's 2xx responses, exact and ranged. */
export function successResponsesOf(operation: HttpOperation): HttpOperationResponse[] {
	return operation.responses.filter((response) => {
		const declared = response.statusCodes;
		if (declared === "*") return false;
		return typeof declared === "number"
			? declared >= 200 && declared <= 299
			: declared.start >= 200 && declared.end <= 299;
	});
}

const JSON_MEDIA = /^application\/(?:[\w.+-]+\+)?json$/i;

/**
 * What the declared responses for the statuses a request expects say about any response it gets:
 * its media type, the headers every one of them requires, that there is no body, or that the body
 * satisfies the schema for its status.
 *
 * **Each check is emitted only where EVERY declared response agrees**, because the request may get
 * any of them: a Content-Type is checked only when each carries a body, `no-body` only when none does,
 * a header only when each requires it, and a schema only when each status has exactly one JSON body
 * whose schema the document states. A partial check would fail a server answering with another
 * response the contract allows.
 */
export function responseChecks(
	operation: HttpOperation,
	responses: readonly HttpOperationResponse[],
	schemas: ResponseSchemas,
): PlanAssertion[] {
	const contents = responses.flatMap((response) => response.responses);
	if (contents.length === 0) return [];
	const withBody = contents.filter((content) => content.body !== undefined);
	const checks: PlanAssertion[] = [];
	if (withBody.length === contents.length) {
		const types = [...new Set(withBody.flatMap((content) => content.body?.contentTypes ?? []))];
		if (types.length > 0) checks.push({ kind: "content-type", types });
	}
	const required = contents
		.map(
			(content) =>
				new Set(
					Object.entries(content.headers ?? {})
						.filter(([, property]) => !property.optional)
						.map(([name]) => name.toLowerCase()),
				),
		)
		.reduce((common, names) => new Set([...common].filter((name) => names.has(name))));
	const spelled = new Map(
		contents.flatMap((content) =>
			Object.keys(content.headers ?? {}).map((name) => [name.toLowerCase(), name] as const),
		),
	);
	for (const name of [...required].toSorted()) {
		checks.push({ kind: "header-present", name: spelled.get(name) ?? name });
	}
	if (withBody.length === 0) {
		checks.push({ kind: "no-body" });
		return checks;
	}
	if (withBody.length !== contents.length) return checks;
	const perStatus: { status: number; schema: unknown }[] = [];
	const unknownFormats = new Set<string>();
	for (const response of responses) {
		if (typeof response.statusCodes !== "number" || response.responses.length !== 1) return checks;
		const [content] = response.responses;
		const contentType = content?.body?.contentTypes.find((type) => JSON_MEDIA.test(type));
		if (content?.body?.bodyKind !== "single" || contentType === undefined) return checks;
		const converted = schemas.forResponse(operation, response.statusCodes, contentType);
		if (converted === undefined) return checks;
		perStatus.push({ status: response.statusCodes, schema: converted.schema });
		for (const format of converted.unknownFormats) unknownFormats.add(format);
	}
	checks.push({
		kind: "json-schema",
		schemas: perStatus,
		unknownFormats: [...unknownFormats].toSorted(),
	});
	return checks;
}

/** The 2xx statuses an operation declares, in declaration order. */
function successCodes(operation: HttpOperation): StatusMatch[] {
	const codes: StatusMatch[] = [];
	for (const response of operation.responses) {
		const declared = response.statusCodes;
		if (declared === "*") continue;
		if (typeof declared === "number") {
			if (declared >= 200 && declared <= 299 && !codes.includes(declared)) codes.push(declared);
			continue;
		}
		if (declared.start >= 200 && declared.end <= 299)
			codes.push({ start: declared.start, end: declared.end });
	}
	return codes;
}

/**
 * Scalars a server may legitimately re-spell: `1970-01-01T00:00:00Z` comes back as
 * `1970-01-01T00:00:00.000Z` from any JavaScript server, and a decimal as a different float. An
 * equality check on those would fail a correct server.
 */
const RESPELLED = new Set([
	"utcDateTime",
	"offsetDateTime",
	"plainDate",
	"plainTime",
	"duration",
	"bytes",
	"decimal",
	"decimal128",
]);

function updatedFields(
	context: ValueContext,
	operation: HttpOperation,
	model: Model,
	sent: DerivedRequest["sent"],
): PlanAssertion[] {
	const { program, metadata } = context;
	const object = sent?.value;
	const fromExample = sent?.fromExample ?? new Set<string>();
	if (fromExample.size === 0) {
		const empty =
			object !== null &&
			typeof object === "object" &&
			!Array.isArray(object) &&
			Object.keys(object).length === 0;
		reportDiagnostic(program, {
			code: "update-without-example",
			messageId: empty ? "empty" : "default",
			format: { operation: operation.operation.name },
			target: operation.operation,
		});
		return [];
	}
	if (
		object === null ||
		object === undefined ||
		typeof object !== "object" ||
		Array.isArray(object)
	)
		return [];
	const properties = new Map<string, ModelProperty>();
	for (let current: Model | undefined = model; current !== undefined; current = current.baseModel) {
		for (const property of current.properties.values()) {
			/**
			 * **Only what a response carries**, the model at Read visibility. A write-only field an example
			 * sets is sent and never returned, so asserting it would fail against a correct server.
			 */
			if (!metadata.isPayloadProperty(property, Visibility.Read)) continue;
			const wire = resolveEncodedName(program, property, "application/json");
			if (!properties.has(wire)) properties.set(wire, property);
		}
	}
	const assertions: PlanAssertion[] = [];
	for (const [field, value] of Object.entries(object)) {
		if (!fromExample.has(field)) continue;
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
			continue;
		const property = properties.get(field);
		if (property === undefined || respelled(program, property)) continue;
		assertions.push({ kind: "field-updated", field, value });
	}
	return assertions;
}

function respelled(program: Program, property: ModelProperty): boolean {
	if (getEncode(program, property) !== undefined) return true;
	const candidates =
		property.type.kind === "Union"
			? [...property.type.variants.values()].map((variant) => variant.type)
			: [property.type];
	return candidates.some((type) => {
		if (type.kind !== "Scalar") return false;
		if (getEncode(program, type) !== undefined) return true;
		const std = $(program).scalar.getStdBase(type);
		return std !== null && RESPELLED.has(std.name);
	});
}
