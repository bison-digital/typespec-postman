import {
	getDoc,
	getNamespaceFullName,
	getService,
	type Interface,
	type Namespace,
	type Program,
} from "@typespec/compiler";
import {
	createMetadataInfo,
	type HttpOperation,
	type HttpService,
	Visibility,
} from "@typespec/http";
import { type AuthDerivation, deriveAuth, type Requirement, sameSetting } from "./auth.js";
import { deriveAssertions } from "./assertions.js";
import { reportDiagnostic } from "./lib.js";
import type {
	AuthSetting,
	CollectionPlan,
	PlanFolder,
	PlanGuard,
	PlanNode,
	PlanRequest,
	PlanVariable,
} from "./model.js";
import { inDeclarationOrder, type OrderedNode, orderRequests } from "./order.js";
import { deriveErrorCases } from "./errors.js";
import { type GraphQLRequest, type GraphQLUrl, operationKey, variablesText } from "./graphql.js";
import { type DerivedRequest, deriveRequest } from "./requests.js";
import { deriveChains, type Resource } from "./resources.js";
import type { ResponseSchemas } from "./schemas.js";
import { deriveServerVariables } from "./servers.js";
import { publishesOpenApi30Only } from "./openapi-versions.js";
import { isReadOnlyProperty, parameterValue, type ValueContext } from "./values.js";

export interface CollectionOptions {
	readonly collectionAuth: boolean;
	/** The service's GraphQL surface, where typespec-http-graphql served one in this compile. */
	readonly graphql?: {
		readonly requests: readonly GraphQLRequest[];
		readonly url: GraphQLUrl;
	};
}

/**
 * One service as a collection plan: every derivation, in the order each depends on the last.
 */
