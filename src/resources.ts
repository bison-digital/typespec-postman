import {
	getEncode,
	getFormat,
	getFriendlyName,
	getPagingOperation,
	isArrayModelType,
	isKey,
	isTemplateInstance,
	type Model,
	type ModelProperty,
	type Program,
	resolveEncodedName,
	type Type,
} from "@typespec/compiler";
import { $ } from "@typespec/compiler/typekit";
import type {
	HttpOperation,
	HttpOperationPathParameter,
	HttpOperationResponse,
} from "@typespec/http";
import { reportDiagnostic } from "./lib.js";
import { camelCase, spokenName } from "./names.js";
import { splitTemplate, type UriTemplateParameter } from "./uri.js";

/**
 * **The chaining convention.** Which operations create a resource, which later requests need its id,
 * and what each operation is FOR, read from structure alone: status codes, headers, body models and
 * routes. No annotation is consulted, so a spec that knows nothing about Postman chains correctly.
 *
 * One anchor carries every rule: a resource's **collection path**, the route it is created on.
 */

export interface Resource {
	readonly model: Model;
	/** How assertion names speak of it: `Organization` -> `organization`. */
	readonly spoken: string;
	/** Path segments with parameter names erased, as `authors/{}`. */
	readonly collection: readonly string[];
	readonly variable: string;
	readonly key: ModelProperty;
	/** The key's JSON name. */
	readonly keyWire: string;
	readonly keyType: "string" | "number";
	readonly creators: HttpOperation[];
}

export type Role =
	| { readonly kind: "create"; readonly resource: Resource }
	| { readonly kind: "list"; readonly resource: Resource; readonly items: readonly string[] }
	| { readonly kind: "read"; readonly resource: Resource }
	| { readonly kind: "update"; readonly resource: Resource }
	| { readonly kind: "delete"; readonly resource: Resource };

export interface Chains {
	readonly resources: readonly Resource[];
	/** The resource whose variable a path parameter is filled from, if any. */
	consumed(operation: HttpOperation, parameter: string): Resource | undefined;
	/** Every resource an operation consumes, by any rule. */
	consumes(operation: HttpOperation): readonly Resource[];
	/** Resources consumed by the parameter immediately after their collection path. */
	nestedUnder(operation: HttpOperation): readonly Resource[];
	roles(operation: HttpOperation): readonly Role[];
}

interface Shape {
	/** Normalised segments: a literal, `{}` for a whole-segment simple parameter, or `?` otherwise. */
	readonly normal: readonly string[];
	/** The whole-segment simple parameter at each index, where there is one. */
	readonly parameters: readonly (UriTemplateParameter | undefined)[];
}

function shapeOf(operation: HttpOperation): Shape {
	const { segments } = splitTemplate(operation.uriTemplate);
	const normal: string[] = [];
	const parameters: (UriTemplateParameter | undefined)[] = [];
	for (const segment of segments) {
		const [only] = segment;
		if (segment.length === 1 && typeof only === "string") {
			normal.push(only);
			parameters.push(undefined);
		} else if (
			segment.length === 1 &&
			only !== undefined &&
			typeof only !== "string" &&
			only.operator === undefined
		) {
			normal.push("{}");
			parameters.push(only);
		} else {
			normal.push("?");
			parameters.push(undefined);
		}
	}
	return { normal, parameters };
}

function successResponses(operation: HttpOperation): HttpOperationResponse[] {
	return operation.responses.filter((response) => {
		const codes = response.statusCodes;
		if (codes === "*") return false;
		if (typeof codes === "number") return codes >= 200 && codes <= 299;
		return codes.start >= 200 && codes.end <= 299;
	});
}

const JSON_MEDIA = /^application\/(?:[\w.+-]+\+)?json$/i;

/** The JSON body types an operation's 2xx arms return. */
function successBodies(operation: HttpOperation): Type[] {
	return successResponses(operation).flatMap((response) =>
		response.responses.flatMap((content) =>
			content.body?.bodyKind === "single" &&
			(content.body.contentTypes.length === 0 ||
				content.body.contentTypes.some((type) => JSON_MEDIA.test(type)))
				? [content.body.type]
				: [],
		),
	);
}

/** The key property of a model: `@key` if declared anywhere up its chain, otherwise a JSON `id`. */
function keyOf(program: Program, model: Model): ModelProperty | undefined {
	const chain: Model[] = [];
	for (let current: Model | undefined = model; current !== undefined; current = current.baseModel) {
		chain.push(current);
	}
	for (const current of chain) {
		for (const property of current.properties.values())
			if (isKey(program, property)) return property;
	}
	for (const current of chain) {
		for (const property of current.properties.values()) {
			if (resolveEncodedName(program, property, "application/json") === "id") return property;
		}
	}
	return undefined;
}

