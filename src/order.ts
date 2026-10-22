import {
	getNamespaceFullName,
	getSourceLocation,
	type Interface,
	type Namespace,
	type Program,
} from "@typespec/compiler";
import type { HttpOperation } from "@typespec/http";
import { reportDiagnostic } from "./lib.js";
import type { Chains } from "./resources.js";

/**
 * Folders and the order requests run in.
 *
 * **Folders are the containers the spec author declared operations in**, interfaces or namespaces,
 * so the collection is grouped the way the spec is.
 *
 * **A folder nests inside the folder of the resource its routes sit under.** `Books` at
 * `/authors/{authorId}/books` sits inside `Authors`, after the author is created and before it is
 * deleted. Postman's own OpenAPI importer nests folders by path for the same reason, and it is the
 * only arrangement in which an ordinary parent-with-delete and a child interface can both run in
 * file order: folders run contiguously, so a flat `Authors` folder either deletes the author before
 * `Books` needs it or runs after `Books` needed it to exist.
 *
 * **Order is dependency order, ties broken by declaration order.** A request that consumes a
 * resource runs after a request that creates it; a request that deletes a resource runs after every
 * other request that uses it. Nothing else moves, so a spec with no chained resources keeps the
 * order its author wrote.
 */

export interface FolderNode {
	readonly kind: "folder";
	readonly container: Interface | Namespace;
	readonly name: string;
	readonly children: OrderedNode[];
}

export interface RequestNode {
	readonly kind: "request";
	readonly operation: HttpOperation;
}

export type OrderedNode = FolderNode | RequestNode;

interface Draft {
	readonly container: Interface | Namespace;
	readonly name: string;
	readonly operations: HttpOperation[];
	parent: Draft | undefined;
}

/**
 * `flat` orders the operations as one level, in no folder, as a folder of copies does: no folder then
 * makes an edge impossible, and any edge it gives up lies on a cycle the spec's own order reports.
 */
