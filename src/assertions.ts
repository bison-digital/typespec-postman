import {
	getEncode,
	type Model,
	type ModelProperty,
	type Program,
	resolveEncodedName,
} from "@typespec/compiler";
import { $ } from "@typespec/compiler/typekit";
import { type HttpOperation, Visibility } from "@typespec/http";
import { reportDiagnostic } from "./lib.js";
import type { PlanAssertion, StatusMatch } from "./model.js";
import type { DerivedRequest } from "./requests.js";
import type { Role } from "./resources.js";
import type { ValueContext } from "./values.js";

/**
 * The checks a request carries. **Exactly what a good hand-written collection asserts and nothing
 * more**: the status, that a created resource came back with its id, that a list is a list, that a
 * fetched resource is the one asked for, and that an updated field holds what was sent. Every one is
 * derived from the spec, so none can drift from it. Schema validation is not here on purpose.
 */
export function deriveAssertions(
	context: ValueContext,
	operation: HttpOperation,
	roles: readonly Role[],
	sent: DerivedRequest["sent"],
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
