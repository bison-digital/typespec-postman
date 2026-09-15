import "@typespec/http";

using Http;

@service(#{ title: "Bodies" })
namespace BodiesFixture;

model Widget {
  @visibility(Lifecycle.Read) id: string;
  @minLength(8) name: string;
  @encodedName("application/json", "colourCode") colour_code: string;
  @visibility(Lifecycle.Create) secret: string;
  note?: string;
  @format("email") contact: string;
  created: utcDateTime;
  @minValue(1) @maxValue(9) count: int32;
  @minValue(0.5) ratio: float64;
  enabled: boolean;
  kind: WidgetKind;
  label: string | null;
  size: "small" | "large";
  @minItems(2) tags: string[];
  attributes: Record<string>;
}

enum WidgetKind { gadget: "gadget-kind", gizmo: "gizmo-kind" }

@example(#{ name: "a declared example", colour_code: "red" })
model Exampled {
  name: string;
  @encodedName("application/json", "colourCode") colour_code: string;
}

@discriminator("kind")
model Pet { kind: string; name: string; }
model Dog extends Pet { kind: "dog"; bark: boolean; }
model Cat extends Pet { kind: "cat"; }

@discriminated
union Shape { circle: Circle, square: Square }
model Circle { radius: int32; }
model Square { side: int32; }

model Node { name: string; child?: Node; }
model Tree { name: string; parent: Tree | null; }

@route("/widgets") @post op create(@body widget: Widget): void;

@route("/widgets/{id}") @put op replace(@path id: string, @body widget: Widget): void;

@route("/exampled") @post op modelExample(@body body: Exampled): void;

@opExample(#{ parameters: #{ body: #{ name: "from the operation", colour_code: "blue" } } })
@route("/op-exampled") @post op operationExample(@body body: Exampled): void;

@route("/spread") @post op spread(...Exampled): void;

@route("/pets") @post op pet(@body pet: Pet): void;

@route("/shapes") @post op shape(@body shape: Shape): void;

@route("/nodes") @post op node(@body node: Node): void;

@route("/trees") @post op tree(@body tree: Tree): void;

@route("/patterned") @post op patterned(@body body: { @example("123") @pattern("^[0-9]{3}$") code: string }): void;

@route("/unmatched") @post op unmatched(@body body: { @pattern("^[A-Z]+$") code: string }): void;

@route("/search") @get op searchWithBody(@body filter: { term: string }): void;

@route("/upload") @post op upload(@header contentType: "application/octet-stream", @body data: bytes): void;

@route("/form") @post op form(@multipartBody body: { name: HttpPart<string>; avatar: HttpPart<File> }): void;

@route("/urlencoded") @post op urlencoded(@header contentType: "application/x-www-form-urlencoded", @body body: { name: string; age: int32 }): void;
