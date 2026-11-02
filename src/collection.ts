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
import {
	type GraphQLRequest,
	type GraphQLUrl,
	operationKey,
	variablesOf,
	variablesText,
} from "./graphql.js";
import { type DerivedRequest, deriveRequest } from "./requests.js";
import { deriveChains, qualifiedName, type Resource } from "./resources.js";
import type { ResponseSchemas } from "./schemas.js";
import { deriveServerVariables } from "./servers.js";
import { publishesOpenApi30Only } from "./openapi-versions.js";
import { isReadOnlyProperty, parameterValue, type ValueContext } from "./values.js";

/**
 * A create mutation that captures what it created: the resource, and its key's path for each success
 * member, `null` for a member that holds none, as a REST create answering 202 has no key to read.
 */
interface Capture {
	readonly resource: Resource;
	readonly paths: Readonly<Record<string, readonly string[] | null>>;
}

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
	 * **The GraphQL requests, in a folder after the REST requests**, each resource its requests use
	 * created once in it, then one request per root field, in an order of their own: each after what
	 * creates what it uses, a delete after every other use of what it deletes, ties in declaration
	 * order. The REST folders run as wholes and may have to give an edge up; this folder is flat and
	 * need not.
	 *
	 * **A resource is created by its create mutation where that answer says what it created**: a
	 * create whose REST answer carries the resource, as a GraphQL success member that selects its key,
	 * which typespec-http-graphql's `resultPathsOf` locates and the mutation's script reads into the
	 * variable the REST create sets. Every other resource a request uses is created by a copy of its
	 * REST create, without which a read would follow the REST deletes and answer `null`. A resource
	 * created by both, a mutation whose answer carries no key beside a copy of the same create, is
	 * reported, `graphql-create-duplicated`: the two send one example, which a server holding a
	 * field unique refuses the second time.
	 *
	 * **A create here sends the example the REST create already sent**, which a server holding a field
	 * unique accepts only once the REST folders have deleted what they created, as they do last. A
	 * resource no request deletes is reported, `graphql-create-repeated`.
	 */
	const graphqlFolder = (): PlanFolder | undefined => {
		// Apart from every folder of the spec: no name a TypeSpec declaration can take holds a NUL.
		const graphqlIdentity = `${fullName}\u0000graphql`;
		const surface = options.graphql;
		if (surface === undefined || surface.requests.length === 0) return undefined;
		const folderOf = new Map<HttpOperation, string>();
		/** Each operation's place in the REST folders' run. */
		const restOrder = new Map<HttpOperation, number>();
		const walk = (nodes: readonly OrderedNode[], folder: string) => {
			for (const node of nodes) {
				if (node.kind === "folder") walk(node.children, node.name);
				else {
					folderOf.set(node.operation, folder);
					restOrder.set(node.operation, restOrder.size);
				}
			}
		};
		walk(tree, namespace.name);

		const byKey = new Map<string, HttpOperation[]>();
		for (const operation of operations) {
			const key = operationKey(operation);
			byKey.set(key, [...(byKey.get(key) ?? []), operation]);
		}
		const matched = new Map(
			surface.requests.map((request) => {
				const key = operationKey(request.operation);
				const found = byKey.get(key) ?? [];
				const [operation] = found;
				if (operation === undefined || found.length > 1) {
					throw new Error(
						`typespec-postman internal invariant: GraphQL field '${request.field}' calls '${key}', which ${found.length === 0 ? "no" : "more than one"} operation of the service is`,
					);
				}
				return [operation, request] as const;
			}),
		);

		/** The resources an operation creates: more than one where its 2xx bodies are other models. */
		const createdBy = (operation: HttpOperation): readonly Resource[] =>
			chains.resources.filter((resource) =>
				resource.creators.some((creator) => creator.operation === operation),
			);

		/**
		 * Each create mutation whose answer says what it created: the resource, and where the key is for
		 * each success member. One member holding it is enough, as the REST create reads the key from
		 * whichever 2xx body it is answered and fails where that body has none. **Not a create that
		 * answers two resources**, a book or an import job, whose members both hold an `id`: a path
		 * cannot say which resource the id is of.
		 */
		const captures = new Map<HttpOperation, Capture>();
		for (const [operation, request] of matched) {
			if (request.kind !== "mutation" || createdBy(operation).length > 1) continue;
			for (const role of chains.roles(operation)) {
				if (role.kind !== "create" || role.from !== "body") continue;
				const paths = request.resultPathsOf([role.resource.keyWire]);
				const typenames = request.successTypenames ?? [...paths.keys()];
				if (typenames.some((typename) => paths.has(typename))) {
					captures.set(operation, {
						resource: role.resource,
						paths: Object.fromEntries(
							typenames.map((typename) => [typename, paths.get(typename) ?? null]),
						),
					});
				}
			}
		}
		const createdByMutation = new Set([...captures.values()].map((capture) => capture.resource));

		/** The creates to copy: of each resource a request uses that no mutation creates, and of theirs. */
		const copied = new Set<HttpOperation>();
		const visit = (operation: HttpOperation) => {
			for (const resource of chains.consumes(operation)) {
				if (createdByMutation.has(resource)) continue;
				for (const creator of resource.creators) {
					if (copied.has(creator.operation)) continue;
					copied.add(creator.operation);
					visit(creator.operation);
				}
			}
		};
		for (const operation of matched.keys()) visit(operation);

		const copyOf = (operation: HttpOperation): PlanRequest =>
			restRequest(
				operation,
				collectionAuth,
				`${graphqlIdentity}/${restIdentity(operation)}`,
				(request) => `${request.name} (${folderOf.get(operation) ?? namespace.name})`,
			);
		const graphqlRequestOf = (operation: HttpOperation, request: GraphQLRequest): PlanRequest => {
			const requirement = auth.forOperation(operation);
			const rest = requestOf(operation, requirement);
			const value = variablesOf(
				request,
				rest.values.parameters,
				rest.values.omitted,
				rest.sent === undefined ? {} : { body: rest.sent.value },
			);
			const cookie = requirement.headers.find((header) => header.key === "Cookie");
			const capture = captures.get(operation);
			return {
				kind: "request",
				identity: `${graphqlIdentity}/${request.kind} ${request.field}`,
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
					...(capture === undefined
						? []
						: [
								{
									kind: "graphql-captures" as const,
									key: capture.resource.keyWire,
									type: capture.resource.keyType,
									variable: capture.resource.variable,
									paths: capture.paths,
								},
							]),
				],
				guard: guardFor(operation),
			};
		};

		const deleted = new Set(
			operations.flatMap((operation) =>
				chains.roles(operation).flatMap((role) => (role.kind === "delete" ? [role.resource] : [])),
			),
		);
		/**
		 * **What the REST folders leave stored**: every resource no request deletes; and of one with
		 * more than one create, all but the last to run, since its variable holds the last one's id
		 * when the delete runs.
		 */
		const lastCreator = (resource: Resource): HttpOperation | undefined =>
			resource.creators
				.map((creator) => creator.operation)
				.reduce<HttpOperation | undefined>(
					(last, operation) =>
						last === undefined || (restOrder.get(operation) ?? -1) > (restOrder.get(last) ?? -1)
							? operation
							: last,
					undefined,
				);
		// Every create the folder sends: each copy, and each mutation calling a create, captured or not.
		for (const operation of new Set([...copied, ...matched.keys()])) {
			for (const created of createdBy(operation)) {
				const last = lastCreator(created);
				if (deleted.has(created) && last === operation) continue;
				reportDiagnostic(program, {
					code: "graphql-create-repeated",
					messageId: deleted.has(created) ? "kept" : "default",
					format: {
						resource: `${/^[aeiou]/i.test(created.spoken) ? "an" : "a"} ${created.spoken}`,
						operation: qualifiedName(operation),
						last: last === undefined ? "" : qualifiedName(last),
					},
					target: operation.operation,
				});
			}
		}

		for (const operation of copied) {
			const request = matched.get(operation);
			if (request === undefined) continue;
			const role = chains.roles(operation).find((candidate) => candidate.kind === "create");
			reportDiagnostic(program, {
				code: "graphql-create-duplicated",
				messageId: createdBy(operation).length > 1 ? "resources" : "default",
				format: {
					field: request.field,
					spoken: role?.resource.spoken ?? operation.operation.name,
					operation: qualifiedName(operation),
				},
				target: operation.operation,
			});
		}

		const items = orderRequests(
			program,
			namespace,
			[...new Set([...copied, ...matched.keys()])],
			chains,
			{ flat: true },
		).flatMap((node): PlanRequest[] => {
			if (node.kind !== "request") return [];
			const request = matched.get(node.operation);
			return [
				...(copied.has(node.operation) ? [copyOf(node.operation)] : []),
				...(request === undefined ? [] : [graphqlRequestOf(node.operation, request)]),
			];
		});
		return {
			kind: "folder",
			identity: graphqlIdentity,
			name: "GraphQL",
			description:
				"The service's GraphQL surface: each resource its requests use created once, by its create mutation where the answer carries the id and by a copy of the REST create where not, then a request for each root field.",
			auth: undefined,
			items,
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
