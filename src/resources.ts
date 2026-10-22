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
import {
	type HttpOperation,
	type HttpOperationPathParameter,
	type HttpOperationResponse,
	type MetadataInfo,
	Visibility,
} from "@typespec/http";
import { reportDiagnostic } from "./lib.js";
import { camelCase, spokenName } from "./names.js";
import { splitTemplate, type UriTemplateParameter } from "./uri.js";

/**
 * **The chaining convention.** Which operations create a resource, which later requests need its id,
 * and what each operation is FOR, read from structure alone: status codes, headers, body models and
 * routes. No annotation is consulted, so a spec that knows nothing about Postman chains correctly.
 *
 * One anchor carries every rule: a resource's **collection path**, the route it is created on, or
 * the route its item is read from where nothing creates it.
 */

/**
 * Where a creating operation states the id it created.
 *
 * `body` is the resource's own representation, which is where a create that answers with the resource
 * puts it. `location` is the `Location` header, which **RFC 9110 9.3.1 defines as the identifier of
 * the resource the 201 created** - the answer for a body that wraps the resource, carries it beside
 * something else, or is not the resource at all. Nothing else is guessed at: those are the two places
 * HTTP puts a created identifier.
 */
export interface Creator {
	readonly operation: HttpOperation;
	readonly from: "body" | "location";
	/** Whether the 201 declares a `Location` at all, which is what makes it checkable. */
	readonly located: boolean;
}

export interface Resource {
	readonly model: Model;
	/** How assertion names speak of it: `BookReview` -> `book review`. */
	readonly spoken: string;
	/** Path segments with parameter names erased, as `authors/{}`. */
	readonly collection: readonly string[];
	readonly variable: string;
	readonly key: ModelProperty;
	/** The key's JSON name. */
	readonly keyWire: string;
	readonly keyType: "string" | "number";
	/**
	 * **Empty is meaningful**: no operation in the service creates this resource, so its id cannot be
	 * derived from a run and has to be supplied to one.
	 */
	readonly creators: Creator[];
	/** The operation the resource was first read from, for a message that has to name it. */
	readonly declaredBy: HttpOperation;
}

export type Role =
	| {
			readonly kind: "create";
			readonly resource: Resource;
			readonly from: "body" | "location";
			readonly located: boolean;
	  }
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

/**
 * A response body as the model the document names. **`@typespec/http` resolves a body whose model
 * carries a property invisible at Read to an anonymous copy**, and `@typespec/openapi3` publishes
 * that copy as the named model through `getEffectivePayloadType`; comparing the copy by identity
 * lost every role of a resource with a write-only property.
 */
function responseType(metadata: MetadataInfo, type: Type): Type {
	return metadata.getEffectivePayloadType(type, Visibility.Read);
}

