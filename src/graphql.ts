import { getTypeName, NoTarget, type Program } from "@typespec/compiler";
import type { HttpOperation } from "@typespec/http";
import { DEFAULT_GRAPHQL_URL, type EmitterOptions, PACKAGE_NAME, reportDiagnostic } from "./lib.js";
import type { Chained } from "./requests.js";

/**
 * **The requests typespec-http-graphql served, read from the copy of it the compiler ran.**
 *
 * A GraphQL request has to match the schema that emitter serves: its type names, its arguments, the
 * declarations it dropped. So nothing here derives a document. typespec-http-graphql records what it
 * planned as it emits, and publishes it as `graphqlRequestsOf`; this module finds that emitter in
 * `program.emitters` and reads the function off the module the compiler loaded, so the record read is
 * the one written, whatever copies of the package a project's tree holds. Nothing is imported, and
 * nothing is required: a compile that does not emit typespec-http-graphql gets no GraphQL requests.
 *
 * **It must run first.** Emitters run in the order `emit:` lists them, and the record exists only once
 * that emitter has run, so one listed after this one is warned, `graphql-emitted-later`.
 */

/** One request, as typespec-http-graphql's `graphqlRequestsOf` publishes it: the part read here. */
export interface GraphQLRequest {
	readonly kind: "query" | "mutation";
	readonly field: string;
	readonly operation: HttpOperation;
	readonly description: string | undefined;
	readonly document: string;
	readonly successTypenames: readonly string[] | undefined;
	readonly variables: (input: {
		readonly parameters: Readonly<Record<string, unknown>>;
		readonly body?: unknown;
	}) => { readonly value: Readonly<Record<string, unknown>>; readonly missing: readonly string[] };
}

/** The subset of typespec-http-graphql's module this one calls. */
interface GraphQLModule {
	readonly graphqlRequestsOf?: (
		program: Program,
	) =>
		| readonly { readonly service: string; readonly requests: readonly GraphQLRequest[] }[]
		| undefined;
}

const GRAPHQL_EMITTER = "typespec-http-graphql";

/**
 * Each service's GraphQL requests, by its namespace's full name; `undefined` where the compile
 * emits no GraphQL surface this emitter can read, warned where it emits one too late or too old.
 */
export function graphqlRequestsIn(
	program: Program,
): ReadonlyMap<string, readonly GraphQLRequest[]> | undefined {
	const emitters = program.emitters;
	const at = emitters.findIndex((emitter) => emitter.metadata.name === GRAPHQL_EMITTER);
	if (at < 0) return undefined;
	const self = emitters.findIndex((emitter) => emitter.metadata.name === PACKAGE_NAME);
	if (self >= 0 && at > self) {
		reportDiagnostic(program, {
			code: "graphql-emitted-later",
			format: { emitter: PACKAGE_NAME },
			target: NoTarget,
		});
		return undefined;
	}
	const ref = emitters[at];
	const read = (ref?.library.entrypoint?.esmExports as GraphQLModule | undefined)
		?.graphqlRequestsOf;
	if (typeof read !== "function") {
		reportDiagnostic(program, {
			code: "graphql-requests-unavailable",
			format: { version: ref?.metadata.version ?? "unknown" },
			target: NoTarget,
		});
		return undefined;
	}
	const services = read(program);
	return services === undefined
		? undefined
		: new Map(services.map((service) => [service.service, service.requests]));
}

/**
 * **An operation as both emitters can name it**: its method, its route and its declared name. Not the
 * operation itself, since each emitter projects a versioned service anew and holds its own clone of
 * it, and not its declaration, which every interface extending one template shares.
 */
export function operationKey(operation: HttpOperation): string {
	return `${operation.verb} ${operation.uriTemplate} ${getTypeName(operation.operation)}`;
}

/** Where a service's GraphQL requests go: a host Postman stores whole, and path segments. */
export interface GraphQLUrl {
	readonly host: string;
	readonly path: readonly string[];
}

const URL_SHAPE = /^(\{\{[^{}]+\}\}|https?:\/\/[^/?#]+)((?:\/[^?#]*)?)$/;

function parsed(url: string): GraphQLUrl | undefined {
	const match = URL_SHAPE.exec(url);
	if (match === null) return undefined;
	return {
		host: match[1] ?? "",
		path: (match[2] ?? "").split("/").filter((segment) => segment !== ""),
	};
}

/** The service's own `graphql-url`, else the emitter's, else `{{baseUrl}}/graphql`. */
export function graphqlUrlOf(
	program: Program,
	options: EmitterOptions,
	service: string,
): GraphQLUrl {
	const url =
		options.services?.[service]?.["graphql-url"] ?? options["graphql-url"] ?? DEFAULT_GRAPHQL_URL;
	const read = parsed(url);
	if (read !== undefined) return read;
	reportDiagnostic(program, {
		code: "graphql-url-invalid",
		format: { url, fallback: DEFAULT_GRAPHQL_URL },
		target: NoTarget,
	});
	return parsed(DEFAULT_GRAPHQL_URL) as GraphQLUrl;
}

/**
 * **A request's variables as Postman sends them**: JSON, two spaces deep, each created id the
 * collection variable that holds it. A number's variable stands unquoted, so Postman sends the number.
 */
export function variablesText(
	value: Readonly<Record<string, unknown>>,
	chained: ReadonlyMap<string, Chained>,
): string {
	let text = JSON.stringify(value, null, 2);
	for (const { variable, numeric } of chained.values()) {
		if (numeric) text = text.replaceAll(JSON.stringify(`{{${variable}}}`), `{{${variable}}}`);
	}
	return text;
}
