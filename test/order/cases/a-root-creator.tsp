import "@typespec/http";

using Http;

/** A shelf created and deleted by root operations; consumed inside interfaces. */
@service(#{ title: "RootCreator" })
namespace RootCreator;

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

model Shelf { @format("uuid") id: string; }
model Book { @format("uuid") id: string; }

@route("/shelves/{shelfId}") @delete op removeShelf(@path @format("uuid") shelfId: string): void;

@route("/shelves/{shelfId}/books")
interface Books {
  @route("/{bookId}") @delete remove(@path @format("uuid") shelfId: string, @path @format("uuid") bookId: string): void;
  @route("/{bookId}") @get read(@path @format("uuid") shelfId: string, @path @format("uuid") bookId: string): Book;
  @post create(@path @format("uuid") shelfId: string, @body book: Book): Created<Book>;
}

@route("/audit")
interface Audit {
  @route("/{shelfId}") @get check(@path @format("uuid") shelfId: string): void;
}

@route("/shelves") @post op createShelf(@body shelf: Shelf): Created<Shelf>;
@route("/shelves/{shelfId}") @get op readShelf(@path @format("uuid") shelfId: string): Shelf;
