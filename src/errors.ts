import {
	getDiscriminator,
	getFormat,
	getMaxLength,
	getMaxValue,
	getMinLength,
	getPattern,
	type Model,
	type ModelProperty,
	type Program,
	resolveEncodedName,
} from "@typespec/compiler";
import { $ } from "@typespec/compiler/typekit";
import {
	type HttpOperation,
	type HttpOperationResponse,
	resolveRequestVisibility,
} from "@typespec/http";
import { responseChecks } from "./assertions.js";
import { type AuthDerivation, type Requirement, sameSetting } from "./auth.js";
import type { AuthSetting, PlanBody, PlanFolder, PlanParam, PlanRequest } from "./model.js";
import { declarationOrder } from "./order.js";
import { deriveRequest } from "./requests.js";
import type { Chains, Resource } from "./resources.js";
import type { ResponseSchemas } from "./schemas.js";
import type { ValueContext } from "./values.js";

/**
 * **Requests the spec says must fail, and the failure it says they get.** Generated only where the
 * operation declares that failure and the request can be made deterministically:
 *
 * - **not found**: a read (else an update or delete) of a chained resource whose operation declares
 *   404, with an id no request created;
 * - **invalid body**: an operation with a JSON body that declares 400 or 422, sending its body with
 *   one required, request-visible property removed;
 * - **unauthorized**: once per credentialed requirement that some operation declaring 401 carries,
 *   sent with no credential.
 *
 * Each asserts the declared status and the response checks for that status, so a server answering a
 * request its contract refuses with a 200, or with a body its contract does not declare, fails.
 * They sit in one `Error cases` folder at the end of the collection, after every success case.
 */