export function orderRequests(
	program: Program,
	serviceNamespace: Namespace,
	operations: readonly HttpOperation[],
	chains: Chains,
	options: { readonly flat?: boolean } = {},
): OrderedNode[] {
	const index = declarationOrder(program, operations);
	const serviceName = getNamespaceFullName(serviceNamespace);
	const drafts = new Map<Interface | Namespace, Draft>();
	const rootOperations: HttpOperation[] = [];

	for (const operation of operations) {
		const container = operation.container;
		if (options.flat === true || container === serviceNamespace) {
			rootOperations.push(operation);
			continue;
		}
		let draft = drafts.get(container);
		if (draft === undefined) {
			draft = {
				container,
				name: relativeName(container, serviceName),
				operations: [],
				parent: undefined,
			};
			drafts.set(container, draft);
		}
		draft.operations.push(operation);
	}

	const draftOf = (operation: HttpOperation): Draft | undefined => drafts.get(operation.container);

	for (const draft of drafts.values()) {
		const createdHere = new Set(
			chains.resources.filter((resource) =>
				resource.creators.some((creator) => draftOf(creator.operation) === draft),
			),
		);
		const parents = draft.operations
			.flatMap((operation) => chains.nestedUnder(operation))
			.filter((resource) => !createdHere.has(resource))
			.toSorted((a, b) => b.collection.length - a.collection.length);
		const [deepest] = parents;
		// A resource nothing creates has no folder to nest under, so there is nothing to move.
		const creator = deepest?.creators[0];
		const parent = creator === undefined ? undefined : draftOf(creator.operation);
		if (parent === undefined || parent === draft) continue;
		let ancestor: Draft | undefined = parent;
		let cyclic = false;
		while (ancestor !== undefined) {
			if (ancestor === draft) {
				cyclic = true;
				break;
			}
			ancestor = ancestor.parent;
		}
		if (!cyclic) draft.parent = parent;
	}

	const folderNodes = new Map<Draft, FolderNode>();
	for (const draft of drafts.values()) {
		folderNodes.set(draft, {
			kind: "folder",
			container: draft.container,
			name: draft.name,
			children: [],
		});
	}
	const requestNodes = new Map<HttpOperation, RequestNode>(
		operations.map((operation) => [operation, { kind: "request", operation }]),
	);
	const parentOf = new Map<OrderedNode, FolderNode | undefined>();
	const root: OrderedNode[] = [];
	for (const operation of rootOperations) {
		const node = requestNodes.get(operation);
		if (node === undefined) continue;
		root.push(node);
		parentOf.set(node, undefined);
	}
	for (const [draft, folder] of folderNodes) {
		for (const operation of draft.operations) {
			const node = requestNodes.get(operation);
			if (node === undefined) continue;
			folder.children.push(node);
			parentOf.set(node, folder);
		}
		const parent = draft.parent === undefined ? undefined : folderNodes.get(draft.parent);
		(parent?.children ?? root).push(folder);
		parentOf.set(folder, parent);
	}

	/** The earliest declaration in a subtree: what a folder sorts by when nothing constrains it. */
	const firstDeclared = new Map<OrderedNode, number>();
	const declared = (node: OrderedNode): number => {
		const known = firstDeclared.get(node);
		if (known !== undefined) return known;
		const value =
			node.kind === "request"
				? (index.get(node.operation) ?? 0)
				: Math.min(Number.MAX_SAFE_INTEGER, ...node.children.map(declared));
		firstDeclared.set(node, value);
		return value;
	};

	/**
	 * **Two strengths of edge.** A request must run after the request that creates what it uses: that
	 * is `hard`, and without it the request cannot succeed. A request that deletes must run after the
	 * requests that still use what it deletes: that is `soft`, because when folders make it impossible
	 * the creations can still be kept in order and the conflict reported by name.
	 */
	interface Edge {
		readonly from: HttpOperation;
		readonly to: HttpOperation;
		readonly hard: boolean;
	}
	const edges: Edge[] = [];
	for (const operation of operations) {
		for (const resource of chains.consumes(operation)) {
			for (const { operation: creator } of resource.creators) {
				if (creator !== operation) edges.push({ from: creator, to: operation, hard: true });
			}
		}
		for (const role of chains.roles(operation)) {
			if (role.kind !== "list") continue;
			for (const { operation: creator } of role.resource.creators) {
				if (creator !== operation) edges.push({ from: creator, to: operation, hard: true });
			}
		}
	}
	const isDelete = new Set<HttpOperation>();
	for (const resource of chains.resources) {
		const deletes = operations.filter((operation) =>
			chains.roles(operation).some((role) => role.kind === "delete" && role.resource === resource),
		);
		for (const remover of deletes) isDelete.add(remover);
		for (const operation of operations) {
			if (
				deletes.includes(operation) ||
				resource.creators.some((creator) => creator.operation === operation)
			)
				continue;
			if (!chains.consumes(operation).includes(resource)) continue;
			for (const remover of deletes) edges.push({ from: operation, to: remover, hard: false });
		}
	}

	const ancestry = (node: OrderedNode): OrderedNode[] => {
		const chain: OrderedNode[] = [node];
		for (let current = parentOf.get(node); current !== undefined; current = parentOf.get(current)) {
			chain.unshift(current);
		}
		return chain;
	};

	interface SiblingEdge {
		readonly from: OrderedNode;
		readonly to: OrderedNode;
		readonly edge: Edge;
	}
	/** Sibling-level edges, keyed by the container whose children they order (`undefined` is the root). */
	const siblingEdges = new Map<FolderNode | undefined, SiblingEdge[]>();
	for (const edge of edges) {
		const a = requestNodes.get(edge.from);
		const b = requestNodes.get(edge.to);
		if (a === undefined || b === undefined) continue;
		const left = ancestry(a);
		const right = ancestry(b);
		let depth = 0;
		while (depth < left.length && depth < right.length && left[depth] === right[depth]) depth++;
		const first = left[depth];
		const second = right[depth];
		if (first === undefined || second === undefined || first === second) continue;
		const container = depth === 0 ? undefined : (left[depth - 1] as FolderNode);
		siblingEdges.set(container, [
			...(siblingEdges.get(container) ?? []),
			{ from: first, to: second, edge },
		]);
	}

	/** A request that deletes waits until nothing else at its level is ready: a folder ends with its deletes. */
	const rank = (node: OrderedNode): number =>
		node.kind === "request" && isDelete.has(node.operation) ? 1 : 0;
	const byPriority = (a: OrderedNode, b: OrderedNode) =>
		rank(a) - rank(b) || declared(a) - declared(b);

	const sortLevel = (container: FolderNode | undefined, children: OrderedNode[]): OrderedNode[] => {
		const pending = new Set(children);
		let active = (siblingEdges.get(container) ?? []).filter(
			(sibling) => pending.has(sibling.from) && pending.has(sibling.to),
		);
		const sorted: OrderedNode[] = [];
		while (pending.size > 0) {
			const blocked = new Set(
				active.filter((sibling) => pending.has(sibling.from)).map((sibling) => sibling.to),
			);
			const [next] = [...pending].filter((node) => !blocked.has(node)).toSorted(byPriority);
			if (next !== undefined) {
				pending.delete(next);
				sorted.push(next);
				continue;
			}
			/**
			 * **Stuck: every node left waits on another**, so some edge has to be given up. Measured against a
			 * brute-force search over every folder-respecting order, giving up every soft edge at once and
			 * then emitting the rest in declaration order broke hard edges no order needed to break. So:
			 *
			 * 1. only a node on a cycle is ever released, because releasing one merely downstream of a
			 *    cycle breaks its edges and leaves the cycle stuck;
			 * 2. a cycle node that waits on soft edges alone is released first, the fewest of them;
			 * 3. otherwise the soft edges that lie on a cycle are given up, and nothing else;
			 * 4. and only then the cycle node waiting on the fewest hard edges is released.
			 *
			 * Each sibling edge stands for one request edge, so a folder whose requests need more of another
			 * folder weighs more.
			 */
			const within = (sibling: SiblingEdge) => pending.has(sibling.from) && pending.has(sibling.to);
			const reaches = (from: OrderedNode, to: OrderedNode): boolean => {
				const seen = new Set<OrderedNode>();
				const stack = [from];
				while (stack.length > 0) {
					const next = stack.pop();
					if (next === undefined || seen.has(next)) continue;
					if (next === to) return true;
					seen.add(next);
					for (const sibling of active) {
						if (sibling.from === next && within(sibling)) stack.push(sibling.to);
					}
				}
				return false;
			};
			const onCycle = (node: OrderedNode) =>
				active.some(
					(sibling) => sibling.from === node && within(sibling) && reaches(sibling.to, node),
				);
			const cost = (node: OrderedNode) => {
				const waits = active.filter((sibling) => sibling.to === node && within(sibling));
				return {
					hard: waits.filter((sibling) => sibling.edge.hard).length,
					soft: waits.filter((sibling) => !sibling.edge.hard).length,
				};
			};
			const cyclic = [...pending].filter(onCycle);
			const [cheapest] = (cyclic.length > 0 ? cyclic : [...pending]).toSorted((a, b) => {
				const left = cost(a);
				const right = cost(b);
				return left.hard - right.hard || left.soft - right.soft || byPriority(a, b);
			});
			if (cheapest === undefined) break;
			if (cost(cheapest).hard > 0) {
				const softOnCycle = active.filter(
					(sibling) => !sibling.edge.hard && within(sibling) && reaches(sibling.to, sibling.from),
				);
				if (softOnCycle.length > 0) {
					active = active.filter((sibling) => !softOnCycle.includes(sibling));
					continue;
				}
			}
			pending.delete(cheapest);
			sorted.push(cheapest);
			active = active.filter((sibling) => sibling.to !== cheapest);
		}
		return sorted.map((node) =>
			node.kind === "folder" ? { ...node, children: sortLevel(node, node.children) } : node,
		);
	};

	const ordered = sortLevel(undefined, root);
	if (options.flat === true) return ordered;

	/**
	 * **The diagnostic names what the final order actually breaks**, checked against that order
	 * rather than inferred from which edges the sort gave up, so it never reports a dependency that
	 * happens to hold.
	 */
	const position = new Map<HttpOperation, number>();
	const flatten = (nodes: readonly OrderedNode[]) => {
		for (const node of nodes) {
			if (node.kind === "request") position.set(node.operation, position.size);
			else flatten(node.children);
		}
	};
	flatten(ordered);
	const broken = edges
		.filter((edge) => (position.get(edge.from) ?? 0) > (position.get(edge.to) ?? 0))
		.map((edge) => `'${qualified(edge.from)}' before '${qualified(edge.to)}'`);
	if (broken.length > 0) {
		reportDiagnostic(program, {
			code: "order-cycle",
			format: { operations: [...new Set(broken)].join(", ") },
			target: serviceNamespace,
		});
	}
	return ordered;

	function qualified(operation: HttpOperation): string {
		const container = operation.container;
		return container === serviceNamespace
			? operation.operation.name
			: `${relativeName(container, serviceName)}.${operation.operation.name}`;
	}
}

