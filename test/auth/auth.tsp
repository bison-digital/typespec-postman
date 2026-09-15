import "@typespec/http";

using Http;

/** Auth declared at every level the spec allows, and every scheme kind. */
@service(#{ title: "Auth" })
@useAuth(BearerAuth)
namespace AuthFixture;

/** The key issued to a shop. */
model ShopKey is ApiKeyAuth<ApiKeyLocation.header, "X-Shop-Key">;
model QueryKey is ApiKeyAuth<ApiKeyLocation.query, "key">;
model SessionCookie is ApiKeyAuth<ApiKeyLocation.cookie, "session">;
model Signature {
  type: AuthType.http;
  scheme: "Signature";
}
model Flow {
  type: OAuth2FlowType.clientCredentials;
  tokenUrl: "https://example.com/token";
  scopes: [];
}

/** Inherits the service's bearer auth. */
@route("/inherited") @get op inherited(): void;

/** Open to anyone. */
@route("/open") @useAuth(NoAuth) @get op open(): void;

/** Anonymous access is also allowed, so the credential is still sent. */
@route("/optional") @useAuth(NoAuth | BearerAuth) @get op optional(): void;

/** The bearer token and an API key, together. */
@route("/both") @useAuth([BearerAuth, ShopKey]) @get op both(): void;

/** Two API keys, together: the first is the auth object, the second a header. */
@route("/keys") @useAuth([ShopKey, QueryKey]) @get op keys(): void;

@route("/cookie") @useAuth(SessionCookie) @get op cookie(): void;

@route("/signed") @useAuth(Signature) @get op signed(): void;

@route("/two-authorizations") @useAuth([BearerAuth, BasicAuth]) @get op twoAuthorizations(): void;

@route("/oauth") @useAuth(OAuth2Auth<[Flow]>) @get op oauth(): void;

/** Every operation here takes an API key instead. */
@route("/keyed")
@useAuth(ShopKey)
interface Keyed {
  @get read(): void;

  /** Back to bearer for this one. */
  @useAuth(BearerAuth) @post write(): void;

  @useAuth(BasicAuth) @delete remove(): void;
}
