import "@typespec/http";

using Http;

/** A hard cycle (Tags/Labels) and a root request that depends on it, declared before it. */
@service(#{ title: "DownstreamOfCycle" })
namespace DownstreamOfCycle;

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

model Tag { @format("uuid") id: string; }
model Label { @format("uuid") id: string; }

@route("/tag-count/{tagId}") @get op tagCount(@path @format("uuid") tagId: string): void;

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
