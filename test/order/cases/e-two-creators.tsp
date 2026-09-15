import "@typespec/http";

using Http;

/** Two creators of Widget at collection path widgets, in two folders. */
@service(#{ title: "TwoCreators" })
namespace TwoCreators;

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

model Widget { @format("uuid") id: string; }

@route("/widgets")
interface Widgets {
  @post create(@body widget: Widget): Created<Widget>;
  @route("/{widgetId}") @get read(@path @format("uuid") widgetId: string): Widget;
  @route("/{widgetId}") @delete remove(@path @format("uuid") widgetId: string): void;
}

@route("/widgets/{widgetId}")
interface Imports {
  @put adopt(@path @format("uuid") widgetId: string, @body widget: Widget): Created<Widget>;
  @route("/adopt-status") @get status(@path @format("uuid") widgetId: string): void;
}
