import "@typespec/http";

using Http;

/** A soft-only conflict between two folders: X -> Y carries two soft edges, Y -> X one; Y is declared first. */
@service(#{ title: "WeightedSoft" })
namespace WeightedSoft;

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

model P { @format("uuid") id: string; }
model Q { @format("uuid") id: string; }

@route("/p") @post op createP(@body p: P): Created<P>;
@route("/q") @post op createQ(@body q: Q): Created<Q>;

interface Y {
  @route("/q/{qId}") @delete removeQ(@path @format("uuid") qId: string): void;
  @route("/y/{pId}") @get useP(@path @format("uuid") pId: string): void;
}

interface X {
  @route("/p/{pId}") @delete removeP(@path @format("uuid") pId: string): void;
  @route("/x1/{qId}") @get useQ1(@path @format("uuid") qId: string): void;
  @route("/x2/{qId}") @get useQ2(@path @format("uuid") qId: string): void;
}
