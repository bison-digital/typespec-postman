import {
	getDoc,
	type ModelProperty,
	type Namespace,
	type Program,
	serializeValueAsJson,
} from "@typespec/compiler";
import { getServers } from "@typespec/http";
import type { PlanVariable } from "./model.js";
import { BASE_URL_VARIABLE } from "./render.js";

/**
 * The collection variables a service's `@server` declares.
 *
 * **`baseUrl` roots every request, and its value is the server URL with each `{name}` rewritten to
 * `{{name}}`.** Postman resolves a variable that references another, so `--env-var baseUrl=...`
 * points the whole collection at a deployment and `--env-var endpoint=...` fills the declared
 * template, whichever a caller has. `baseUrl` is the name Postman's own OpenAPI importer gives the
 * same variable.
 *
 * **The first `@server`, in declaration order.** A collection runs against one deployment; the
 * others are alternatives a caller selects by setting `baseUrl`.
 */
export function deriveServerVariables(program: Program, namespace: Namespace): PlanVariable[] {
	const [server] = getServers(program, namespace) ?? [];
	if (server === undefined) {
		return [{ key: BASE_URL_VARIABLE, value: "", description: undefined }];
	}
	const variables: PlanVariable[] = [
		{
			key: BASE_URL_VARIABLE,
			value: server.url.replace(/\{([^{}]+)\}/g, "{{$1}}"),
			description: server.description,
		},
	];
	for (const [name, property] of server.parameters) {
		if (name === BASE_URL_VARIABLE) continue;
		variables.push({
			key: name,
			value: defaultOf(program, property),
			description: getDoc(program, property),
		});
	}
	return variables;
}

/**
 * A server variable's default, as `@typespec/openapi3`'s `resolveServers` derives it: the declared
 * default, otherwise the first value an enum, union or literal type allows, otherwise empty.
 */
function defaultOf(program: Program, property: ModelProperty): string {
	if (property.defaultValue !== undefined) {
		try {
			const value = serializeValueAsJson(program, property.defaultValue, property);
			return typeof value === "string" ? value : JSON.stringify(value);
		} catch {
			return "";
		}
	}
	const type = property.type;
	if (type.kind === "String") return type.value;
	if (type.kind === "Enum") {
		const [member] = type.members.values();
		return member === undefined ? "" : String(member.value ?? member.name);
	}
	if (type.kind === "Union") {
		for (const variant of type.variants.values()) {
			if (variant.type.kind === "String") return variant.type.value;
		}
	}
	return "";
}
