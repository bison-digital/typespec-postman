import "@typespec/http";

using Http;

/** The bookstore's public catalogue. */
@service(#{ title: "Folders" })
namespace FoldersFixture;

@route("/status") @get op status(): void;

/** Everything a shopper browses. */
@route("/catalogue")
interface Catalogue {
  @summary("Browse the catalogue")
  @get browse(): void;
}

namespace Admin {
  @route("/admin/reindex") @post op reindex(): void;

  @route("/admin/users")
  interface Users {
    @get list(): void;
  }
}
