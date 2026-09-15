import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, NodeHost, type Program } from "@typespec/compiler";
import {
	createMetadataInfo,
	getAllHttpServices,
	type HttpOperation,
	Visibility,
} from "@typespec/http";
import { describe, expect, it } from "vitest";
import { type OrderedNode, orderRequests } from "../../src/order.js";
import { deriveChains } from "../../src/resources.js";

/**
 * **No folder-respecting order breaks fewer dependencies than the one emitted**, found by trying
 * every one of them.
 *
 * `order.ts` sorts greedily and has to give something up when folders make every dependency
 * impossible to keep. A greedy choice is only as good as the cases it was tried on, so each fixture in
 * `cases/` is searched exhaustively: every permutation of every folder's children, folders kept
 * contiguous and nested as emitted. The emitted order must break no more hard edges than the best of
 * them, then no more soft edges, and `order-cycle` must name exactly what it breaks. Each fixture here
 * was a counterexample to an earlier version of the sort.
 *
 * **Where the expectation comes from:** the optimum is a search, not the sort. The edges are the
 * contract `order.ts` states (a creation before each use and each list, a use before each delete of
 * what it uses), rebuilt here from the chains.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const cases = join(here, "cases");

interface Measured {
	readonly emitted: readonly [number, number];
	readonly optimum: readonly [number, number];
	readonly reported: ReadonlySet<string>;
	readonly broken: ReadonlySet<string>;
	readonly orderings: number;
}

async function measure(file: string): Promise<Measured> {
	const outDir = join(here, ".out", "optimal", file.replace(/\.tsp$/, ""));
	rmSync(outDir, { recursive: true, force: true });
	const program: Program = await compile(NodeHost, join(cases, file), {
		outputDir: outDir,
		emit: ["typespec-postman"],
		options: { "typespec-postman": { "emitter-output-dir": outDir } },
	});
	expect(program.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
	const reported = new Set(
		program.diagnostics
			.filter((d) => d.code === "typespec-postman/order-cycle")
			.flatMap((d) => [...d.message.matchAll(/'([^']+)' before '([^']+)'/g)].map((m) => m[0])),
	);
	const [[service]] = getAllHttpServices(program);
	if (service === undefined) throw new Error(`${file}: no service`);
	const operations = service.operations;
	const metadata = createMetadataInfo(program, { canonicalVisibility: Visibility.Read });
	const chains = deriveChains(program, metadata, operations);
	const tree = orderRequests(program, service.namespace, operations, chains);

	const id = new Map(operations.map((operation, index) => [operation, index]));
	const qualified = (operation: HttpOperation) => {
		if (operation.container === service.namespace) return operation.operation.name;
		const names = [operation.container.name];
		for (
			let n = operation.container.namespace;
			n !== undefined && n !== service.namespace;
			n = n.namespace
		)
			names.unshift(n.name);
		return `${names.join(".")}.${operation.operation.name}`;
	};

	const hard = new Map<string, [HttpOperation, HttpOperation]>();
	const soft = new Map<string, [HttpOperation, HttpOperation]>();
	const add = (edges: typeof hard, from: HttpOperation, to: HttpOperation) =>
		edges.set(`${id.get(from)}>${id.get(to)}`, [from, to]);
	for (const operation of operations) {
		for (const resource of chains.consumes(operation))
			for (const creator of resource.creators)
				if (creator !== operation) add(hard, creator, operation);
		for (const role of chains.roles(operation))
			if (role.kind === "list")
				for (const creator of role.resource.creators)
					if (creator !== operation) add(hard, creator, operation);
	}
	for (const resource of chains.resources) {
		const deletes = operations.filter((operation) =>
			chains.roles(operation).some((role) => role.kind === "delete" && role.resource === resource),
		);
		for (const operation of operations) {
			if (deletes.includes(operation) || resource.creators.includes(operation)) continue;
			if (!chains.consumes(operation).includes(resource)) continue;
			for (const remover of deletes) add(soft, operation, remover);
		}
	}

	const position = new Int32Array(operations.length);
	const count = (): [number, number] => {
		let h = 0;
		let s = 0;
		for (const [from, to] of hard.values())
			if ((position[id.get(from) ?? 0] ?? 0) > (position[id.get(to) ?? 0] ?? 0)) h++;
		for (const [from, to] of soft.values())
			if ((position[id.get(from) ?? 0] ?? 0) > (position[id.get(to) ?? 0] ?? 0)) s++;
		return [h, s];
	};

	// The emitted order, and what it breaks.
	let next = 0;
	const place = (nodes: readonly OrderedNode[]) => {
		for (const node of nodes) {
			if (node.kind === "request") position[id.get(node.operation) ?? 0] = next++;
			else place(node.children);
		}
	};
	place(tree);
	const emitted = count();
	const broken = new Set(
		[...hard.values(), ...soft.values()]
			.filter(([from, to]) => (position[id.get(from) ?? 0] ?? 0) > (position[id.get(to) ?? 0] ?? 0))
			.map(([from, to]) => `'${qualified(from)}' before '${qualified(to)}'`),
	);

	// Every order over the same nesting.
	const levels: OrderedNode[][] = [];
	const levelOf = new Map<OrderedNode, number>();
	const register = (children: readonly OrderedNode[], owner: OrderedNode | undefined) => {
		if (owner !== undefined) levelOf.set(owner, levels.length);
		levels.push([...children]);
		for (const child of children) if (child.kind === "folder") register(child.children, child);
	};
	register(tree, undefined);
	const permutations = (k: number): number[][] => {
		if (k === 0) return [[]];
		return permutations(k - 1).flatMap((rest) =>
			Array.from({ length: k }, (_, at) => [...rest.slice(0, at), k - 1, ...rest.slice(at)]),
		);
	};
	const perms = levels.map((level) => permutations(level.length));
	const orderings = perms.reduce((total, level) => total * level.length, 1);
	expect(orderings).toBeLessThan(2_000_000);
	const choice = levels.map(() => 0);
	let optimum: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
	for (let n = 0; n < orderings; n++) {
		next = 0;
		const walk = (level: number) => {
			for (const index of perms[level]?.[choice[level] ?? 0] ?? []) {
				const node = levels[level]?.[index];
				if (node === undefined) continue;
				if (node.kind === "request") position[id.get(node.operation) ?? 0] = next++;
				else walk(levelOf.get(node) ?? 0);
			}
		};
		walk(0);
		const [h, s] = count();
		if (h < optimum[0] || (h === optimum[0] && s < optimum[1])) optimum = [h, s];
		for (let level = levels.length - 1; level >= 0; level--) {
			choice[level] = (choice[level] ?? 0) + 1;
			if ((choice[level] ?? 0) < (perms[level]?.length ?? 0)) break;
			choice[level] = 0;
		}
	}
	return { emitted, optimum, reported, broken, orderings };
}

describe("the emitted request order is the best any folder-respecting order can do", () => {
	const files = readdirSync(cases)
		.filter((name) => name.endsWith(".tsp"))
		.toSorted();

	it("has cases to search", () => {
		expect(files.length).toBeGreaterThanOrEqual(9);
	});

	for (const file of files) {
		it(`${file}: breaks no more than the optimum, and reports exactly what it breaks`, async () => {
			const measured = await measure(file);
			expect(measured.orderings).toBeGreaterThan(1);
			expect(measured.emitted).toEqual(measured.optimum);
			expect([...measured.reported].toSorted()).toEqual([...measured.broken].toSorted());
		}, 120_000);
	}
});
