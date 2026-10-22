import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * A bookshop's corners: a shared route whose operations each require their own query parameter, a
 * read of one resource chained to another's id by name, and an interface named like the GraphQL
 * folder.
 */
@service(#{ title: "Corners" })
@server("{endpoint}", "The bookshop", { endpoint: string = "http://localhost:8080" })
namespace Corners {
  model Author {
    @visibility(Lifecycle.Read) @key id: string;
    name: string;
  }

  model Profile {
    authorId: string;
    bio: string;
  }

  model Book {
    id: string;
    title: string;
  }

  @error
  model NotFound {
    @statusCode _: 404;
    message: string;
  }

  @route("/authors")
  interface Authors {
    @post create(@body author: Author): { @statusCode _: 201; @body body: Author };
    @route("/{authorId}") @get read(@path authorId: string): Author | NotFound;
    @route("/{authorId}") @delete delete(@path authorId: string): { @statusCode _: 204 } | NotFound;
  }

  /** A profile, at its author's id, though not under the author's route. */
  @route("/profiles")
  interface Profiles {
    @route("/{authorId}") @get read(@path authorId: string): Profile | NotFound;
  }

  @route("/search")
  interface Search {
    @sharedRoute @get byTitle(@query title: string): Book[];
    @sharedRoute @get byAuthor(@query author: string): Book[];
  }

  /** The schema a GraphQL client reads, documented as a REST route. */
  @route("/graphql-schema")
  interface graphql {
    @get read(): { schema: string };
  }
}

/** A second service, so a setting shared by every service is checked once. */
@service(#{ title: "Corners admin" })
namespace CornersAdmin {
  @route("/status")
  interface Status {
    @get read(): { up: boolean };
  }
}

@@queryField(Corners.Authors.read, "author");
@@queryField(Corners.Profiles.read, "profile");
@@queryField(Corners.Search.byTitle, "booksByTitle");
@@mutationField(Corners.Authors.delete, "deleteAuthor");
@@queryField(CornersAdmin.Status.read, "status");
