import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * A bookshop served over GraphQL beside REST: authors, and the books each has written, a book's id a
 * number, a read with an enum filter, and a delete open to anyone.
 */
@service(#{ title: "Bookshop" })
@server("{endpoint}", "The bookshop", { endpoint: string = "http://localhost:8080" })
@useAuth(BearerAuth)
namespace GraphQLFixture;

enum Format {
  hardback,
  paperback,
  ebook: "e-book",
}

model Author {
  @visibility(Lifecycle.Read) id: string;
  @minLength(1) name: string;
}

model Book {
  @visibility(Lifecycle.Read) id: int32;
  @minLength(1) title: string;
  format: Format;
}

@error
model NotFound {
  @statusCode _: 404;
  title: string;
}

@route("/authors")
interface Authors {
  @post create(@body author: Author): {
    @statusCode _: 201;
    @body body: Author;
  };
  @route("/{authorId}") @get read(@path authorId: string): Author | NotFound;
  @route("/{authorId}") @delete @useAuth(NoAuth) delete(@path authorId: string): {
    @statusCode _: 204;
  } | NotFound;
}

@route("/authors/{authorId}/books")
interface Books {
  @post create(@path authorId: string, @body book: Book): {
    @statusCode _: 201;
    @body body: Book;
  };
  @route("/{bookId}") @get read(@path authorId: string, @path bookId: int32, @query format?: Format):
    | Book
    | NotFound;
}

@@queryField(Authors.read, "author");
@@queryField(Books.read, "book");
@@mutationField(Authors.create, "createAuthor");
@@mutationField(Authors.delete, "deleteAuthor");