export function deriveCollection(
	program: Program,
	service: HttpService,
	options: CollectionOptions,
	schemas: ResponseSchemas,
): CollectionPlan {
	const namespace = service.namespace;
	const fullName = getNamespaceFullName(namespace);
	/**
	 * **Created here, per compile, and never cached at module level.** `createMetadataInfo` closes
	 * over one program's types; a module-level instance would carry one compile's answers into the
	 * next.
	 */
	const context: ValueContext = {
		program,
		metadata: createMetadataInfo(program, { canonicalVisibility: Visibility.Read }),
		shared: createMetadataInfo(program, {
			canonicalVisibility: Visibility.Read,
			canShareProperty: (property) => isReadOnlyProperty(program, property),
		}),
		readOnlyRequired: !publishesOpenApi30Only(program),
	};
	const operations = inDeclarationOrder(program, service.operations);
	const auth = deriveAuth(program, service);
	const chains = deriveChains(program, context.metadata, operations);
	const tree = orderRequests(program, namespace, operations, chains);

	/**
	 * The value a request carries for a resource nothing creates: **the one the emitter would have
	 * sent anyway**, so the URL is the shape the spec describes and reaches the route it names. An
	 * empty variable would send `/archives/`, which is a different route and can answer a list.
	 */
	const supplied = (resource: Resource) => String(parameterValue(context, resource.key));
	const guardFor = (operation: HttpOperation): PlanGuard | undefined => {
		const needs = chains
			.consumes(operation)
			.filter((resource) => resource.creators.length === 0)
			.map((resource) => ({ variable: resource.variable, value: supplied(resource) }));
		return needs.length === 0 ? undefined : { needs };
	};

	const collectionAuth = options.collectionAuth ? auth.service?.setting : undefined;

	const containerRequirement = (container: Interface | Namespace): Requirement | undefined => {
		for (
			let current: Interface | Namespace | undefined = container;
			current !== undefined;
			current = current.namespace
		) {
			if (current === namespace) return auth.service;
			const declared = auth.declaredOn(current);
			if (declared !== undefined) return declared;
		}
		return auth.service;
	};

	/**
	 * **Each operation's request derived once**, however many times the collection sends it: a REST
	 * request, its copy among the GraphQL requests, and the values its GraphQL request sends. Deriving
	 * it again would report its diagnostics again.
	 */
	const derived = new Map<HttpOperation, DerivedRequest>();
	const requestOf = (operation: HttpOperation, requirement: Requirement): DerivedRequest => {
		let request = derived.get(operation);
		if (request === undefined) {
			request = deriveRequest(context, operation, chains, requirement);
			derived.set(operation, request);
		}
		return request;
	};

	/** One operation's REST request, its auth relative to what the folder holding it inherits. */
	const restRequest = (
		operation: HttpOperation,
		inherited: AuthSetting | undefined,
		identity: string,
		name?: (request: DerivedRequest) => string,
	): PlanRequest => {
		const requirement = auth.forOperation(operation);
		const request = requestOf(operation, requirement);
		return {
			kind: "request",
			identity,
			name: name === undefined ? request.name : name(request),
			description: request.description,
			method: request.method,
			url: request.url,
			headers: request.headers,
			body: request.body,
			auth: sameSetting(requirement.setting, inherited) ? undefined : requirement.setting,
			assertions: deriveAssertions(
				context,
				operation,
				chains.roles(operation),
				request.sent,
				schemas,
				request.url.path,
			),
			guard: guardFor(operation),
		};
	};
	const restIdentity = (operation: HttpOperation) =>
		`${fullName}/${operation.verb} ${operation.uriTemplate}/${operation.operation.name}`;

	const build = (node: OrderedNode, inherited: AuthSetting | undefined): PlanNode => {
		if (node.kind === "folder") {
			const own = containerRequirement(node.container)?.setting;
			const differs = !sameSetting(own, inherited);
			const setting = differs ? (own ?? { kind: "none" }) : undefined;
			return {
				kind: "folder",
				identity: `${fullName}/${node.name}`,
				name: node.name,
				description: getDoc(program, node.container),
				auth: setting,
				items: node.children.map((child) => build(child, differs ? own : inherited)),
			};
		}
		return restRequest(node.operation, inherited, restIdentity(node.operation));
	};

	/**
	 * **The GraphQL requests, in a folder after the REST requests**: first a copy of each create the
	 * GraphQL requests' operations need, setting the ids they read, then one request per root field,
	 * in the order the REST request for its operation runs, so a delete still runs last. Without the
	 * copies every read would follow the REST deletes, and answer `null` for a resource already gone.
	 */
	const graphqlFolder = (): PlanFolder | undefined => {
		const surface = options.graphql;
		if (surface === undefined || surface.requests.length === 0) return undefined;
		const ordered: { readonly operation: HttpOperation; readonly folder: string }[] = [];
		const walk = (nodes: readonly OrderedNode[], folder: string) => {
			for (const node of nodes) {
				if (node.kind === "folder") walk(node.children, node.name);
				else ordered.push({ operation: node.operation, folder });
			}
		};
		walk(tree, namespace.name);
		const position = new Map(ordered.map((entry, index) => [entry.operation, index]));

		const byKey = new Map<string, HttpOperation[]>();
		for (const operation of operations) {
			const key = operationKey(operation);
			byKey.set(key, [...(byKey.get(key) ?? []), operation]);
		}
		const matched = surface.requests.map((request) => {
			const key = operationKey(request.operation);
			const found = byKey.get(key) ?? [];
			const [operation] = found;
			if (operation === undefined || found.length > 1) {
				throw new Error(
					`typespec-postman internal invariant: GraphQL field '${request.field}' calls '${key}', which ${found.length === 0 ? "no" : "more than one"} operation of the service is`,
				);
			}
			return { request, operation };
		});

		/** The creates of every resource the requests consume, and of every resource those consume. */
		const needed = new Set<HttpOperation>();
		const visit = (operation: HttpOperation) => {
			for (const resource of chains.consumes(operation)) {
				for (const creator of resource.creators) {
					if (needed.has(creator.operation)) continue;
					needed.add(creator.operation);
					visit(creator.operation);
				}
			}
		};
		for (const { operation } of matched) visit(operation);

		const copies = ordered
			.filter((entry) => needed.has(entry.operation))
			.map((entry) =>
				restRequest(
					entry.operation,
					collectionAuth,
					`${fullName}/graphql/${restIdentity(entry.operation)}`,
					(request) => `${request.name} (${entry.folder})`,
				),
			);
		const requests = matched
			.toSorted((a, b) => (position.get(a.operation) ?? 0) - (position.get(b.operation) ?? 0))
			.map(({ request, operation }): PlanRequest => {
				const requirement = auth.forOperation(operation);
				const rest = requestOf(operation, requirement);
				const { value } = request.variables({
					parameters: rest.values.parameters,
					...(rest.sent === undefined ? {} : { body: rest.sent.value }),
				});
				const cookie = requirement.headers.find((header) => header.key === "Cookie");
				return {
					kind: "request",
					identity: `${fullName}/graphql/${request.kind} ${request.field}`,
					name: `${request.kind} ${request.field}`,
					description: request.description,
					method: "POST",
					url: {
						...(surface.url.host === "{{baseUrl}}" ? {} : { host: surface.url.host }),
						path: surface.url.path,
						query: requirement.query,
						variables: [],
						hash: undefined,
					},
					headers: [
						{
							key: "Content-Type",
							value: "application/json",
							disabled: false,
							description: undefined,
						},
						{ key: "Accept", value: "application/json", disabled: false, description: undefined },
						...requirement.headers.filter((header) => header.key !== "Cookie"),
						...(cookie === undefined ? [] : [cookie]),
					],
					body: {
						mode: "graphql",
						query: request.document,
						variables: variablesText(value, rest.values.chained),
					},
					auth: sameSetting(requirement.setting, collectionAuth) ? undefined : requirement.setting,
					assertions: [
						{ kind: "graphql-success", field: request.field, typenames: request.successTypenames },
					],
					guard: guardFor(operation),
				};
			});
		return {
			kind: "folder",
			identity: `${fullName}/graphql`,
			name: "GraphQL",
			description:
				"The service's GraphQL surface: the creates its reads need, then a request for each root field.",
			auth: undefined,
			items: [...copies, ...requests],
		};
	};

	const errorCases = deriveErrorCases({
		context,
		operations,
		chains,
		auth,
		schemas,
		fullName,
		collectionAuth,
	});
	const rest = tree.map((node) => build(node, collectionAuth));
	const graphql = graphqlFolder();
	const items = [
		...rest,
		...(graphql === undefined ? [] : [graphql]),
		...(errorCases === undefined ? [] : [errorCases]),
	];

	return {
		name: getService(program, namespace)?.title ?? namespace.name,
		description: getDoc(program, namespace),
		identity: fullName,
		auth: collectionAuth,
		variables: variables(program, namespace, auth, chains.resources, supplied),
		credentials: auth.credentials.map((variable) => variable.key),
		items,
	};
}