/** The JSON body types an operation's 2xx arms return, as the models the document names. */
function successBodies(metadata: MetadataInfo, operation: HttpOperation): Type[] {
	return successResponses(operation).flatMap((response) =>
		response.responses.flatMap((content) =>
			content.body?.bodyKind === "single" &&
			(content.body.contentTypes.length === 0 ||
				content.body.contentTypes.some((type) => JSON_MEDIA.test(type)))
				? [responseType(metadata, content.body.type)]
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

export function deriveChains(
	program: Program,
	metadata: MetadataInfo,
	operations: readonly HttpOperation[],
): Chains {
	const shapes = new Map<HttpOperation, Shape>(
		operations.map((operation) => [operation, shapeOf(operation)]),
	);
	const shape = (operation: HttpOperation): Shape => shapes.get(operation) ?? shapeOf(operation);
	const resources: Resource[] = [];
	const creatorOf = new Map<HttpOperation, Creator>();

	/**
	 * **What a create answers with.** 201 is what RFC 9110 9.3.3 asks a POST that creates to send, and
	 * plenty of real services answer 200 with the resource, or 202 with it while the work finishes. So
	 * for a POST the status is not what makes it a create: the verb, the route and a body carrying the
	 * resource's key are.
	 *
	 * **A PUT is the other way round, and RFC 9110 9.3.4 says so:** a PUT at the target URI sends 201
	 * when it created the resource and 200 or 204 when it replaced one that was already there. The
	 * status is the only thing that tells those apart, so a PUT creates only where it answers 201.
	 */
	const creations = (operation: HttpOperation) => {
		if (operation.verb === "post") {
			return successResponses(operation).flatMap((response) => response.responses);
		}
		if (operation.verb !== "put") return [];
		return operation.responses
			.filter((response) => response.statusCodes === 201)
			.flatMap((response) => response.responses);
	};

	/**
	 * **A 201 that answers with a `Location`, and only a 201.** RFC 9110 15.3.2 asks a 201 for one and
	 * 9.3.1 makes it the identifier of what was created, so it is the id's source where the body
	 * carries none and a checkable claim where the body carries one. **No other status says that.** A
	 * 202's `Location` conventionally names a status endpoint rather than the resource, so asserting
	 * it resolved to the resource's own route would fail a correct service; those keep the presence
	 * check the response contract gives any required header.
	 */
	const locatedCreations = (operation: HttpOperation) =>
		operation.responses
			.filter((response) => response.statusCodes === 201)
			.flatMap((response) => response.responses)
			.filter((content) =>
				Object.keys(content.headers ?? {}).some((name) => name.toLowerCase() === "location"),
			);

	const located = (operation: HttpOperation) => locatedCreations(operation).length !== 0;

	/**
	 * **A PUT-create names the new id in its own route**; the collection is the route without it.
	 * Only a PUT: RFC 9110 9.3.4 creates a PUT's resource AT the target URI, while 9.3.3 creates a
	 * POST's resource subordinate to it, so a POST's trailing parameter is the parent it consumes.
	 */
	const collectionOf = (operation: HttpOperation, key: ModelProperty): string[] | undefined => {
		const own = shape(operation);
		let normal = [...own.normal];
		const last = operation.verb === "put" ? own.parameters.at(-1) : undefined;
		if (last !== undefined) {
			const parameter = pathParameter(operation, last.name);
			if (parameter !== undefined && sameValueType(program, parameter.param, key))
				normal = normal.slice(0, -1);
		}
		if (normal.length === 0 || normal.at(-1) === "{}" || normal.at(-1) === "?") return undefined;
		return normal;
	};

	/** Declare a resource, or return the one already standing for the same model at the same route. */
	const declare = (
		model: Model,
		key: ModelProperty,
		collection: readonly string[],
		operation: HttpOperation,
	): Resource | undefined => {
		const existing = resources.find(
			(resource) =>
				resource.model === model && resource.collection.join("/") === collection.join("/"),
		);
		if (existing !== undefined) return existing;
		const name = modelName(program, model);
		if (name === undefined) {
			reportDiagnostic(program, {
				code: "unnamed-resource",
				format: { operation: operation.operation.name },
				target: operation.operation,
			});
			return undefined;
		}
		const keyWire = resolveEncodedName(program, key, "application/json");
		// Named for the resource and its key: `authorId`, or `projectSlug` for `@key slug`.
		const variable = camelCase(`${name} ${keyWire}`);
		const clash = resources.find((resource) => resource.variable === variable);
		if (clash !== undefined) {
			reportDiagnostic(program, {
				code: "variable-collision",
				format: {
					variable,
					first: describeResource(clash),
					second: `the resource created by '${qualifiedName(operation)}'`,
				},
				target: operation.operation,
			});
			return undefined;
		}
		const resource: Resource = {
			model,
			spoken: spokenName(name),
			collection: [...collection],
			variable,
			key,
			keyWire,
			keyType: jsonTypeOf(program, key),
			creators: [],
			declaredBy: operation,
		};
		resources.push(resource);
		return resource;
	};

	const addCreator = (resource: Resource, operation: HttpOperation, from: "body" | "location") => {
		const creator: Creator = { operation, from, located: located(operation) };
		resource.creators.push(creator);
		creatorOf.set(operation, creator);
	};

	/**
	 * **Pass 1: a create that answers with the resource itself.** The id is in the body, which is the
	 * most direct statement of it there is, so it is preferred over the header wherever it exists.
	 */
	for (const operation of operations) {
		for (const content of creations(operation)) {
			const body = content.body;
			if (body?.bodyKind !== "single") continue;
			const model = responseType(metadata, body.type);
			if (model.kind !== "Model") continue;
			if (!body.contentTypes.every((type) => JSON_MEDIA.test(type))) continue;
			const key = keyOf(program, model);
			if (key === undefined) continue;
			const collection = collectionOf(operation, key);
			if (collection === undefined) continue;
			const resource = declare(model, key, collection, operation);
			if (resource !== undefined) addCreator(resource, operation, "body");
		}
	}

	/**
	 * **Pass 2: a resource its item route defines.** An operation answering the model at
	 * `<collection>/{id}` states the resource, its key and the shape of its id just as completely as a
	 * create does - and it is the only statement there is when nothing creates one.
	 */
	for (const operation of operations) {
		if (operation.verb !== "get") continue;
		const own = shape(operation);
		if (own.normal.length < 2 || own.normal.at(-1) !== "{}") continue;
		const template = own.parameters.at(-1);
		if (template === undefined) continue;
		const parameter = pathParameter(operation, template.name);
		if (parameter === undefined) continue;
		const collection = own.normal.slice(0, -1);
		if (collection.includes("?")) continue;
		for (const type of successBodies(metadata, operation)) {
			if (type.kind !== "Model") continue;
			const key = keyOf(program, type);
			if (key === undefined) continue;
			if (!sameValueType(program, parameter.param, key)) continue;
			/**
			 * **One resource per collection path.** A second model answering at the same item route is
			 * another view of the same thing - a detail representation beside the summary one - not a
			 * second resource. Declaring one gave it a variable of its own that no request ever used.
			 */
			if (resources.some((resource) => resource.collection.join("/") === collection.join("/"))) {
				continue;
			}
			declare(type, key, collection, operation);
		}
	}

	/**
	 * **Pass 3: a create whose body does not carry the id.** RFC 9110 9.3.1 already says where it is,
	 * and the resource's own item route says what it looks like, so nothing about the body's shape
	 * needs guessing at. A create with no resource to match against is reported rather than dropped.
	 */
	for (const operation of operations) {
		const keyless = locatedCreations(operation);
		if (keyless.length === 0 || creatorOf.has(operation)) continue;
		/**
		 * A create whose body DOES carry a key is pass 1's, and pass 1 declining it was a statement
		 * about its route, not about the body. Only a body with no key of its own reaches here.
		 */
		const keyed = keyless.some((content) => {
			const body = content.body;
			if (body?.bodyKind !== "single") return false;
			const model = responseType(metadata, body.type);
			return model.kind === "Model" && keyOf(program, model) !== undefined;
		});
		if (keyed) continue;
		const own = shape(operation);
		const under = resources.find(
			(resource) => resource.collection.join("/") === own.normal.join("/"),
		);
		const named =
			under ??
			resources.find((resource) => {
				// Only a PUT names the id it creates; a POST's trailing id is the parent it creates under.
				if (operation.verb !== "put" || own.normal.at(-1) !== "{}") return false;
				if (resource.collection.join("/") !== own.normal.slice(0, -1).join("/")) return false;
				const template = own.parameters.at(-1);
				const parameter =
					template === undefined ? undefined : pathParameter(operation, template.name);
				return parameter !== undefined && sameValueType(program, parameter.param, resource.key);
			});
		if (named === undefined) {
			reportDiagnostic(program, {
				code: "keyless-create",
				format: { operation: operation.operation.name },
				target: operation.operation,
			});
			continue;
		}
		addCreator(named, operation, "location");
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
				creatorResource(created)?.collection.length === index
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

	const creatorResource = (creator: Creator | undefined): Resource | undefined =>
		creator === undefined
			? undefined
			: resources.find((resource) => resource.creators.includes(creator));

	const itemRoute = (operation: HttpOperation, resource: Resource): boolean => {
		const own = shape(operation);
		if (own.normal.length !== resource.collection.length + 1) return false;
		if (own.normal.slice(0, -1).join("/") !== resource.collection.join("/")) return false;
		const last = own.parameters.at(-1);
		return last !== undefined && consumptionOf(operation).get(last.name)?.resource === resource;
	};

	/**
	 * **What the item route answers is the resource, or a view of it.** Comparing by model identity
	 * lost the read whenever a detail representation was returned beside the one the create takes -
	 * and with it the check that the read returned what was asked for, and the not-found case, which
	 * are both about the id rather than about the shape. A model carrying a key of the same kind at
	 * the resource's own item route is that resource however it is spelled.
	 */
	const returns = (operation: HttpOperation, resource: Resource) =>
		successBodies(metadata, operation).some((type) => {
			if (type === resource.model) return true;
			if (type.kind !== "Model") return false;
			const key = keyOf(program, type);
			return key !== undefined && sameValueType(program, key, resource.key);
		});

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
			const createdResource = creatorResource(created);
			if (created !== undefined && createdResource !== undefined)
				roles.push({
					kind: "create",
					resource: createdResource,
					from: created.from,
					located: created.located,
				});
			for (const resource of resources) {
				if (resource === createdResource) continue;
				const own = shape(operation);
				if (operation.verb === "get" && own.normal.join("/") === resource.collection.join("/")) {
					const items = listItems(program, metadata, operation, resource.model);
					if (items !== undefined) roles.push({ kind: "list", resource, items });
					continue;
				}
				if (!itemRoute(operation, resource)) continue;
				if (operation.verb === "get" && returns(operation, resource))
					roles.push({ kind: "read", resource });
				else if (
					(operation.verb === "patch" || operation.verb === "put") &&
					returns(operation, resource)
				) {
					roles.push({ kind: "update", resource });
				} else if (operation.verb === "delete") roles.push({ kind: "delete", resource });
			}
			return roles;
		},
	};
}

/** How a collision names a resource already holding a variable, created or supplied. */
function describeResource(resource: Resource): string {
	const first = resource.creators[0];
	return first === undefined
		? `the ${resource.spoken} read by '${qualifiedName(resource.declaredBy)}'`
		: `the resource created by '${qualifiedName(first.operation)}'`;
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
	metadata: MetadataInfo,
	operation: HttpOperation,
	model: Model,
): readonly string[] | undefined {
	for (const body of successBodies(metadata, operation)) {
		if (arrayOf(body, model)) return [];
	}
	const [paging] = getPagingOperation(program, operation.operation);
	const pageItems = paging?.output.pageItems;
	if (pageItems !== undefined && arrayOf(pageItems.property.type, model)) {
		return pageItems.path.map((property) =>
			resolveEncodedName(program, property, "application/json"),
		);
	}
	for (const body of successBodies(metadata, operation)) {
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
