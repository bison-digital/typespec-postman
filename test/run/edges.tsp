import "@typespec/http";

using Http;

/**
 * Resources the worked example does not have, run through the Postman CLI against a server generated
 * from this file: a numeric key, and a property that is written but never read back.
 */
@service(#{ title: "Edges" })
@server("{endpoint}", "The edges API", { endpoint: string = "http://localhost:8080" })
namespace Edges;

@error
model NotFound {
  @statusCode statusCode: 404;
  title: string;
}

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

/** Keyed by a number, which a collection variable holds as text. */
model Widget {
  @visibility(Lifecycle.Read)
  id: int32;

  name: string;
}

@route("/widgets")
interface Widgets {
  @post create(@body widget: Widget): Created<Widget>;

  @route("/{widgetId}")
  @get
  read(@path widgetId: int32): Widget | NotFound;
}

/** A pin is written on create and update and never returned. */
model Member {
  @visibility(Lifecycle.Read)
  @format("uuid")
  id: string;

  name: string;

  @visibility(Lifecycle.Create, Lifecycle.Update)
  pin: string;
}

model MemberPatch {
  name?: string;

  @visibility(Lifecycle.Create, Lifecycle.Update)
  pin?: string;
}

@route("/members")
interface Members {
  @post create(@body member: Member): Created<Member>;

  @route("/{memberId}")
  @get
  read(@path @format("uuid") memberId: string): Member | NotFound;

  @opExample(#{
    parameters: #{
      memberId: "00000000-0000-0000-0000-000000000000",
      contentType: "application/merge-patch+json",
      patch: #{ name: "Renamed", pin: "1234" },
    },
  })
  @route("/{memberId}")
  @patch(#{ implicitOptionality: false })
  update(
    @path @format("uuid") memberId: string,
    @header contentType: "application/merge-patch+json",
    @body patch: MemberPatch,
  ): Member | NotFound;
}
