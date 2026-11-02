import "@typespec/http";
import "typespec-http-graphql";

using Http;
using HttpGraphQL;

/**
 * Shelves, whose create answers no body but the `Location` of the shelf it created, and books, whose
 * create answers the book: a resource a create mutation's answer cannot name, and one it can. Reviews,
 * whose create answers the review or, accepted for later, only its `Location`: one success member
 * that names it and one that does not. Books and reviews are deleted; shelves are not.
 */
@service(#{ title: "Bookshop" })
namespace Bookshop;

model Shelf {
  @visibility(Lifecycle.Read) id: string;
  label: string;
}

model Book {
  @visibility(Lifecycle.Read) id: string;
  title: string;
}

model Review {
  @visibility(Lifecycle.Read) id: string;
  rating: int32;
}

@route("/shelves")
interface Shelves {
  @post create(@body shelf: Shelf): {
    @statusCode _: 201;
    @header location: string;
  };
  @route("/{shelfId}") @get read(@path shelfId: string): Shelf;
}

@route("/books")
interface Books {
  @post create(@body book: Book): {
    @statusCode _: 201;
    @body body: Book;
  };
  @route("/{bookId}") @get read(@path bookId: string): Book;
  @route("/{bookId}") @delete delete(@path bookId: string): { @statusCode _: 204 };
}

@route("/reviews")
interface Reviews {
  @post create(@body review: Review): {
    @statusCode _: 201;
    @body body: Review;
  } | {
    @statusCode _: 202;
    @header location: string;
  };
  @route("/{reviewId}") @get read(@path reviewId: string): Review;
  @route("/{reviewId}") @delete delete(@path reviewId: string): { @statusCode _: 204 };
}

@@queryField(Shelves.read, "shelf");
@@mutationField(Shelves.create, "createShelf");
@@queryField(Books.read, "book");
@@mutationField(Books.create, "createBook");
@@queryField(Reviews.read, "review");
@@mutationField(Reviews.create, "createReview");
