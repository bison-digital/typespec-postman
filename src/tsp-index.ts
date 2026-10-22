/**
 * What TypeSpec's compiler loads for this library.
 *
 * **There is deliberately no `$decorators` export.** A spec must not know which tools consume it. If
 * this emitter ever needed to be told something by an annotation, the convention it derives from
 * would be wrong, and the fix would belong there.
 */
export { $lib } from "./lib.js";