/**
 * Server variables, then credentials, then chained ids. **A later claim on a name already taken is
 * reported, not renamed**: renaming would invent a variable no reader of the spec could predict.
 */
function variables(
	program: Program,
	namespace: Namespace,
	auth: AuthDerivation,
	resources: ReturnType<typeof deriveChains>["resources"],
	supplied: (resource: Resource) => string,
): PlanVariable[] {
	const claimed = new Map<string, string>();
	const out: PlanVariable[] = [];
	const claim = (variable: PlanVariable, owner: string) => {
		const first = claimed.get(variable.key);
		if (first !== undefined) {
			reportDiagnostic(program, {
				code: "variable-collision",
				format: { variable: variable.key, first, second: owner },
				target: namespace,
			});
			return;
		}
		claimed.set(variable.key, owner);
		out.push(variable);
	};
	for (const variable of deriveServerVariables(program, namespace))
		claim(variable, `server variable '${variable.key}'`);
	for (const variable of auth.credentials) claim(variable, `the credential '${variable.key}'`);
	for (const resource of resources) {
		const created = resource.creators.length !== 0;
		claim(
			{
				key: resource.variable,
				value: created ? "" : supplied(resource),
				description: created
					? `The ${resource.keyWire} of the ${resource.spoken} most recently created in this run.`
					: `The ${resource.keyWire} of the ${resource.spoken}. No operation creates one, so supply it to run the requests that read it.`,
			},
			`the ${resource.spoken} resource id`,
		);
	}
	return out;
}
