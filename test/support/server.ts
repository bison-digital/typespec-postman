import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { OpenApiDocument, SecurityScheme } from "./compile.js";

/**
 * A typespec-hono server generated from the same `.tsp` as the collection, listening on a real port.
 *
 * **The collection's claim is that it runs green against a server implementing the spec, so the
 * server is GENERATED from the spec.** Request validation is typespec-hono's, which is itself graded
 * against the published document, so a body the collection sends that the spec would refuse is
 * refused here with a 400.
 *
 * **Nothing the hooks decide is written by hand from the spec.** Which header a scheme reads comes
 * from the document's `securitySchemes`; which status a response takes comes from the arm the
 * generated server hands `respond`, validated against that arm's own schema.
 */

/** A handler's way of answering an error arm: return this, and `respond` picks the arm with that status. */
export const FAIL = Symbol("fail");
export type Failure = { readonly [FAIL]: number; readonly title: string };
export const fail = (status: number, title: string): Failure => ({ [FAIL]: status, title });

interface Arm {
	readonly status: number | string;
	readonly schema: { parse(value: unknown): unknown } | undefined;
	readonly headers?: readonly { readonly name: string; readonly property: string }[];
	readonly when?: { readonly property: string; readonly value: unknown };
}

export interface HonoContext {
	req: { header(name: string): string | undefined; query(name: string): string | undefined };
	json(body: unknown, status?: number, headers?: Record<string, string>): Response;
	body(body: null, status: number, headers?: Record<string, string>): Response;
}

export type Handlers = Record<string, (ctx: unknown, input: Record<string, unknown>) => unknown>;

export interface Served {
	readonly origin: string;
	close(): Promise<void>;
}

function satisfied(scheme: SecurityScheme | undefined, c: HonoContext): boolean {
	if (scheme === undefined) return false;
	switch (scheme.type) {
		case "http": {
			const header = c.req.header("authorization") ?? "";
			const [kind, credential] = header.split(" ");
			return kind?.toLowerCase() === scheme.scheme.toLowerCase() && (credential ?? "") !== "";
		}
		case "apiKey":
			if (scheme.in === "header") return (c.req.header(scheme.name) ?? "") !== "";
			if (scheme.in === "query") return (c.req.query(scheme.name) ?? "") !== "";
			return (c.req.header("cookie") ?? "")
				.split(/;\s*/)
				.some((pair) => pair.startsWith(`${scheme.name}=`) && pair.length > scheme.name.length + 1);
		default:
			return (c.req.header("authorization") ?? "").startsWith("Bearer ");
	}
}

