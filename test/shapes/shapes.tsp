import "@typespec/http";

using Http;

/**
 * **Every shape a create or an item route can take**, so the convention is graded against the space
 * rather than against the cases that happened to be written first. Each one is a shape a real HTTP
 * API uses; none of them is invented for this suite.
 */
@service(#{ title: "Shapes" })
@server("{endpoint}/v2", "The shapes API", { endpoint: string = "http://localhost:8080" })
namespace Shapes;

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

// 1. A 201 with a Location and NO body at all: the header is the only thing it answers with.
model Crate {
  @visibility(Lifecycle.Read) @format("uuid") id: string;
  label: string;
}

@route("/crates")
interface Crates {
  @post create(@body crate: Crate): {
    @statusCode statusCode: 201;
    @header location: string;
  };

  @route("/{crateId}") @get read(@path @format("uuid") crateId: string): Crate | NotFound;
}

// 2. A create that answers 200, not 201, which is what several large public APIs do.
model Pallet {
  @visibility(Lifecycle.Read) @format("uuid") id: string;
  label: string;
}

@route("/pallets")
interface Pallets {
  @post create(@body pallet: Pallet): Pallet;
  @route("/{palletId}") @get read(@path @format("uuid") palletId: string): Pallet | NotFound;
}

// 3. A 202 with a Location: accepted for later, and the Location is a job, not the resource.
model Job {
  @visibility(Lifecycle.Read) @format("uuid") id: string;
  state: "pending" | "done";
}

@route("/jobs")
interface Jobs {
  @post start(@body job: Job): {
    @statusCode statusCode: 202;
    @header location: string;
    @body body: Job;
  };

  @route("/{jobId}") @get read(@path @format("uuid") jobId: string): Job | NotFound;
}

// 4. A read that answers a different model from the one the create takes: a detail view.
model Parcel {
  @visibility(Lifecycle.Read) @format("uuid") id: string;
  weight: int32;
}

model ParcelDetail {
  @visibility(Lifecycle.Read) @format("uuid") id: string;
  weight: int32;
  history: string[];
}

@route("/parcels")
interface Parcels {
  @post create(@body parcel: Parcel): Created<Parcel>;
  @route("/{parcelId}") @get read(@path @format("uuid") parcelId: string): ParcelDetail | NotFound;
}

// 5. A resource nothing creates, with a child resource that IS created under it.
model Depot {
  @visibility(Lifecycle.Read) @format("uuid") id: string;
  name: string;
}

model Bay {
  @visibility(Lifecycle.Read) @format("uuid") id: string;
  number: int32;
}

@route("/depots")
interface Depots {
  @route("/{depotId}") @get read(@path @format("uuid") depotId: string): Depot | NotFound;
}

@route("/depots/{depotId}/bays")
interface Bays {
  @post create(@path @format("uuid") depotId: string, @body bay: Bay): Created<Bay>;
  @route("/{bayId}") @get read(
    @path @format("uuid") depotId: string,
    @path @format("uuid") bayId: string,
  ): Bay | NotFound;
}

// 6. A PUT-create whose body carries no key of its own.
model Slot {
  @key @visibility(Lifecycle.Read) name: string;
  occupied: boolean;
}

model SlotAssigned {
  slot: Slot;
  assignedAt: utcDateTime;
}

@route("/slots")
interface Slots {
  @route("/{name}") @put assign(@path name: string, @body slot: Slot): Created<SlotAssigned>;
  @route("/{name}") @get read(@path name: string): Slot | NotFound;
}

// 7. A PUT at an item route answering 200: RFC 9110 9.3.4 makes that a replace, not a create.
model Label {
  @visibility(Lifecycle.Read) @format("uuid") id: string;
  text: string;
}

@route("/labels")
interface Labels {
  @post create(@body label: Label): Created<Label>;
  @route("/{labelId}") @get read(@path @format("uuid") labelId: string): Label | NotFound;
  @route("/{labelId}") @put replace(
    @path @format("uuid") labelId: string,
    @body label: Label,
  ): Label | NotFound;
}

// 8. Two resources nothing creates, both needed by one request, one of them keyed by a number.
model Rack {
  @visibility(Lifecycle.Read) id: int32;
  aisle: string;
}

@route("/depots/{depotId}/racks")
interface Racks {
  @route("/{rackId}") @get read(
    @path @format("uuid") depotId: string,
    @path rackId: int32,
  ): Rack | NotFound;
}
