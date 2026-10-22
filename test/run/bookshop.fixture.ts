import { randomUUID } from "node:crypto";
import type { RewriteBody } from "../support/server.js";

/**
 * In-memory handlers for `example/main.tsp`, the application a deployment check would run against.
 * Each answers `{ status, body, headers }`, as an application written against typespec-hono does.
 *
 * **Each mutant is one way a server can disagree with its spec**, and `run.test.ts` requires the
 * generated collection to go red on every one. A collection that stays green against a broken server
 * is not checking anything.
 *
 * **A mutant serving a body the spec forbids is a rewrite on the wire** ({@link bookshopRewrite}).
 * The generated route validates what a handler answers and will not serve such a body at all, so
 * the handler answers correctly and the response is changed after it, as a server without that
 * guarantee would answer.
 */
export type Mutant =
	| "none"
	| "create-omits-id"
	| "create-numeric-id"
	| "list-returns-object"
	| "bare-list-returns-object"
	| "read-returns-other"
	| "update-ignores-patch"
	| "read-returns-malformed"
	| "read-finds-anything";

type Input = Record<string, unknown>;

interface Author {
	id: string;
	name: string;
	bio?: string;
}

interface Book {
	id: string;
	title: string;
	pages: number;
}

const notFound = (title: string) => ({ status: 404, body: { title } });

export function bookshopHandlers(
	mutant: Mutant,
): Record<string, (ctx: unknown, input: Input) => unknown> {
	const authors = new Map<string, Author>();
	const books = new Map<string, Map<string, Book>>();
	return {
		health: () => ({ status: 200, body: { status: "ok" } }),
		Authors_create: (_ctx, input) => {
			const author: Author = { id: randomUUID(), name: String(input["name"]) };
			if (typeof input["bio"] === "string") author.bio = input["bio"];
			authors.set(author.id, author);
			books.set(author.id, new Map());
			return { status: 201, body: author, headers: { location: `/v1/authors/${author.id}` } };
		},
		Authors_list: () => ({ status: 200, body: { items: [...authors.values()] } }),
		Authors_read: (_ctx, input) => {
			const author = authors.get(String(input["authorId"]));
			if (author === undefined) {
				return mutant === "read-finds-anything"
					? { status: 200, body: { id: String(input["authorId"]), name: "Anyone" } }
					: notFound("No such author");
			}
			return {
				status: 200,
				body: mutant === "read-returns-other" ? { ...author, id: randomUUID() } : author,
			};
		},
		Authors_update: (_ctx, input) => {
			const author = authors.get(String(input["authorId"]));
			if (author === undefined) return notFound("No such author");
			if (mutant !== "update-ignores-patch") {
				if (typeof input["name"] === "string") author.name = input["name"];
				if (typeof input["bio"] === "string") author.bio = input["bio"];
			}
			return { status: 200, body: author };
		},
		Authors_delete: (_ctx, input) => {
			const id = String(input["authorId"]);
			if (!authors.delete(id)) return notFound("No such author");
			books.delete(id);
			return { status: 204 };
		},
		Books_create: (_ctx, input) => {
			const shelf = books.get(String(input["authorId"]));
			if (shelf === undefined) return notFound("No such author");
			const book: Book = {
				id: randomUUID(),
				title: String(input["title"]),
				pages: Number(input["pages"]),
			};
			shelf.set(book.id, book);
			return {
				status: 201,
				body: book,
				headers: { location: `/v1/authors/${String(input["authorId"])}/books/${book.id}` },
			};
		},
		Books_list: (_ctx, input) => {
			const shelf = books.get(String(input["authorId"]));
			if (shelf === undefined) return notFound("No such author");
			return { status: 200, body: [...shelf.values()] };
		},
		Books_read: (_ctx, input) => {
			const book = books.get(String(input["authorId"]))?.get(String(input["bookId"]));
			return book === undefined ? notFound("No such book") : { status: 200, body: book };
		},
		Books_delete: (_ctx, input) => {
			const shelf = books.get(String(input["authorId"]));
			if (shelf === undefined || !shelf.delete(String(input["bookId"])))
				return notFound("No such book");
			return { status: 204 };
		},
	};
}

/** The rewrite a mutant serving a body the spec forbids applies; none for any other mutant. */
export function bookshopRewrite(mutant: Mutant): RewriteBody | undefined {
	const on =
		(
			method: string,
			path: RegExp,
			status: number,
			change: (body: Record<string, unknown>) => unknown,
		): RewriteBody =>
		(request, served, body) =>
			request.method === method && path.test(request.path) && served === status
				? change({ ...(body as Record<string, unknown>) })
				: body;
	switch (mutant) {
		case "create-omits-id":
			return on("POST", /^\/v1\/authors$/, 201, (author) => {
				delete author["id"];
				return author;
			});
		case "create-numeric-id":
			return on("POST", /^\/v1\/authors$/, 201, (author) => ({ ...author, id: 7 }));
		case "list-returns-object":
			return on("GET", /^\/v1\/authors$/, 200, () => ({ items: {} }));
		case "bare-list-returns-object":
			return on("GET", /^\/v1\/authors\/[^/]+\/books$/, 200, () => ({}));
		case "read-returns-malformed":
			return on("GET", /^\/v1\/authors\/[^/]+$/, 200, (author) => ({ ...author, name: 5 }));
		default:
			return undefined;
	}
}
