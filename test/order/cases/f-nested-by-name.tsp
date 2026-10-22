import "@typespec/http";

using Http;

/** Books nests inside Authors; Authors also holds a request that consumes a book by name. */
@service(#{ title: "NestedByName" })
namespace NestedByName;

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

model Author { @format("uuid") id: string; }
model Book { @format("uuid") id: string; }

@route("/authors")
interface Authors {
  @post create(@body author: Author): Created<Author>;
  @route("/by-book/{bookId}") @get byBook(@path @format("uuid") bookId: string): void;
  @route("/{authorId}") @get read(@path @format("uuid") authorId: string): Author;
  @route("/{authorId}") @delete remove(@path @format("uuid") authorId: string): void;
}

@route("/authors/{authorId}/books")
interface Books {
  @post create(@path @format("uuid") authorId: string, @body book: Book): Created<Book>;
  @route("/{bookId}") @get read(@path @format("uuid") authorId: string, @path @format("uuid") bookId: string): Book;
  @route("/{bookId}") @delete remove(@path @format("uuid") authorId: string, @path @format("uuid") bookId: string): void;
}
