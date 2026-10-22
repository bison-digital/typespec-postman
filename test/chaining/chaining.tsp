import "@typespec/http";

using Http;

/** Every shape the chaining convention reads, and the ones it must refuse. */
@service(#{ title: "Chaining" })
namespace ChainingFixture;

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

model Author { @format("uuid") id: string; name: string; }
model Book { @format("uuid") id: string; title: string; }
model Project { @key slug: string; name: string; }
model Widget { id: int64; name: string; }
model Ticket { @format("uuid") id: string; }
model Note { @format("uuid") id: string; }
model Nomination { @format("uuid") id: string; award: string; }

/** Position rule: the segment after the collection path, whatever it is called. */
@route("/authors")
interface Authors {
  @post create(@body author: Author): Created<Author>;
  @route("/{id}") @get read(@path @format("uuid") id: string): Author;
  /**
   * A POST to the author creates a nomination subordinate to it (RFC 9110 9.3.3), so the author's
   * id stays a parameter this request consumes; only a PUT names the id it creates.
   */
  @route("/{id}") @post nominate(@path @format("uuid") id: string, @body nomination: Nomination): Created<Nomination>;
  /** A plain string in the id position does not take a uuid id. */
  @route("/{name}") @head exists(@path name: string): void;
}

/** Nested: the author's id by position, the book's own by position under it. */
@route("/authors/{authorId}/books")
interface Books {
  @post create(@path @format("uuid") authorId: string, @body book: Book): Created<Book>;
  @route("/{bookId}") @get read(@path @format("uuid") authorId: string, @path @format("uuid") bookId: string): Book;
}

/** Name rule: `authorId` anywhere names the author. */
@route("/reports/{authorId}") @get op report(@path @format("uuid") authorId: string): void;

/** `@key` names the key, and PUT-create names the new id in its own route. */
@route("/projects")
interface Projects {
  @route("/{slug}") @put create(@path slug: string, @body project: Project): Created<Project>;
  @route("/{slug}") @get read(@path slug: string): Project;
}

/** A numeric key is asserted as a number. */
@route("/widgets")
interface Widgets {
  @post create(@body widget: Widget): Created<Widget>;
  @route("/{widgetId}") @get read(@path widgetId: int64): Widget;
}

/** No Location header: not a created resource. */
@route("/tickets")
interface Tickets {
  @post create(@body ticket: Ticket): { @statusCode statusCode: 201; @body body: Ticket };
  @route("/{ticketId}") @get read(@path @format("uuid") ticketId: string): Ticket;
}

/** An anonymous body: a created resource with no name to chain it by. */
@route("/notes") @post op createNote(@body note: Note): { @statusCode statusCode: 201; @header location: string; @body body: { @format("uuid") id: string } };

model Shelf { @format("uuid") id: string; label: string; }
model Reservation { holdUntil: utcDateTime; }
/** A create body that carries the resource beside something else that is not one. */
model ShelfCreated { shelf: Shelf; reservation: Reservation; }

/**
 * The created body carries no key of its own. RFC 9110 9.3.1 makes the 201 `Location` the created
 * resource's identifier, and the shelf's own item route says what shape that identifier has.
 */
@route("/shelves")
interface Shelves {
  @post create(@body shelf: Shelf): Created<ShelfCreated>;
  @route("/{shelfId}") @get read(@path @format("uuid") shelfId: string): Shelf;
}

model Archive { @format("uuid") id: string; label: string; }
model Manifest { entries: string[]; }

/** Nothing creates an archive, so its id can only come from the run. */
@route("/archives")
interface Archives {
  @route("/{archiveId}") @get read(@path @format("uuid") archiveId: string): Archive;
  @route("/{archiveId}/manifest") @get manifest(@path @format("uuid") archiveId: string): Manifest;
}

/** A create that answers 201 with a Location and nothing anywhere states what it identifies. */
@route("/imports") @post op startImport(@body source: string): {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: { startedAt: utcDateTime };
};
