import "@typespec/http";

using Http;

/**
 * Resources the worked example does not have, run through the Postman CLI against a server generated
 * from this file: a numeric key, a property that is written but never read back, a create whose body
 * wraps the resource, and a resource no operation creates.
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

/** A create that answers the resource beside a value that is not part of it. */
model Batch {
  @visibility(Lifecycle.Read)
  @format("uuid")
  id: string;

  label: string;
}

/** Issued once with the batch and not part of it: the resource outlives the receipt. */
model Receipt {
  url: url;
  expiresAt: utcDateTime;
}

model BatchStarted {
  batch: Batch;
  receipt: Receipt;
}

@route("/batches")
interface Batches {
  @post create(@body batch: Batch): Created<BatchStarted>;

  @route("/{batchId}")
  @get
  read(@path @format("uuid") batchId: string): Batch | NotFound;
}

/** A ledger comes into being outside the API, so no operation here answers 201 for one. */
model Ledger {
  @visibility(Lifecycle.Read)
  @format("uuid")
  id: string;

  balance: int32;
}

@route("/ledgers")
interface Ledgers {
  @route("/{ledgerId}")
  @get
  read(@path @format("uuid") ledgerId: string): Ledger | NotFound;
}
