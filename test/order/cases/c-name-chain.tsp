import "@typespec/http";

using Http;

/** C consumes B's resource and B consumes A's, by parameter name only; declared C, B, A. */
@service(#{ title: "NameChain" })
namespace NameChain;

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

model Alpha { @format("uuid") id: string; }
model Beta { @format("uuid") id: string; }
model Gamma { @format("uuid") id: string; }

@route("/c")
interface Gammas {
  @route("/under/{betaId}/items/{gammaId}") @delete remove(@path @format("uuid") betaId: string, @path @format("uuid") gammaId: string): void;
  @route("/under/{betaId}/items") @post create(@path @format("uuid") betaId: string, @body gamma: Gamma): Created<Gamma>;
}

@route("/b")
interface Betas {
  @route("/under/{alphaId}/items/{betaId}") @delete remove(@path @format("uuid") alphaId: string, @path @format("uuid") betaId: string): void;
  @route("/under/{alphaId}/items/{betaId}") @get read(@path @format("uuid") alphaId: string, @path @format("uuid") betaId: string): Beta;
  @route("/under/{alphaId}/items") @post create(@path @format("uuid") alphaId: string, @body beta: Beta): Created<Beta>;
}

@route("/a")
interface Alphas {
  @route("/{alphaId}") @delete remove(@path @format("uuid") alphaId: string): void;
  @post create(@body alpha: Alpha): Created<Alpha>;
}
