import "@typespec/http";
import "@typespec/versioning";
import "typespec-http-graphql";

using Http;
using Versioning;
using HttpGraphQL;

/**
 * A library's shelves and racks, at its latest version: two interfaces from one template, each with
 * its own auth, a renamed and a removed property, an operation added, and two sharing a route.
 */
@service(#{ title: "Library" })
@versioned(Versions)
@server("{endpoint}", "The library", { endpoint: string = "http://localhost:8080" })
namespace VersionedFixture;

enum Versions {
  v1,
  v2,
}

@error
model NotFound {
  @statusCode _: 404;
  title: string;
}

model Shelf {
  @visibility(Lifecycle.Read) id: string;
  @renamedFrom(Versions.v2, "label") name: string;
  @removed(Versions.v2) colour?: string;
}

model Rack {
  @visibility(Lifecycle.Read) id: string;
  size: int32;
}

interface Crud<T> {
  @post create(@body item: T): {
    @statusCode _: 201;
    @body body: T;
  };
  @route("/{id}") @get read(@path id: string): T | NotFound;
}

@route("/shelves")
@useAuth(BearerAuth)
interface Shelves extends Crud<Shelf> {}

@route("/racks")
@useAuth(ApiKeyAuth<ApiKeyLocation.header, "X-Rack-Key">)
interface Racks extends Crud<Rack> {}

@added(Versions.v2)
@route("/search")
@sharedRoute
@get
op searchShelves(@query name: string): Shelf[];

@route("/search")
@sharedRoute
@get
op searchRacks(@query size: int32): Rack[];

@@queryField(Shelves.read, "shelf");
@@queryField(Racks.read, "rack");
@@queryField(searchShelves, "searchShelves");
@@queryField(searchRacks, "searchRacks");
@@mutationField(Shelves.create, "createShelf");
