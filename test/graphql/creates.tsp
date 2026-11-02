import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * Books, whose create answers the book or, accepted for later, the import job making it: two
 * resources from one create, each with an `id`. Shelves, created by a create and by an import, and
 * deleted once, so the REST folders keep the shelf the create made.
 */
@service(#{ title: "Bookshop" })
namespace Bookshop;

model Book {
  @visibility(Lifecycle.Read) id: string;
  title: string;
}

model ImportJob {
  @visibility(Lifecycle.Read) id: string;
  state: string;
}

model Shelf {
  @visibility(Lifecycle.Read) id: string;
  label: string;
}

@route("/books")
interface Books {
  @post create(@body book: Book): {
    @statusCode _: 201;
    @body body: Book;
  } | {
    @statusCode _: 202;
    @body job: ImportJob;
  };
  @route("/{bookId}") @get read(@path bookId: string): Book;
  @route("/{bookId}") @delete delete(@path bookId: string): { @statusCode _: 204 };
}

@route("/shelves")
interface Shelves {
  @sharedRoute @post create(@body shelf: Shelf): { @statusCode _: 201; @body body: Shelf };
  @sharedRoute @post importShelf(@body source: { url: string }): {
    @statusCode _: 201;
    @body body: Shelf;
  };
  @route("/{shelfId}") @get read(@path shelfId: string): Shelf;
  @route("/{shelfId}") @delete delete(@path shelfId: string): { @statusCode _: 204 };
}

@@queryField(Books.read, "book");
@@mutationField(Books.create, "createBook");
@@queryField(Shelves.read, "shelf");
@@mutationField(Shelves.create, "createShelf");
@@mutationField(Shelves.importShelf, "importShelf");