export function deriveErrorCases(options: {
	readonly context: ValueContext;
	readonly operations: readonly HttpOperation[];
	readonly chains: Chains;
	readonly auth: AuthDerivation;
	readonly schemas: ResponseSchemas;
	readonly fullName: string;
	readonly collectionAuth: AuthSetting | undefined;
}): PlanFolder | undefined {
	const { context, operations, chains, auth, schemas, fullName, collectionAuth } = options;
	const { program } = context;
	const order = declarationOrder(program, operations);
	const ordered = [...operations].toSorted((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
	const items: PlanRequest[] = [];

	const request = (
		operation: HttpOperation,
		kind: string,
		status: readonly number[],
		shape: (
			base: ReturnType<typeof deriveRequest>,
			requirement: Requirement,
		) => {
			readonly url: PlanRequest["url"];
			readonly headers: readonly PlanParam[];
			readonly body: PlanBody | undefined;
			readonly auth: AuthSetting;
		},
	): PlanRequest => {
		const requirement = auth.forOperation(operation);
		const base = deriveRequest(context, operation, chains, requirement);
		const shaped = shape(base, requirement);
		const declared = operation.responses.filter(
			(response) =>
				typeof response.statusCodes === "number" && status.includes(response.statusCodes),
		);
		return {
			kind: "request",
			identity: `${fullName}/error/${kind}/${operation.verb} ${operation.uriTemplate}/${operation.operation.name}`,
			name: `${base.name}: ${kind}`,
			description: base.description,
			method: base.method,
			url: shaped.url,
			headers: shaped.headers,
			body: shaped.body,
			auth: sameSetting(shaped.auth, collectionAuth) ? undefined : shaped.auth,
			assertions: [
				{ kind: "status", codes: declared.map((response) => response.statusCodes as number) },
				...responseChecks(operation, declared, schemas),
			],
		};
	};

	// Not found: one per resource.
	for (const resource of chains.resources) {
		const operation = ["read", "update", "delete"]
			.map((kind) =>
				ordered.find(
					(candidate) =>
						declares(candidate, 404) &&
						chains
							.roles(candidate)
							.some((role) => role.kind === kind && role.resource === resource),
				),
			)
			.find((candidate) => candidate !== undefined);
		const missing = operation === undefined ? undefined : missingKeyOf(program, resource);
		if (operation === undefined || missing === undefined) continue;
		items.push(
			request(operation, "not found", [404], (base, requirement) => ({
				url: withMissingKey(base.url, resource, missing),
				headers: base.headers,
				body: base.body,
				auth: requirement.setting,
			})),
		);
	}

	// Invalid body: one per operation with a JSON body that declares the refusal.
	for (const operation of ordered) {
		const status = [400, 422].filter((code) => declares(operation, code));
		if (status.length === 0) continue;
		const requirement = auth.forOperation(operation);
		const base = deriveRequest(context, operation, chains, requirement);
		const value = base.sent?.value;
		if (
			base.body?.mode !== "raw" ||
			value === null ||
			typeof value !== "object" ||
			Array.isArray(value)
		)
			continue;
		const removable = requiredBodyKey(context, operation, Object.keys(value));
		if (removable === undefined) continue;
		const { [removable]: _removed, ...invalid } = value as Record<string, unknown>;
		items.push(
			request(operation, "invalid body", status, (shaped, required) => ({
				url: shaped.url,
				headers: shaped.headers,
				body: { mode: "raw", raw: JSON.stringify(invalid, null, 2), language: "json" },
				auth: required.setting,
			})),
		);
	}

	// Unauthorized: once per credentialed requirement, on the operation needing the fewest chained ids.
	const seen = new Set<string>();
	const candidates = ordered
		.filter((operation) => declares(operation, 401))
		.toSorted((a, b) => chains.consumes(a).length - chains.consumes(b).length);
	for (const operation of candidates) {
		const requirement = auth.forOperation(operation);
		if (requirement.anonymous) continue;
		if (
			requirement.setting.kind === "none" &&
			requirement.headers.length === 0 &&
			requirement.query.length === 0
		)
			continue;
		const signature = JSON.stringify([requirement.setting, requirement.headers, requirement.query]);
		if (seen.has(signature)) continue;
		seen.add(signature);
		items.push(
			request(operation, "unauthorized", [401], (base, required) => ({
				url: {
					...base.url,
					query: base.url.query.filter(
						(param) => !required.query.some((credential) => credential.key === param.key),
					),
				},
				headers: withoutCredentials(base.headers, required),
				body: base.body,
				auth: { kind: "none" },
			})),
		);
	}

	if (items.length === 0) return undefined;
	return {
		kind: "folder",
		identity: `${fullName}/Error cases`,
		name: "Error cases",
		description:
			"Requests the spec says must fail, each asserting the failure it declares. Generated after every success case.",
		auth: undefined,
		items,
	};
}

function declares(operation: HttpOperation, status: number): boolean {
	return operation.responses.some(
		(response: HttpOperationResponse) => response.statusCodes === status,
	);
}

/**
 * An id no request created, in the key's own type, or `undefined` where no such value is certain to
 * satisfy the key's constraints (a pattern, a length) and so would be refused as invalid instead.
 */
function missingKeyOf(program: Program, resource: Resource): string | undefined {
	const key = resource.key;
	const format =
		getFormat(program, key) ??
		(key.type.kind === "Scalar" ? getFormat(program, key.type) : undefined);
	if (format === "uuid") return "00000000-0000-0000-0000-000000000000";
	if (resource.keyType === "number") {
		const maximum = getMaxValue(program, key);
		return String(maximum !== undefined && maximum < 2147483647 ? maximum : 2147483647);
	}
	if (key.type.kind !== "Scalar" || !$(program).scalar.extendsString(key.type)) return undefined;
	const constrained =
		getPattern(program, key) !== undefined ||
		getMinLength(program, key) !== undefined ||
		getMaxLength(program, key) !== undefined ||
		format !== undefined;
	return constrained ? undefined : "does-not-exist";
}

/** The URL with the resource's own chained variable, in the last segment carrying it, replaced. */
function withMissingKey(
	url: PlanRequest["url"],
	resource: Resource,
	missing: string,
): PlanRequest["url"] {
	const token = `{{${resource.variable}}}`;
	const at = url.path.findLastIndex((segment) => segment.includes(token));
	if (at === -1) return url;
	return {
		...url,
		path: url.path.map((segment, index) =>
			index === at ? segment.replace(token, missing) : segment,
		),
	};
}

/** The first key of the sent body that is required at the operation's request visibility, and not a discriminator. */
function requiredBodyKey(
	context: ValueContext,
	operation: HttpOperation,
	keys: readonly string[],
): string | undefined {
	const { program, metadata } = context;
	const type = operation.parameters.body?.type;
	if (type?.kind !== "Model") return undefined;
	const visibility = resolveRequestVisibility(program, operation.operation, operation.verb);
	const properties = new Map<string, ModelProperty>();
	const discriminators = new Set<string>();
	for (let current: Model | undefined = type; current !== undefined; current = current.baseModel) {
		const discriminator = getDiscriminator(program, current)?.propertyName;
		if (discriminator !== undefined) discriminators.add(discriminator);
		for (const property of current.properties.values()) {
			properties.set(resolveEncodedName(program, property, "application/json"), property);
		}
	}
	return keys.find((key) => {
		const property = properties.get(key);
		return (
			property !== undefined &&
			!discriminators.has(key) &&
			metadata.isPayloadProperty(property, visibility) &&
			!metadata.isOptional(property, visibility)
		);
	});
}

/** The headers without every credential the requirement adds, a credential cookie removed from `Cookie`. */
function withoutCredentials(headers: readonly PlanParam[], requirement: Requirement): PlanParam[] {
	const credentialCookie = requirement.headers.find((header) => header.key === "Cookie")?.value;
	return headers.flatMap((header) => {
		if (header.key !== "Cookie") {
			return requirement.headers.some((credential) => credential.key === header.key)
				? []
				: [header];
		}
		if (credentialCookie === undefined) return [header];
		const rest = header.value
			.split("; ")
			.filter((pair) => !credentialCookie.split("; ").includes(pair))
			.join("; ");
		return rest === "" ? [] : [{ ...header, value: rest }];
	});
}
