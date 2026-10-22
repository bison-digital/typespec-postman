import "@typespec/http";

using Http;

@service(#{ title: "Parameters" })
namespace ParametersFixture;

@route("/items/{id}") @get op simple(@path id: int32): void;

@route("/labels") @get op label(@path(#{ style: "label" }) color: string): void;

@route("/matrix") @get op matrix(@path(#{ style: "matrix" }) color: string): void;

@route("/files") @get op reserved(@path(#{ allowReserved: true }) path: string): void;

@route("/optional") @get op optionalSegment(@path segment?: string): void;

@route("/search") @get op search(
  @query term: string,
  @query limit?: int32,
  @query(#{ explode: true }) tags: string[],
  @query colors: string[],
): void;

@opExample(#{ parameters: #{ term: "bridges", limit: 5, tags: #["a", "b"], colors: #["red", "blue"] } })
@route("/examples") @get op exampled(
  @query term: string,
  @query limit?: int32,
  @query(#{ explode: true }) tags: string[],
  @query colors: string[],
): void;

@route("/bounded") @get op bounded(@query @minValue(10) @maxValue(20) page: int32, @query @minLength(5) code: string): void;

@route("/formats/{id}") @get op formats(@path @format("uuid") id: string, @query at: utcDateTime): void;

/** A required record expands to nothing when empty, so it is never generated empty. */
@route("/filters{/by}") @get op pathRecord(by: Record<int32>): void;

@route("/tagged") @get op queryRecord(@query filter: Record<int32>): void;