export async function serveGenerated(
	serverDir: string,
	document: OpenApiDocument,
	basePath: string,
	handlers: Handlers | ((c: HonoContext) => Handlers),
	overrides: {
		/** Refuse every request that lacks this header: a server stricter than the spec. */
		readonly requireHeader?: string;
		/** Answer this status in place of the one the arm declares: a server that disagrees with the spec. */
		readonly rewriteStatus?: { readonly from: number; readonly to: number };
		/** Skip validating responses, so a mutant can return what its arm forbids. */
		readonly unvalidated?: boolean;
		/** The body an error arm carries, for a spec whose error models declare more than a title. */
		readonly failureBody?: (status: number, title: string) => Record<string, unknown>;
		/**
		 * How an error response is served, for a spec whose error models declare their own media type
		 * and headers (`application/problem+json`, `WWW-Authenticate`). Applied to the refusals the
		 * hooks answer (401, 400) as well as to a handler's, so the whole error contract is the spec's.
		 */
		readonly failureMedia?: {
			readonly contentType: string;
			readonly headers: (status: number) => Record<string, string>;
		};
		/** Answer every response with this Content-Type instead of the one the arm serves. */
		readonly contentType?: string;
		/** Drop this header from every response. */
		readonly dropHeader?: string;
		/** Serve a JSON body where an arm declares none. */
		readonly bodyWhereNone?: boolean;
		/** Answer a request the validators refuse with a 200, as a server that validates nothing would. */
		readonly acceptInvalid?: boolean;
		/** Admit every caller, credentialed or not. */
		readonly ignoreAuth?: boolean;
	} = {},
): Promise<Served> {
	const generated = (await import(join(serverDir, "app.gen.ts"))) as {
		registerRoutes: (app: unknown, handlersFor: unknown, deps: unknown) => void;
	};
	const schemes = document.components?.securitySchemes ?? {};
	const app = new Hono();
	// A thrown handler or a response its arm refuses surfaces in the run report, not as a bare 500.
	app.onError((error, c) => c.json({ title: "Server error", detail: String(error) }, 500));
	const mounted = basePath === "" ? app : app.basePath(basePath);
	if (overrides.contentType !== undefined || overrides.dropHeader !== undefined) {
		const { contentType, dropHeader } = overrides;
		app.use(async (c, next) => {
			await next();
			const headers = new Headers(c.res.headers);
			if (contentType !== undefined && headers.has("content-type"))
				headers.set("content-type", contentType);
			if (dropHeader !== undefined) headers.delete(dropHeader);
			const replacement = new Response(c.res.body, { status: c.res.status, headers });
			// Hono merges the previous response's headers into a replacement, so clear it first.
			c.res = undefined as unknown as Response;
			c.res = replacement;
		});
	}
	if (overrides.requireHeader !== undefined) {
		const header = overrides.requireHeader;
		mounted.use(async (c, next) => {
			if ((c.req.header(header) ?? "") === "") return c.json({ title: `missing ${header}` }, 400);
			await next();
			return undefined;
		});
	}
	/** An error response as the spec serves it: its body, its media type and its headers. */
	const refusal = (c: HonoContext, status: number, title: string): Response => {
		const body = overrides.failureBody?.(status, title) ?? { title };
		if (overrides.failureMedia === undefined) return c.json(body, status);
		return new Response(JSON.stringify(body), {
			status,
			headers: {
				"content-type": overrides.failureMedia.contentType,
				...overrides.failureMedia.headers(status),
			},
		});
	};
	generated.registerRoutes(mounted, typeof handlers === "function" ? handlers : () => handlers, {
		authorize:
			(requirements: readonly Record<string, readonly string[]>[]) =>
			async (c: HonoContext, next: () => Promise<void>) => {
				const ok =
					overrides.ignoreAuth === true ||
					requirements.length === 0 ||
					requirements.some((requirement) =>
						Object.keys(requirement).every((name) => satisfied(schemes[name], c)),
					);
				if (!ok) return refusal(c, 401, "Unauthorized");
				await next();
				return undefined;
			},
		context: () => ({}),
		noContext: (c: HonoContext) => refusal(c, 401, "Unauthorized"),
		notAcceptable: (c: HonoContext) => c.json({ title: "Not acceptable" }, 406),
		invalid: (result: { success: boolean; error?: unknown }, c: HonoContext) =>
			result.success
				? undefined
				: overrides.acceptInvalid === true
					? c.json({ title: "Accepted anyway" }, 200)
					: overrides.failureBody === undefined && overrides.failureMedia === undefined
						? c.json({ title: "Invalid", detail: String(result.error) }, 400)
						: refusal(c, 400, "Invalid"),
		respond: (c: HonoContext, arms: readonly Arm[], value: unknown) => {
			const failure =
				value !== null && typeof value === "object" && FAIL in value
					? (value as Failure)
					: undefined;
			const record = (value ?? {}) as Record<string, unknown>;
			const arm =
				failure !== undefined
					? arms.find((candidate) => candidate.status === failure[FAIL])
					: (arms.find(
							(candidate) =>
								candidate.when !== undefined &&
								record[candidate.when.property] === candidate.when.value,
						) ??
						arms.find(
							(candidate) =>
								typeof candidate.status === "number" &&
								candidate.status >= 200 &&
								candidate.status < 300,
						));
			if (arm === undefined || typeof arm.status !== "number") {
				throw new Error(`no response arm for ${JSON.stringify(value)}`);
			}
			const headers: Record<string, string> = {};
			const body: Record<string, unknown> =
				failure === undefined
					? { ...record }
					: (overrides.failureBody?.(failure[FAIL], failure.title) ?? { title: failure.title });
			for (const header of arm.headers ?? []) {
				const carried = record[header.property];
				if (typeof carried === "string") headers[header.name] = carried;
				delete body[header.property];
			}
			if (arm.when !== undefined) delete body[arm.when.property];
			const status =
				overrides.rewriteStatus?.from === arm.status ? overrides.rewriteStatus.to : arm.status;
			if (failure !== undefined && overrides.failureMedia !== undefined) {
				const served = arm.schema === undefined ? body : arm.schema.parse(body);
				return new Response(JSON.stringify(served), {
					status,
					headers: {
						...headers,
						"content-type": overrides.failureMedia.contentType,
						...overrides.failureMedia.headers(status),
					},
				});
			}
			if (arm.schema === undefined) {
				return overrides.bodyWhereNone === true
					? c.json({ unexpected: true }, status, headers)
					: c.body(null, status, headers);
			}
			const payload = Array.isArray(value) ? value : body;
			// Spec-strict responses: a handler returning something the arm forbids is a 500, not a pass.
			return c.json(
				overrides.unvalidated === true ? payload : arm.schema.parse(payload),
				status,
				headers,
			);
		},
	});
	const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
	await new Promise<void>((resolve) => {
		if (server.listening) resolve();
		else server.once("listening", () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
