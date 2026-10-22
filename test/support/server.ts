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
 * refused here with a 400. So is response validation: a handler answers `{ status, body, headers }`,
 * and the route refuses a status the spec does not declare and a body the declared one forbids.
 *
 * **Which header a scheme reads comes from the document's `securitySchemes`**, not from code written
 * by hand from the spec.
 */

export interface HonoContext {
	req: { header(name: string): string | undefined; query(name: string): string | undefined };
	json(body: unknown, status?: number, headers?: Record<string, string>): Response;
}

export type Handlers = Record<string, (ctx: unknown, input: Record<string, unknown>) => unknown>;

/** A JSON body as a server that disagrees with its spec would serve it, from the one it served. */
export type RewriteBody = (
	request: { readonly method: string; readonly path: string },
	status: number,
	body: unknown,
) => unknown;

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
		/** Answer this status in place of the one served: a server that disagrees with the spec. */
		readonly rewriteStatus?: { readonly from: number; readonly to: number };
		/**
		 * Serve this JSON body in place of the one the route served. The route validates what a handler
		 * answers and will not serve a body its status forbids, so a mutant that does is applied here,
		 * on the wire, as a server without that guarantee would answer.
		 */
		readonly rewriteBody?: RewriteBody;
		/** Answer every response with this Content-Type instead of the one the arm serves. */
		readonly contentType?: string;
		/** Drop this header from every response. */
		readonly dropHeader?: string;
		/**
		 * Rewrite the `Location` a create answers with, as a reverse proxy serving the API under a base
		 * path does when the service behind it does not know its own mount point. The header is present
		 * and well formed; it just identifies a resource that is not there.
		 */
		readonly rewriteLocation?: (location: string) => string;
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
	const { contentType, dropHeader, rewriteLocation, rewriteStatus, rewriteBody, bodyWhereNone } =
		overrides;
	if (
		contentType !== undefined ||
		dropHeader !== undefined ||
		rewriteLocation !== undefined ||
		rewriteStatus !== undefined ||
		rewriteBody !== undefined ||
		bodyWhereNone === true
	) {
		app.use(async (c, next) => {
			await next();
			const served = c.res;
			const headers = new Headers(served.headers);
			let body: ReadableStream<Uint8Array> | string | null = served.body;
			if (bodyWhereNone === true && served.body === null) {
				body = JSON.stringify({ unexpected: true });
				headers.set("content-type", "application/json");
			} else if (
				rewriteBody !== undefined &&
				served.body !== null &&
				(served.headers.get("content-type") ?? "").includes("json")
			) {
				body = JSON.stringify(
					rewriteBody(
						{ method: c.req.method, path: c.req.path },
						served.status,
						await served.json(),
					),
				);
				headers.delete("content-length");
			}
			if (contentType !== undefined && headers.has("content-type"))
				headers.set("content-type", contentType);
			if (dropHeader !== undefined) headers.delete(dropHeader);
			const location = headers.get("location");
			if (rewriteLocation !== undefined && location !== null)
				headers.set("location", rewriteLocation(location));
			const status = rewriteStatus?.from === served.status ? rewriteStatus.to : served.status;
			const replacement = new Response(body, { status, headers });
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
	const unauthorized = (c: HonoContext): Response => c.json({ title: "Unauthorized" }, 401);
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
				if (!ok) return unauthorized(c);
				await next();
				return undefined;
			},
		context: () => ({}),
		noContext: unauthorized,
		notAcceptable: (c: HonoContext) => c.json({ title: "Not acceptable" }, 406),
		invalid: (result: { success: boolean; error?: unknown }, c: HonoContext) =>
			result.success
				? undefined
				: overrides.acceptInvalid === true
					? c.json({ title: "Accepted anyway" }, 200)
					: c.json({ title: "Invalid", detail: String(result.error) }, 400),
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
