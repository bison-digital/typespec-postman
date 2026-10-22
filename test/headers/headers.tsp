import "@typespec/http";

using Http;

@service(#{ title: "Headers" })
namespace HeadersFixture;

model Thing {
  name: string;
}

@route("/required") @get op required(@header("X-Request-Id") requestId: string, @header("X-Trace")  trace?: string): Thing;

@opExample(#{ parameters: #{ trace: "abc", since: utcDateTime.fromISO("2020-01-02T03:04:05Z") } })
@route("/exampled") @get op exampled(@header("X-Trace") trace?: string, @header("If-Modified-Since") since?: utcDateTime): Thing;

@route("/json") @post op json(@body body: Thing): Thing;

@route("/merge") @patch(#{ implicitOptionality: false }) op merge(@header contentType: "application/merge-patch+json", @body body: Thing): Thing;

@route("/text") @post op text(@header contentType: "text/plain", @body body: string): void;

@route("/cookies") @get op cookies(@cookie session: string, @cookie theme?: string): void;

@route("/nothing") @delete op nothing(): void;
