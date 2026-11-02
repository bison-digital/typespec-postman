// A typespec-http-graphql from before its requests said where an answer holds a value: it publishes
// `graphqlRequestsOf`, and each request has no `resultPathsOf`, as 0.3 does.
import { createTypeSpecLibrary } from "@typespec/compiler";

export const $lib = createTypeSpecLibrary({ name: "typespec-http-graphql", diagnostics: {} });
export async function $onEmit() {}
export function graphqlRequestsOf() {
	return [
		{
			service: "RestFixture",
			requests: [
				{
					kind: "query",
					field: "author",
					description: undefined,
					document:
						"query Author($authorId: String!) {\n  author(authorId: $authorId) {\n    __typename\n  }\n}",
					successTypenames: undefined,
					variables: () => ({ value: {}, missing: [] }),
				},
			],
		},
	];
}