/** How a key is spelled in JSON: a number stays a number unless it is encoded as a string. */
function jsonTypeOf(program: Program, property: ModelProperty): "string" | "number" {
	const type = property.type;
	if (type.kind !== "Scalar") return "string";
	const encoded = getEncode(program, property) ?? getEncode(program, type);
	if (encoded?.type.name === "string") return "string";
	const std = $(program).scalar.getStdBase(type);
	return std !== null && $(program).scalar.extendsNumeric(std) ? "number" : "string";
}

/**
 * Two properties carry the same kind of value: the same type, or the same scalar with the same
 * format and encoding. **This is what stops a uuid id being fed into a `{slug}` parameter** that
 * happens to follow the same collection path.
 */
function sameValueType(program: Program, a: ModelProperty, b: ModelProperty): boolean {
	if (a.type !== b.type) {
		if (a.type.kind !== "Scalar" || b.type.kind !== "Scalar") return false;
		const tk = $(program).scalar;
		if (tk.getStdBase(a.type) !== tk.getStdBase(b.type)) return false;
	}
	const format = (property: ModelProperty) =>
		getFormat(program, property) ??
		(property.type.kind === "Scalar" ? getFormat(program, property.type) : undefined);
	const encoding = (property: ModelProperty) => getEncode(program, property)?.encoding;
	return format(a) === format(b) && encoding(a) === encoding(b);
}

function modelName(program: Program, model: Model): string | undefined {
	if (isTemplateInstance(model)) return getFriendlyName(program, model);
	return model.name === "" ? undefined : model.name;
}

export function deriveChains(program: Program, operations: readonly HttpOperation[]): Chains {
	const shapes = new Map<HttpOperation, Shape>(
		operations.map((operation) => [operation, shapeOf(operation)]),
	);
	const shape = (operation: HttpOperation): Shape => shapes.get(operation) ?? shapeOf(operation);
	const resources: Resource[] = [];
	const creatorOf = new Map<HttpOperation, Resource>();

	for (const operation of operations) {
		for (const response of operation.responses) {
			if (response.statusCodes !== 201) continue;
			for (const content of response.responses) {
				const hasLocation = Object.keys(content.headers ?? {}).some(
					(name) => name.toLowerCase() === "location",
				);
				const body = content.body;
				if (!hasLocation || body?.bodyKind !== "single" || body.type.kind !== "Model") continue;
				if (!body.contentTypes.every((type) => JSON_MEDIA.test(type))) continue;
				const model = body.type;
				const key = keyOf(program, model);
				if (key === undefined) continue;
				const name = modelName(program, model);
				if (name === undefined) {
					reportDiagnostic(program, {
						code: "unnamed-resource",
						format: { operation: operation.operation.name },
						target: operation.operation,
					});
					continue;
				}
				const own = shape(operation);
				let normal = [...own.normal];
				// A PUT-create names the new id in its own route; the collection is the route without it.
				const last = own.parameters.at(-1);
				if (last !== undefined) {
					const parameter = pathParameter(operation, last.name);
					if (parameter !== undefined && sameValueType(program, parameter.param, key))
						normal = normal.slice(0, -1);
				}
				if (normal.length === 0 || normal.at(-1) === "{}" || normal.at(-1) === "?") continue;
				const keyWire = resolveEncodedName(program, key, "application/json");
				// Named for the resource and its key: `organizationId`, or `projectSlug` for `@key slug`.
				const variable = camelCase(`${name} ${keyWire}`);
				const existing = resources.find(
					(resource) =>
						resource.model === model && resource.collection.join("/") === normal.join("/"),
				);
				if (existing !== undefined) {
					existing.creators.push(operation);
					creatorOf.set(operation, existing);
					continue;
				}
				const clash = resources.find((resource) => resource.variable === variable);
				if (clash !== undefined) {
					reportDiagnostic(program, {
						code: "variable-collision",
						format: {
							variable,
							first: `the resource created by '${qualifiedName(clash.creators[0])}'`,
							second: `the resource created by '${qualifiedName(operation)}'`,
						},
						target: operation.operation,
					});
					continue;
				}
				const resource: Resource = {
					model,
					spoken: spokenName(name),
					collection: normal,
					variable,
					key,
					keyWire,
					keyType: jsonTypeOf(program, key),
					creators: [operation],
				};
				resources.push(resource);
				creatorOf.set(operation, resource);
			}
		}
	}

	const consumption = new Map<
		HttpOperation,
		Map<string, { resource: Resource; nested: boolean }>
	>();
	const consumptionOf = (operation: HttpOperation) => {
		let found = consumption.get(operation);
		if (found !== undefined) return found;
		found = new Map();
		const own = shape(operation);
		own.parameters.forEach((template, index) => {
			if (template === undefined) return;
			const parameter = pathParameter(operation, template.name);
			if (parameter === undefined) return;
			// A PUT-create's own trailing id is what it creates, never something it consumes.
			const created = creatorOf.get(operation);
			if (
				created !== undefined &&
				index === own.parameters.length - 1 &&
				created.collection.length === index
			)
				return;
			const prefix = own.normal.slice(0, index).join("/");
			const byPosition = resources.find(
				(resource) =>
					resource.collection.join("/") === prefix &&
					sameValueType(program, parameter.param, resource.key),
			);
			const byName = resources.find(
				(resource) =>
					template.name === resource.variable &&
					sameValueType(program, parameter.param, resource.key),
			);
			const chosen = byPosition ?? byName;
			if (chosen !== undefined)
				found?.set(template.name, { resource: chosen, nested: byPosition !== undefined });
		});
		consumption.set(operation, found);
		return found;
	};

	const itemRoute = (operation: HttpOperation, resource: Resource): boolean => {
		const own = shape(operation);
		if (own.normal.length !== resource.collection.length + 1) return false;
		if (own.normal.slice(0, -1).join("/") !== resource.collection.join("/")) return false;
		const last = own.parameters.at(-1);
		return last !== undefined && consumptionOf(operation).get(last.name)?.resource === resource;
	};

	const returns = (operation: HttpOperation, model: Model) =>
		successBodies(operation).some((type) => type === model);

	return {
		resources,
		consumed: (operation, parameter) => consumptionOf(operation).get(parameter)?.resource,
		consumes: (operation) => [
			...new Set([...consumptionOf(operation).values()].map((entry) => entry.resource)),
		],
		nestedUnder: (operation) =>
			[...consumptionOf(operation).values()]
				.filter((entry) => entry.nested)
				.map((entry) => entry.resource),
		roles(operation) {
			const roles: Role[] = [];
			const created = creatorOf.get(operation);
			if (created !== undefined) roles.push({ kind: "create", resource: created });
			for (const resource of resources) {
				if (resource === created) continue;
				const own = shape(operation);
				if (operation.verb === "get" && own.normal.join("/") === resource.collection.join("/")) {
					const items = listItems(program, operation, resource.model);
					if (items !== undefined) roles.push({ kind: "list", resource, items });
					continue;
				}
				if (!itemRoute(operation, resource)) continue;
				if (operation.verb === "get" && returns(operation, resource.model))
					roles.push({ kind: "read", resource });
				else if (
					(operation.verb === "patch" || operation.verb === "put") &&
					returns(operation, resource.model)
				) {
					roles.push({ kind: "update", resource });
				} else if (operation.verb === "delete") roles.push({ kind: "delete", resource });
			}
			return roles;
		},
	};
}

