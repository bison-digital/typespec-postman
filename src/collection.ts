import {
	getDoc,
	getNamespaceFullName,
	getService,
	type Interface,
	type Namespace,
	type Program,
} from "@typespec/compiler";
import { createMetadataInfo, type HttpService, Visibility } from "@typespec/http";
import { type AuthDerivation, deriveAuth, type Requirement, sameSetting } from "./auth.js";
import { deriveAssertions } from "./assertions.js";
import { reportDiagnostic } from "./lib.js";
import type { AuthSetting, CollectionPlan, PlanNode, PlanVariable } from "./model.js";
import { type OrderedNode, orderRequests } from "./order.js";
import { deriveRequest } from "./requests.js";
import { deriveChains } from "./resources.js";
import { deriveServerVariables } from "./servers.js";
import type { ValueContext } from "./values.js";

export interface CollectionOptions {
	readonly collectionAuth: boolean;
}

/**
 * One service as a collection plan: every derivation, in the order each depends on the last.
 */
export function deriveCollection(
	program: Program,
	service: HttpService,
	options: CollectionOptions,
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
	};
	const operations = service.operations;
	const auth = deriveAuth(program, service);
	const chains = deriveChains(program, context.metadata, operations);
	const tree = orderRequests(program, namespace, operations, chains);

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
		const operation = node.operation;
		const requirement = auth.forOperation(operation);
		const request = deriveRequest(context, operation, chains, requirement);
		return {
			kind: "request",
			identity: `${fullName}/${operation.verb} ${operation.uriTemplate}/${operation.operation.name}`,
			name: request.name,
			description: request.description,
			method: request.method,
			url: request.url,
			headers: request.headers,
			body: request.body,
			auth: sameSetting(requirement.setting, inherited) ? undefined : requirement.setting,
			assertions: deriveAssertions(context, operation, chains.roles(operation), request.sent),
		};
	};

	const items = tree.map((node) => build(node, collectionAuth));

	return {
		name: getService(program, namespace)?.title ?? namespace.name,
		description: getDoc(program, namespace),
		identity: fullName,
		auth: collectionAuth,
		variables: variables(program, namespace, auth, chains.resources),
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
		claim(
			{
				key: resource.variable,
				value: "",
				description: `The ${resource.keyWire} of the ${resource.spoken} most recently created in this run.`,
			},
			`the ${resource.spoken} resource id`,
		);
	}
	return out;
}
