import "@typespec/http";

using Http;

/**
 * Response shapes that exercise each draft-07 rewrite and that no corpus response happens to carry:
 * a tuple, a record beside a base model, recursion, and formats Ajv 6 does not know.
 */
@service(#{ title: "Rewrites" })
namespace Rewrites;

model Pair {
  pair: [string, int32];
}

model Base {
  kind: string;
}

model Tagged extends Base {
  ...Record<int32>;
  count: int32;
}

model Tree {
  name: string;
  children: Tree[];
}

model Timed {
  ttl: duration;
  size: int64;
  at: utcDateTime;
}

@route("/pair") @get op pair(): Pair;
@route("/tagged") @get op tagged(): Tagged;
@route("/tree") @get op tree(): Tree;
@route("/timed") @get op timed(): Timed;
