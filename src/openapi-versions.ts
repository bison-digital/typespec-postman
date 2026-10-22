import type { Program } from "@typespec/compiler";

/**
 * **The OpenAPI versions `@typespec/openapi3` publishes from this compile**: its `openapi-versions`
 * option, read from the compile's options, and its default, `3.0.0`, where nothing sets it. The two
 * dialects read a required read-only property apart - "on the response only" at 3.0, both ways at
 * 3.1 - and a request this collection sends has to be one the published document accepts.
 */
export function openApiVersionsOf(program: Program): readonly string[] {
	const options = program.compilerOptions.options?.["@typespec/openapi3"] as
		| { readonly "openapi-versions"?: readonly string[] }
		| undefined;
	const versions = options?.["openapi-versions"];
	return versions === undefined || versions.length === 0 ? ["3.0.0"] : versions;
}

/** Whether every document openapi3 publishes here is OpenAPI 3.0. */
export function publishesOpenApi30Only(program: Program): boolean {
	return openApiVersionsOf(program).every((version) => version.startsWith("3.0."));
}
