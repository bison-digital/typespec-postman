import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { compile, NodeHost } from "@typespec/compiler";

/**
 * Compile one TypeSpec file with this emitter, and optionally the emitters it is graded against.
 *
 * **The real compiler against the real filesystem**, as the sibling emitters test, so the emitter is
 * loaded from `dist/` exactly as a consumer's `tsp compile` loads it. That is also why `pnpm test`
 * builds first: a suite run without a build grades yesterday's emitter.
 */
export interface Compiled {
	readonly outDir: string;
	readonly diagnostics: readonly {
		readonly code: string;
		readonly severity: string;
		readonly message: string;
	}[];
	/** The collection written for one service, parsed. */
	collection(file?: string): PostmanCollection;
	/** The same file as bytes, for comparisons that must be exact. */
	text(file?: string): string;
	/** The OpenAPI 3.1 document `@typespec/openapi3` wrote, when `openapi` was requested. */
	document(file?: string): OpenApiDocument;
	readonly serverDir: string;
}

export interface CompileOptions {
	/** Options for this emitter, besides its output directory. */
	readonly postman?: Readonly<Record<string, unknown>>;
	/** Also emit `@typespec/openapi3` into `openapi/`, sealed, as the oracles compare against. */
	readonly openapi?: boolean;
	/** Also emit a typespec-hono server into `server/`, as `run/` serves. */
	readonly hono?: boolean;
	readonly noEmit?: boolean;
	readonly dryRun?: boolean;
}

export async function compileSpec(
	mainFile: string,
	outDir: string,
	options: CompileOptions = {},
): Promise<Compiled> {
	/**
	 * **Emptied first, so an assertion cannot be answered by the previous run.** An emitter that
	 * stops writing a file leaves the last one on disk, and every arm reading that directory would go
	 * on passing.
	 */
	rmSync(outDir, { recursive: true, force: true });
	const emit = [
		"typespec-postman",
		...(options.openapi === true ? ["@typespec/openapi3"] : []),
		...(options.hono === true ? ["typespec-hono"] : []),
	];
	const program = await compile(NodeHost, mainFile, {
		outputDir: outDir,
		emit,
		...(options.noEmit === true ? { noEmit: true } : {}),
		...(options.dryRun === true ? { dryRun: true } : {}),
		options: {
			"typespec-postman": { "emitter-output-dir": outDir, ...options.postman },
			"@typespec/openapi3": {
				"emitter-output-dir": join(outDir, "openapi"),
				"file-type": "json",
				"openapi-versions": ["3.1.0"],
				"seal-object-schemas": true,
				"output-file": "{service-name-if-multiple}.openapi.json",
			},
			"typespec-hono": {
				"emitter-output-dir": join(outDir, "server"),
				"seal-object-schemas": true,
			},
		},
	});
	const read = (file: string) => readFileSync(join(outDir, file), "utf8");
	return {
		outDir,
		serverDir: join(outDir, "server"),
		diagnostics: program.diagnostics.map((diagnostic) => ({
			code: diagnostic.code,
			severity: diagnostic.severity,
			message: diagnostic.message,
		})),
		collection: (file = "postman_collection.json") => JSON.parse(read(file)) as PostmanCollection,
		text: (file = "postman_collection.json") => read(file),
		document: (file = "openapi.json") => JSON.parse(read(join("openapi", file))) as OpenApiDocument,
	};
}

/**
 * Compile `<dir>/<name>.tsp` into `<dir>/.out/<outName>/`. **`outName` is unique across suites**:
 * vitest runs files in parallel, and two suites compiling into one directory grade each other's
 * output. `isolation.test.ts` asserts no two share one.
 */
export function compileFixture(
	dir: string,
	name: string,
	options: CompileOptions & { readonly outName?: string } = {},
): Promise<Compiled> {
	return compileSpec(join(dir, `${name}.tsp`), join(dir, ".out", options.outName ?? name), options);
}

