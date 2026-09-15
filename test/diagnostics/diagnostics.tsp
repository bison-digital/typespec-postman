import "@typespec/http";

using Http;

/** The refusals no other fixture raises. */
@service(#{ title: "Diagnostics" })
@server("{shopKey}", "A server variable named like a credential", { shopKey: string })
namespace DiagnosticsFixture;

model ShopKey is ApiKeyAuth<ApiKeyLocation.header, "X-Shop-Key">;

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

namespace Store {
  model Item { @format("uuid") id: string; }

  @route("/store/items") @useAuth(ShopKey) @post op create(@body item: Item): Created<Item>;
}

namespace Warehouse {
  model Item { @format("uuid") id: string; }

  @route("/warehouse/items") @post op create(@body item: Item): Created<Item>;
}

@opExample(#{ parameters: #{ since: utcDateTime.now() } })
@route("/changes") @get op changes(@query since: utcDateTime): void;
