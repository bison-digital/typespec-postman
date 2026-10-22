import "@typespec/http";

using Http;

/** A hard cycle where one direction carries two edges and the other one; the heavier side is declared second. */
@service(#{ title: "WeightedCycle" })
namespace WeightedCycle;

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

model Tag { @format("uuid") id: string; }
model Label { @format("uuid") id: string; }

@route("/labels")
interface Labels {
  @post create(@body label: Label): Created<Label>;
  @route("/by-tag/{tagId}") @get byTag(@path @format("uuid") tagId: string): void;
  @route("/by-tag/{tagId}/count") @get countByTag(@path @format("uuid") tagId: string): void;
}

@route("/tags")
interface Tags {
  @post create(@body tag: Tag): Created<Tag>;
  @route("/by-label/{labelId}") @get byLabel(@path @format("uuid") labelId: string): void;
}
