import "@typespec/http";

using Http;

/** Declared in the wrong order on purpose: every consumer before what it consumes. */
@service(#{ title: "Order" })
namespace OrderFixture;

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

model Shelf { @format("uuid") id: string; }
model Book { @format("uuid") id: string; }
model Tag { @format("uuid") id: string; }

@route("/shelves/{shelfId}/books")
interface Books {
  @route("/{bookId}") @delete remove(@path @format("uuid") shelfId: string, @path @format("uuid") bookId: string): void;
  @route("/{bookId}") @get read(@path @format("uuid") shelfId: string, @path @format("uuid") bookId: string): Book;
  @post create(@path @format("uuid") shelfId: string, @body book: Book): Created<Book>;
}

@route("/shelves")
interface Shelves {
  @route("/{shelfId}") @delete remove(@path @format("uuid") shelfId: string): void;
  @route("/{shelfId}") @get read(@path @format("uuid") shelfId: string): Shelf;
  @get list(): Shelf[];
  @post create(@body shelf: Shelf): Created<Shelf>;
}

/** Consumes a shelf by name without being nested under it. */
@route("/audit/{shelfId}") @get op audit(@path @format("uuid") shelfId: string): void;

/** Tags and labels consume each other and both delete: no order satisfies both. */
@route("/tags")
interface Tags {
  @post create(@body tag: Tag): Created<Tag>;
  @route("/{tagId}") @delete remove(@path @format("uuid") tagId: string): void;
  @route("/by-label/{labelId}") @get byLabel(@path @format("uuid") labelId: string): void;
}

model Label { @format("uuid") id: string; }

@route("/labels")
interface Labels {
  @post create(@body label: Label): Created<Label>;
  @route("/{labelId}") @delete remove(@path @format("uuid") labelId: string): void;
  @route("/by-tag/{tagId}") @get byTag(@path @format("uuid") tagId: string): void;
}
