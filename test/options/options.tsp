import "@typespec/http";

using Http;

@service(#{ title: "Options" })
namespace OptionsFixture;

@route("/ping") @get op ping(): void;
