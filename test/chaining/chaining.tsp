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

model Team { @format("uuid") id: string; name: string; }
model Member { @format("uuid") id: string; name: string; }
model Project { @key slug: string; name: string; }
model Widget { id: int64; name: string; }
model Ticket { @format("uuid") id: string; }
model Note { @format("uuid") id: string; }
model Invitation { @format("uuid") id: string; email: string; }

/** Position rule: the segment after the collection path, whatever it is called. */
@route("/teams")
interface Teams {
  @post create(@body team: Team): Created<Team>;
  @route("/{id}") @get read(@path @format("uuid") id: string): Team;
  /**
   * A POST to the team creates an invitation subordinate to it (RFC 9110 9.3.3), so the team's id
   * stays a parameter this request consumes; only a PUT names the id it creates.
   */
  @route("/{id}") @post invite(@path @format("uuid") id: string, @body invitation: Invitation): Created<Invitation>;
  /** A plain string in the id position does not take a uuid id. */
  @route("/{name}") @head exists(@path name: string): void;
}

/** Nested: the team's id by position, the member's own by position under it. */
@route("/teams/{teamId}/members")
interface Members {
  @post create(@path @format("uuid") teamId: string, @body member: Member): Created<Member>;
  @route("/{memberId}") @get read(@path @format("uuid") teamId: string, @path @format("uuid") memberId: string): Member;
}

/** Name rule: `teamId` anywhere names the team. */
@route("/reports/{teamId}") @get op report(@path @format("uuid") teamId: string): void;

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