/** The first request with this name, anywhere in the collection. */
export function requestNamed(
	collection: PostmanCollection,
	name: string,
	folder?: string,
): PostmanItem {
	const found = requestsOf(collection).find(
		({ path, item }) => item.name === name && (folder === undefined || path.at(-1) === folder),
	);
	if (found === undefined)
		throw new Error(`no request named ${folder === undefined ? "" : `${folder}/`}${name}`);
	return found.item;
}

/** A folder by name, anywhere in the collection. */
export function folderNamed(collection: PostmanCollection, name: string): PostmanItem {
	const walk = (items: readonly PostmanItem[]): PostmanItem | undefined => {
		for (const item of items) {
			if (item.item === undefined) continue;
			if (item.name === name) return item;
			const inner = walk(item.item);
			if (inner !== undefined) return inner;
		}
		return undefined;
	};
	const found = walk(collection.item);
	if (found === undefined) throw new Error(`no folder named ${name}`);
	return found;
}

/** Header value by name, case-insensitively. */
export function headerOf(item: PostmanItem, name: string): PostmanParam | undefined {
	return item.request?.header.find((header) => header.key.toLowerCase() === name.toLowerCase());
}

/** The codes of warnings, for arms that assert a refusal was reported. */
export function codes(compiled: Compiled): string[] {
	return compiled.diagnostics.map((diagnostic) => diagnostic.code);
}

/** The parts of a Postman v2.1 collection the suites read. */
export interface PostmanCollection {
	readonly info: {
		readonly _postman_id: string;
		readonly name: string;
		readonly schema: string;
		readonly description?: string;
	};
	readonly item: readonly PostmanItem[];
	readonly auth?: PostmanAuth;
	readonly variable?: readonly {
		readonly key: string;
		readonly value: string;
		readonly description?: string;
	}[];
}

export interface PostmanAuth {
	readonly type: string;
	readonly [scheme: string]: unknown;
}

export interface PostmanParam {
	readonly key: string;
	readonly value: string;
	readonly disabled?: boolean;
}

export interface PostmanItem {
	readonly id: string;
	readonly name: string;
	readonly item?: readonly PostmanItem[];
	readonly auth?: PostmanAuth;
	readonly event?: readonly {
		readonly listen: string;
		readonly script: { readonly exec: readonly string[] };
	}[];
	readonly request?: {
		readonly method: string;
		readonly auth?: PostmanAuth;
		readonly header: readonly PostmanParam[];
		readonly body?: {
			readonly mode: string;
			readonly raw?: string;
			readonly [key: string]: unknown;
		};
		readonly url: {
			readonly raw: string;
			readonly path: readonly string[];
			readonly query?: readonly PostmanParam[];
			readonly variable?: readonly PostmanParam[];
		};
	};
}

/** The parts of an OpenAPI 3.1 document the suites read. */
export interface OpenApiDocument {
	readonly paths: Readonly<
		Record<
			string,
			Readonly<Record<string, { readonly responses: Readonly<Record<string, unknown>> }>>
		>
	>;
	readonly components?: { readonly securitySchemes?: Readonly<Record<string, SecurityScheme>> };
	readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
}

export type SecurityScheme =
	| { readonly type: "http"; readonly scheme: string }
	| { readonly type: "apiKey"; readonly in: "header" | "query" | "cookie"; readonly name: string }
	| { readonly type: "oauth2" | "openIdConnect" };

/** Every request in a collection, depth first, with the folder path that holds it. */
export function requestsOf(
	collection: PostmanCollection,
): { readonly path: readonly string[]; readonly item: PostmanItem }[] {
	const out: { path: readonly string[]; item: PostmanItem }[] = [];
	const walk = (items: readonly PostmanItem[], path: readonly string[]) => {
		for (const item of items) {
			if (item.item !== undefined) walk(item.item, [...path, item.name]);
			else out.push({ path, item });
		}
	};
	walk(collection.item, []);
	return out;
}

/** Test script lines of a request. */
export function scriptOf(item: PostmanItem): string[] {
	return item.event?.flatMap((event) => [...event.script.exec]) ?? [];
}
