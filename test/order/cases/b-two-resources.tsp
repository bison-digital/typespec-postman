import "@typespec/http";

using Http;

/** Loans consumes a book and a member, each created and deleted in its own folder. */
@service(#{ title: "TwoResources" })
namespace TwoResources;

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

model Book { @format("uuid") id: string; }
model Member { @format("uuid") id: string; }

@route("/loans")
interface Loans {
  @route("/{bookId}/{memberId}") @put lend(@path @format("uuid") bookId: string, @path @format("uuid") memberId: string): void;
  @route("/{bookId}/{memberId}") @get status(@path @format("uuid") bookId: string, @path @format("uuid") memberId: string): void;
}

@route("/books")
interface Books {
  @route("/{bookId}") @delete remove(@path @format("uuid") bookId: string): void;
  @post create(@body book: Book): Created<Book>;
  @route("/{bookId}") @get read(@path @format("uuid") bookId: string): Book;
}

@route("/members")
interface Members {
  @route("/{memberId}") @delete remove(@path @format("uuid") memberId: string): void;
  @post create(@body member: Member): Created<Member>;
}
