import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type Compiled,
	codes,
	compileFixture,
	type PostmanCollection,
	requestNamed,
	scriptOf,
} from "../support/compile.js";

/**
 * **A POST under a resource's own item route is a method on it** (`actions.tsp`), AIP-136's custom
 * method spelled with a path segment: `POST /books/{bookId}/archive` answering the book creates no
 * book, so it reads `{{bookId}}` rather than claiming it, wherever it is declared, below a deeper
 * item route as well, and whatever it answers, a clone's `201` included. A create under another
 * resource's item route, `POST /authors/{authorId}/reviews`, is still a create.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
let compiled: Compiled;
let collection: PostmanCollection;

beforeAll(async () => {
	compiled = await compileFixture(here, "actions", { outName: "actions" });
	collection = compiled.collection();
}, 180_000);

const capturesOf = (name: string, folder: string) =>
	scriptOf(requestNamed(collection, name, folder)).filter((line) =>
		line.includes("collectionVariables.set"),
	);

describe("a method on an existing resource", () => {
	it("claims no variable, so nothing collides with the resource's own create", () => {
		expect(codes(compiled)).not.toContain("typespec-postman/variable-collision");
		expect((collection.variable ?? []).map((variable) => variable.key)).toEqual([
			"baseUrl",
			"bookId",
			"authorId",
			"reviewId",
			"shelfId",
			"entryId",
			"noteId",
			"ticketId",
			"editionId",
			"jobId",
			"deskId",
		]);
	});

	it("leaves the create its capture, and reads the id the create set, declared before it or after", () => {
		expect(capturesOf("create", "Books")).toEqual([
			'pm.collectionVariables.set("bookId", pm.response.json()["id"]);',
		]);
		for (const method of ["archive", "feature", "clone"]) {
			expect(capturesOf(method, "Books"), method).toEqual([]);
			expect(requestNamed(collection, method, "Books").request?.url.path, method).toEqual([
				"books",
				"{{bookId}}",
				method,
			]);
		}
		expect(capturesOf("publish", "Books")).toEqual([]);
		expect(requestNamed(collection, "publish", "Books").request?.url.raw).toBe(
			"{{baseUrl}}/books/{{bookId}}:publish",
		);
		expect(capturesOf("credit", "Books")).toEqual([]);
		expect(requestNamed(collection, "credit", "Books").request?.url.path).toEqual([
			"books",
			"{{bookId}}",
			"authors",
			"{{authorId}}",
			"credit",
		]);
	});

	it("runs after the create, so the id it reads is set", () => {
		const books = collection.item
			.find((item) => item.name === "Books")
			?.item?.map((item) => item.name);
		for (const method of ["archive", "credit", "clone", "feature", "publish"]) {
			expect(books?.indexOf("create"), method).toBeLessThan(books?.indexOf(method) ?? -1);
		}
	});
});

describe("a create under another resource's item route", () => {
	it("is a create, setting its own variable", () => {
		expect(capturesOf("create", "AuthorReviews")).toEqual([
			'pm.collectionVariables.set("reviewId", pm.response.json()["id"]);',
		]);
	});
});

describe("a method on a resource with no read", () => {
	it("is under the item route its create implies, and reads the id the create set", () => {
		expect(capturesOf("lock", "Shelves")).toEqual([]);
		expect(requestNamed(collection, "lock", "Shelves").request?.url.path).toEqual([
			"shelves",
			"{{shelfId}}",
			"lock",
		]);
	});
});

describe("methods on a resource with no create and no read", () => {
	it("claim nothing, their parameter named as the resource's variable, and send the id as supplied", () => {
		for (const method of ["lock", "unlock"]) {
			expect(capturesOf(method, "Racks"), method).toEqual([]);
			expect(requestNamed(collection, method, "Racks").request?.url.path, method).toEqual([
				"racks",
				":rackId",
				method,
			]);
		}
		expect(codes(compiled)).toEqual([]);
	});
});

describe("a method declared before the read that declares its item route", () => {
	it("is under that route, though its parameter is not named as the resource's variable", () => {
		expect(capturesOf("lock", "Desks")).toEqual([]);
	});
});

describe("AIP-136's `:verb` answering another model", () => {
	it("creates nothing, and sends the id of the resource it acts on", () => {
		expect(capturesOf("export", "Books")).toEqual([]);
		expect(requestNamed(collection, "export", "Books").request?.url.raw).toBe(
			"{{baseUrl}}/books/{{bookId}}:export",
		);
	});
});

describe("a create the name of a path parameter does not make a method", () => {
	it("is a create where that parameter is another model's id, the item route of an entry", () => {
		expect(capturesOf("create", "EntryNotes")).toEqual([
			'pm.collectionVariables.set("noteId", pm.response.json()["id"]);',
		]);
	});

	it("is a create where that parameter carries another kind of value than the key", () => {
		expect(capturesOf("create", "QueueTickets")).toEqual([
			'pm.collectionVariables.set("ticketId", pm.response.json()["id"]);',
		]);
	});

	it("is a create under a read whose parameter is no key of the model it answers", () => {
		expect(capturesOf("create", "Formats")).toEqual([
			'pm.collectionVariables.set("editionId", pm.response.json()["id"]);',
		]);
	});
});
