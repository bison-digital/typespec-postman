import "@typespec/http";

using Http;

/**
 * A small bookshop: authors, and the books each author has written.
 *
 * Every construct here is one the emitter derives something from. A templated server with a default,
 * bearer auth on the service with one operation open to anyone, an API key required alongside the
 * bearer token, a required header, read-only ids, a paged list, a resource nested under another, a
 * delete at both levels, and an example on an update.
 */
@service(#{ title: "Bookshop" })
@server("{endpoint}/v1", "The bookshop API", { endpoint: string = "http://localhost:8080" })
@useAuth(BearerAuth)
namespace Bookshop;

/** Required alongside the bearer token by operations that destroy data. */
model ShopKey is ApiKeyAuth<ApiKeyLocation.header, "X-Shop-Key">;

@error
model Invalid {
  @statusCode statusCode: 400;
  title: string;
}

@error
model Unauthorized {
  @statusCode statusCode: 401;
  title: string;
}

@error
model NotFound {
  @statusCode statusCode: 404;
  title: string;
}

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

model Author {
  @visibility(Lifecycle.Read)
  @format("uuid")
  id: string;

  @minLength(1)
  name: string;

  bio?: string;
}

model AuthorPatch {
  name?: string;
  bio?: string;
}

model AuthorPage {
  @pageItems
  items: Author[];

  @continuationToken
  nextPageToken?: string;
}

model Book {
  @visibility(Lifecycle.Read)
  @format("uuid")
  id: string;

  @minLength(1)
  title: string;

  @minValue(1)
  pages: int32;
}

/** Whether the service is up. Open to anyone. */
@useAuth(NoAuth)
@route("/health")
@get
op health(): {
  status: "ok";
};

@route("/authors")
interface Authors {
  /** Add an author. A retried request with the same key creates nothing new. */
  @post
  create(@header("Idempotency-Key") idempotencyKey: string, @body author: Author):
    | Created<Author>
    | Invalid
    | Unauthorized;

  @list
  @get
  list(@query @pageSize limit?: int32, @query @continuationToken pageToken?: string):
    | AuthorPage
    | Unauthorized;

  @route("/{authorId}")
  @get
  read(@path @format("uuid") authorId: string): Author | NotFound | Unauthorized;

  @opExample(#{
    parameters: #{
      authorId: "00000000-0000-0000-0000-000000000000",
      contentType: "application/merge-patch+json",
      patch: #{ bio: "Writes about bridges." },
    },
  })
  @route("/{authorId}")
  @patch(#{ implicitOptionality: false })
  update(
    @path @format("uuid") authorId: string,
    @header contentType: "application/merge-patch+json",
    @body patch: AuthorPatch,
  ): Author | Invalid | NotFound | Unauthorized;

  @route("/{authorId}")
  @delete
  @useAuth([BearerAuth, ShopKey])
  delete(@path @format("uuid") authorId: string): {
    @statusCode statusCode: 204;
  } | NotFound | Unauthorized;
}

@route("/authors/{authorId}/books")
interface Books {
  @post
  create(@path @format("uuid") authorId: string, @body book: Book):
    | Created<Book>
    | Invalid
    | NotFound
    | Unauthorized;

  @get
  list(@path @format("uuid") authorId: string): Book[] | NotFound | Unauthorized;

  @route("/{bookId}")
  @get
  read(@path @format("uuid") authorId: string, @path @format("uuid") bookId: string):
    | Book
    | NotFound
    | Unauthorized;

  @route("/{bookId}")
  @delete
  @useAuth([BearerAuth, ShopKey])
  delete(@path @format("uuid") authorId: string, @path @format("uuid") bookId: string): {
    @statusCode statusCode: 204;
  } | NotFound | Unauthorized;
}
