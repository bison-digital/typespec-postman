import "@typespec/http";

using Http;

@service(#{ title: "Assertions" })
namespace AssertionsFixture;

model Created<T> {
  @statusCode statusCode: 201;
  @header location: string;
  @body body: T;
}

model Account {
  @visibility(Lifecycle.Read) @format("uuid") id: string;
  name: string;
  tier: "free" | "paid";
  seats: int32;
  renewsAt?: utcDateTime;
}

model AccountPatch { name?: string; tier?: "free" | "paid"; seats?: int32; renewsAt?: utcDateTime; }

@route("/accounts")
interface Accounts {
  @post create(@body account: Account): Created<Account>;
  @get list(): Account[];

  @route("/{accountId}") @get read(@path @format("uuid") accountId: string): Account;

  @opExample(#{ parameters: #{ accountId: "00000000-0000-0000-0000-000000000000", patch: #{ name: "Renamed", seats: 3, renewsAt: utcDateTime.fromISO("2030-01-01T00:00:00Z") } } })
  @route("/{accountId}") @patch(#{ implicitOptionality: false }) update(@path @format("uuid") accountId: string, @body patch: AccountPatch): Account;

  @route("/{accountId}") @put replace(@path @format("uuid") accountId: string, @body account: Account): Account;
}

@route("/either") @post op either(): { @statusCode statusCode: 200 | 202 };
@route("/ranged") @get op ranged(): { @minValue(200) @maxValue(299) @statusCode statusCode: int32 };
@route("/failing") @get op failing(): { @statusCode statusCode: 400 };
model Seat { @visibility(Lifecycle.Read) @format("uuid") id: string; holder?: string; }
model SeatPatch { holder?: string; }

@route("/seats")
interface Seats {
  @post create(@body seat: Seat): Created<Seat>;
  @route("/{seatId}") @patch(#{ implicitOptionality: false }) update(@path @format("uuid") seatId: string, @body patch: SeatPatch): Seat;
}
