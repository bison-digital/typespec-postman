// A typespec-http-graphql from before it published `graphqlRequestsOf`: an emitter of that name
// whose module exports nothing else, as 0.2 does.
import { createTypeSpecLibrary } from "@typespec/compiler";

export const $lib = createTypeSpecLibrary({ name: "typespec-http-graphql", diagnostics: {} });
export async function $onEmit() {}
