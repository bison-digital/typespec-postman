import "@typespec/http";

using Http;

/** A bookshop served over REST alone. */
@service(#{ title: "Bookshop" })
@server("{endpoint}", "The bookshop", { endpoint: string = "http://localhost:8080" })
namespace RestFixture;

model Author {
  @visibility(Lifecycle.Read) id: string;
  name: string;
}

@route("/authors")
interface Authors {
  @route("/{authorId}") @get read(@path authorId: string): Author;
}
