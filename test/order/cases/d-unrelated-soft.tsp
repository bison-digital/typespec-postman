import "@typespec/http";

using Http;

/** A stuck level (Tags/Labels) plus a soft edge peek -> Quarry.remove that the stuck point need not give up. */
@service(#{ title: "UnrelatedSoft" })
namespace UnrelatedSoft;

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

model Tag { @format("uuid") id: string; }
model Label { @format("uuid") id: string; }
model Stone { @format("uuid") id: string; }

@route("/tags")
interface Tags {
  @post create(@body tag: Tag): Created<Tag>;
  @route("/{tagId}") @delete remove(@path @format("uuid") tagId: string): void;
  @route("/by-label/{labelId}") @get byLabel(@path @format("uuid") labelId: string): void;
}

@route("/labels")
interface Labels {
  @post create(@body label: Label): Created<Label>;
  @route("/{labelId}") @delete remove(@path @format("uuid") labelId: string): void;
  @route("/by-tag/{tagId}") @get byTag(@path @format("uuid") tagId: string): void;
}

@route("/stones")
interface Quarry {
  @route("/{stoneId}") @delete remove(@path @format("uuid") stoneId: string): void;
}

@route("/stones") @post op createStone(@body stone: Stone): Created<Stone>;

@route("/peek/{tagId}/{stoneId}") @get op peek(@path @format("uuid") tagId: string, @path @format("uuid") stoneId: string): void;
