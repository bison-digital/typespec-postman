import "@typespec/http";
import "@typespec/versioning";

using Http;
using Versioning;

@service(#{ title: "Versioned" })
@versioned(Versions)
namespace VersionedFixture;

enum Versions { v1, v2 }

@route("/widgets") @get op list(): void;

@removed(Versions.v2)
@route("/legacy") @get op legacy(): void;

@added(Versions.v2)
@route("/gadgets") @get op gadgets(): void;
