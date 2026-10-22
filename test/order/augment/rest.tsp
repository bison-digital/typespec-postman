import "@typespec/http";

using Http;

/** Models first, interfaces after them, and no operation creating either id. */
@service
namespace Shop;

model Widget {
  id: string;
  gadget_id: string;
}

model Gadget {
  id: string;
  label: string;
}

@error
model NotFound {
  @statusCode _: 404;
  message: string;
}

@route("/status")
interface Status {
  @get read(): {
    @statusCode _: 200;
    ok: boolean;
  };
}

@route("/widgets")
interface Widgets {
  @get read(@path id: string): Widget | NotFound;
}

@route("/gadgets")
interface Gadgets {
  @get read(@path id: string): Gadget | NotFound;
}