/** `Store.create`: an operation named with its container, so two `create`s can be told apart. */
function qualifiedName(operation: HttpOperation | undefined): string {
	return operation === undefined ? "" : `${operation.container.name}.${operation.operation.name}`;
}

function pathParameter(
	operation: HttpOperation,
	name: string,
): HttpOperationPathParameter | undefined {
	return operation.parameters.parameters.find(
		(parameter): parameter is HttpOperationPathParameter =>
			parameter.type === "path" && parameter.name === name,
	);
}

/** Is `type` an array whose element is `model`? */
function arrayOf(type: Type, model: Model): boolean {
	return type.kind === "Model" && isArrayModelType(type) && type.indexer.value === model;
}

/**
 * Where a list operation's items are, as a path into its JSON body: `[]` for a bare array, the
 * `@pageItems` path when the operation is paged, or the one property typed as an array of the
 * resource. Undefined when the body is none of those.
 */
function listItems(
	program: Program,
	operation: HttpOperation,
	model: Model,
): readonly string[] | undefined {
	for (const body of successBodies(operation)) {
		if (arrayOf(body, model)) return [];
	}
	const [paging] = getPagingOperation(program, operation.operation);
	const pageItems = paging?.output.pageItems;
	if (pageItems !== undefined && arrayOf(pageItems.property.type, model)) {
		return pageItems.path.map((property) =>
			resolveEncodedName(program, property, "application/json"),
		);
	}
	for (const body of successBodies(operation)) {
		if (body.kind !== "Model" || isArrayModelType(body)) continue;
		const arrays = [...body.properties.values()].filter((property) =>
			arrayOf(property.type, model),
		);
		const [only] = arrays;
		if (arrays.length === 1 && only !== undefined)
			return [resolveEncodedName(program, only, "application/json")];
	}
	return undefined;
}
