import { randomUUID } from "node:crypto";
import { fail } from "../support/server.js";

/**
 * In-memory handlers for `example/main.tsp`, the application a deployment check would run against.
 *
 * **Each mutant is one way a server can disagree with its spec**, and `run.test.ts` requires the
 * generated collection to go red on every one. A collection that stays green against a broken server
 * is not checking anything.
 */
export type Mutant =
	| "none"
	| "create-omits-id"
	| "create-numeric-id"
	| "list-returns-object"
	| "bare-list-returns-object"
	| "read-returns-other"
	| "update-ignores-patch";

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

export function bookshopHandlers(
	mutant: Mutant,
): Record<string, (ctx: unknown, input: Input) => unknown> {
	const authors = new Map<string, Author>();
	const books = new Map<string, Map<string, Book>>();
	return {
		health: () => ({ status: "ok" }),
		Authors_create: (_ctx, input) => {
			const author: Author = { id: randomUUID(), name: String(input["name"]) };
			if (typeof input["bio"] === "string") author.bio = input["bio"];
			authors.set(author.id, author);
			books.set(author.id, new Map());
			if (mutant === "create-omits-id")
				return { name: author.name, location: `/v1/authors/${author.id}` };
			if (mutant === "create-numeric-id")
				return { ...author, id: 7, location: `/v1/authors/${author.id}` };
			return { ...author, location: `/v1/authors/${author.id}` };
		},
		Authors_list: () =>
			mutant === "list-returns-object" ? { items: {} } : { items: [...authors.values()] },
		Authors_read: (_ctx, input) => {
			const author = authors.get(String(input["authorId"]));
			if (author === undefined) return fail(404, "No such author");
			return mutant === "read-returns-other" ? { ...author, id: randomUUID() } : author;
		},
		Authors_update: (_ctx, input) => {
			const author = authors.get(String(input["authorId"]));
			if (author === undefined) return fail(404, "No such author");
			if (mutant !== "update-ignores-patch") {
				if (typeof input["name"] === "string") author.name = input["name"];
				if (typeof input["bio"] === "string") author.bio = input["bio"];
			}
			return author;
		},
		Authors_delete: (_ctx, input) => {
			const id = String(input["authorId"]);
			if (!authors.delete(id)) return fail(404, "No such author");
			books.delete(id);
			return undefined;
		},
		Books_create: (_ctx, input) => {
			const shelf = books.get(String(input["authorId"]));
			if (shelf === undefined) return fail(404, "No such author");
			const book: Book = {
				id: randomUUID(),
				title: String(input["title"]),
				pages: Number(input["pages"]),
			};
			shelf.set(book.id, book);
			return { ...book, location: `/v1/authors/${String(input["authorId"])}/books/${book.id}` };
		},
		Books_list: (_ctx, input) => {
			const shelf = books.get(String(input["authorId"]));
			if (shelf === undefined) return fail(404, "No such author");
			return mutant === "bare-list-returns-object" ? {} : [...shelf.values()];
		},
		Books_read: (_ctx, input) => {
			const book = books.get(String(input["authorId"]))?.get(String(input["bookId"]));
			return book ?? fail(404, "No such book");
		},
		Books_delete: (_ctx, input) => {
			const shelf = books.get(String(input["authorId"]));
			if (shelf === undefined || !shelf.delete(String(input["bookId"])))
				return fail(404, "No such book");
			return undefined;
		},
	};
}
