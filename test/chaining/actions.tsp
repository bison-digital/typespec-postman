import "@typespec/http";

using Http;

/**
 * Methods on an existing book, declared before the book's create and after it, each answering the
 * book: one under the book's item route, one under a deeper item route below it, a clone that
 * answers 201, and one in AIP-136's own `{bookId}:publish` form, beside an `{bookId}:export` that
 * answers a job. A create, answering 200, under another resource's item route. Shelves, which nothing
 * reads, with a method under the item route their create implies; racks, which nothing creates or
 * reads, with two methods whose path parameter is named as the rack's own variable; and desks, whose
 * method is declared before the read that declares its item route. Creates the fallback must leave
 * alone: one under an entry whose parameter is named as the note's variable, one under a queue whose
 * `ticketId` carries text rather than a ticket's number, and one under a format, read at a route
 * whose parameter is no edition's key.
 */
@service(#{ title: "Bookshop" })
namespace Bookshop;

model Book {
  @key @visibility(Lifecycle.Read) id: string;
  title: string;
}

model Author {
  @key @visibility(Lifecycle.Read) id: string;
  name: string;
}

model Review {
  @key @visibility(Lifecycle.Read) id: string;
  rating: int32;
}

model Shelf {
  @key @visibility(Lifecycle.Read) id: string;
  label: string;
}

model Rack {
  @key @visibility(Lifecycle.Read) id: string;
  locked: boolean;
}

model Desk {
  @key @visibility(Lifecycle.Read) id: string;
  locked: boolean;
}

model Job {
  @key @visibility(Lifecycle.Read) id: string;
  status: string;
}

model Entry {
  @key @visibility(Lifecycle.Read) id: string;
  label: string;
}

model Note {
  @key @visibility(Lifecycle.Read) id: string;
  text: string;
}

model Ticket {
  @key @visibility(Lifecycle.Read) id: int32;
  subject: string;
}

model Edition {
  @key @visibility(Lifecycle.Read) id: int64;
  format: string;
}

@route("/books")
interface Books {
  /** A method on an existing book (AIP-136), declared ahead of the create: it answers the book. */
  @route("/{bookId}/archive") @post archive(@path bookId: string): Book;

  /** A method below a deeper item route, under the book's: it credits an author on the book. */
  @route("/{bookId}/authors/{authorId}/credit") @post credit(
    @path bookId: string,
    @path authorId: string,
  ): Book;

  /** A method that answers a new book: a clone, `201`, declared ahead of the create. */
  @route("/{bookId}/clone") @post clone(@path bookId: string): {
    @statusCode _: 201;
    @header location: string;
    @body book: Book;
  };

  @post create(@body body: { title: string }): {
    @statusCode _: 201;
    @header location: string;
    @body book: Book;
  };

  @route("/{bookId}") @get read(@path bookId: string): Book;

  /** A method on an existing book, declared after the create. */
  @route("/{bookId}/feature") @post feature(@path bookId: string): Book;

  /** AIP-136's own spelling of a method, after the book's id: `:publish`. */
  @route("/{bookId}:publish") @post publish(@path bookId: string): Book;

  /** A method in that spelling answering a job, not the book: it creates no job. */
  @route("/{bookId}:export") @post export(@path bookId: string): {
    @statusCode _: 202;
    @body job: Job;
  };
}

@route("/jobs")
interface Jobs {
  @route("/{jobId}") @get read(@path jobId: string): Job;
}

@route("/authors")
interface Authors {
  @post create(@body body: { name: string }): {
    @statusCode _: 201;
    @header location: string;
    @body author: Author;
  };
  @route("/{authorId}") @get read(@path authorId: string): Author;
}

/** A create under an author's item route, which answers 200: a review is created, not a method. */
@route("/authors/{authorId}/reviews")
interface AuthorReviews {
  @post create(@path authorId: string, @body body: { rating: int32 }): Review;
}

/** Shelves have no read: their create's route implies the item route the method is under. */
@route("/shelves")
interface Shelves {
  @post create(@body body: { label: string }): {
    @statusCode _: 201;
    @body shelf: Shelf;
  };
  @route("/{id}/lock") @post lock(@path id: string): Shelf;
}

/** Racks have no create and no read: only methods, whose parameter is named `rackId`. */
@route("/racks")
interface Racks {
  @route("/{rackId}/lock") @post lock(@path rackId: string): Rack;
  @route("/{rackId}/unlock") @post unlock(@path rackId: string): Rack;
}

/** Desks have no create: a method declared before the read whose route it is under, named `id`. */
@route("/desks")
interface Desks {
  @route("/{id}/lock") @post lock(@path id: string): Desk;
  @route("/{id}") @get read(@path id: string): Desk;
}

/** Entries are read by an id named `noteId`: a note created under one is a create. */
@route("/entries")
interface Entries {
  @post create(@body body: { label: string }): {
    @statusCode _: 201;
    @body entry: Entry;
  };
  @route("/{noteId}") @get read(@path noteId: string): Entry;
}

@route("/entries/{noteId}/notes")
interface EntryNotes {
  @post create(@path noteId: string, @body body: { text: string }): {
    @statusCode _: 201;
    @body note: Note;
  };
}

/** A queue named by text in a parameter called `ticketId`: no ticket's id, so the ticket is created. */
@route("/queues/{ticketId}/tickets")
interface QueueTickets {
  @post create(@path ticketId: string, @body body: { subject: string }): {
    @statusCode _: 201;
    @body ticket: Ticket;
  };
}

/** A format's featured edition is read by the format's name: no edition's item route. */
@route("/formats/{format}")
interface Formats {
  @get featured(@path format: string): Edition;
  @route("/editions") @post create(@path format: string, @body body: { note: string }): {
    @statusCode _: 201;
    @body edition: Edition;
  };
}