/**
 * Where each operation was written: by source file in the order the compiler loaded them, then by
 * position in the file. **Not the library's order**, which lists a namespace's own operations before
 * every interface in it regardless of where the author wrote them.
 */
export function declarationOrder(
	program: Program,
	operations: readonly HttpOperation[],
): Map<HttpOperation, number> {
	const files = [...program.sourceFiles.keys()];
	const located = operations.map((operation, position) => {
		const node = operation.operation.node;
		const location = node === undefined ? undefined : getSourceLocation(node);
		const file = location === undefined ? -1 : files.indexOf(location.file.path);
		return { operation, file, pos: location?.pos ?? 0, position };
	});
	located.sort((a, b) => a.file - b.file || a.pos - b.pos || a.position - b.position);
	return new Map(located.map((entry, order) => [entry.operation, order]));
}

/**
 * **A service's operations in the order the spec declares them**, by `declarationOrder`.
 *
 * `@typespec/http` lists them in the order the checker finished their interfaces, and a type is
 * checked early wherever something checked before it names it: a second file whose only statement
 * is an augment decorator naming an operation, of a library this emitter knows nothing of, moved the
 * collection's error cases and variables while its folders, already in declaration order, stayed.
 * Every derivation reads the operations in this order, so the collection depends on what is
 * declared and on nothing another library makes the checker meet first.
 */
export function inDeclarationOrder(
	program: Program,
	operations: readonly HttpOperation[],
): HttpOperation[] {
	const index = declarationOrder(program, operations);
	return operations.toSorted((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
}

/** `Service.Admin.Users` inside service `Service` -> `Admin.Users`. */
function relativeName(container: Interface | Namespace, serviceName: string): string {
	const names: string[] = [container.name];
	for (let current = container.namespace; current !== undefined; current = current.namespace) {
		if (getNamespaceFullName(current) === serviceName || current.name === "") break;
		names.unshift(current.name);
	}
	return names.join(".");
}
