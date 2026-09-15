import "@typespec/http";

using Http;

@service(#{ title: "Storefront" })
namespace Storefront {
  @route("/products") @get op products(): void;
}

@service(#{ title: "Back office" })
namespace BackOffice {
  @route("/orders") @get op orders(): void;
}
