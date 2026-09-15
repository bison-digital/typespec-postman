/**
 * RFC 6570 URI templates: parsing, and expanding one variable from a JSON value.
 *
 * `parseUriTemplate` is copied from `@typespec/http` 1.16.0 (`dist/src/uri-template.js`, MIT), which
 * implements it but does not export it, and whose `exports` map blocks a deep import. Copied rather
 * than re-derived so the template this emitter reads is split exactly as the library that built it
 * splits it.
 *
 * **`HttpOperation.uriTemplate` and never `HttpOperation.path`.** The library marks `path` as not
 * recommended: it drops every operator, so `{/id}`, `{.id}`, `{;id}` and `{+path}` all become a bare
 * `{id}` and the URL a request sends stops matching the route it was declared on.
 */

const operators = ["+", "#", ".", "/", ";", "?", "&"] as const;
export type UriOperator = (typeof operators)[number];

export interface UriTemplateParameter {
	readonly name: string;
	readonly operator: UriOperator | undefined;
	readonly explode: boolean;
}

export type UriTemplateSegment = string | UriTemplateParameter;

const uriTemplateRegex = /\{([^{}]+)\}|([^{}]+)/g;
const expressionRegex = /([^:*]*)(?::(\d+)|(\*))?/;

export function parseUriTemplate(template: string): UriTemplateSegment[] {
	const segments: UriTemplateSegment[] = [];
	for (const [, rawExpression, literal] of template.matchAll(uriTemplateRegex)) {
		if (rawExpression === undefined) {
			segments.push(literal ?? "");
			continue;
		}
		let expression = rawExpression;
		let operator: UriOperator | undefined;
		const first = expression[0] as UriOperator | undefined;
		if (first !== undefined && operators.includes(first)) {
			operator = first;
			expression = expression.slice(1);
		}
		for (const item of expression.split(",")) {
			const match = expressionRegex.exec(item);
			segments.push({
				name: match?.[1] ?? item,
				operator,
				explode: match?.[3] !== undefined,
			});
		}
	}
	return segments;
}

/** One `/`-delimited path segment: the literal text and parameters it is made of, in order. */
export type PathSegment = readonly UriTemplateSegment[];

export interface SplitTemplate {
	readonly segments: readonly PathSegment[];
	/** `{?a,b}` and `{&c}` expressions: sent as query parameters, never as path. */
	readonly query: readonly UriTemplateParameter[];
	/** A `{#x}` expression: Postman keeps a fragment beside the path, not in it. */
	readonly fragment: UriTemplateParameter | undefined;
}

/**
 * A template split into path segments. A `{/x}` expression opens a segment of its own, because that
 * is what it expands to; every other expression stays inside the segment it was written in.
 */
export function splitTemplate(template: string): SplitTemplate {
	const segments: UriTemplateSegment[][] = [];
	const query: UriTemplateParameter[] = [];
	let fragment: UriTemplateParameter | undefined;
	let current: UriTemplateSegment[] | undefined;
	const open = () => {
		current = [];
		segments.push(current);
		return current;
	};
	for (const part of parseUriTemplate(template)) {
		if (typeof part === "string") {
			const pieces = part.split("/");
			pieces.forEach((piece, index) => {
				const target = index === 0 ? (current ?? (piece === "" ? undefined : open())) : open();
				if (piece !== "" && target !== undefined) target.push(piece);
			});
			continue;
		}
		if (part.operator === "?" || part.operator === "&") {
			query.push(part);
		} else if (part.operator === "#") {
			fragment = part;
		} else if (part.operator === "/") {
			open().push(part);
		} else {
			(current ?? open()).push(part);
		}
	}
	return { segments: segments.filter((segment) => segment.length > 0), query, fragment };
}

/** A JSON value a parameter carries. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

const UNRESERVED = /[A-Za-z0-9\-._~]/;
const RESERVED = /[:/?#[\]@!$&'()*+,;=]/;

/**
 * Percent-encode as RFC 6570 section 3.2.1 prescribes: unreserved characters pass, and reserved
 * ones also pass for the `+` and `#` operators.
 */
export function encodeValue(text: string, allowReserved: boolean): string {
	let out = "";
	for (const char of text) {
		if (UNRESERVED.test(char) || (allowReserved && RESERVED.test(char))) {
			out += char;
			continue;
		}
		if (allowReserved && char === "%") {
			out += char;
			continue;
		}
		out += [...new TextEncoder().encode(char)]
			.map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
			.join("");
	}
	return out;
}

function scalarText(value: JsonValue): string {
	return value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * The items of a value in RFC 6570 terms: a list's elements, or an associative array's pairs.
 * Undefined for a scalar.
 */
function composite(
	value: JsonValue,
): { list: string[] } | { pairs: [string, string][] } | undefined {
	if (Array.isArray(value)) return { list: value.map(scalarText) };
	if (value !== null && typeof value === "object") {
		return { pairs: Object.entries(value).map(([key, item]) => [key, scalarText(item)]) };
	}
	return undefined;
}

/**
 * One path or header value, expanded for the operator it was declared with (RFC 6570 section 3.2).
 * `prefix` is what the operator writes first: `.` for a label, `/` for a path segment, `;name=` for
 * a matrix parameter. Header values use the simple form with no encoding.
 */
export function expandValue(
	parameter: UriTemplateParameter,
	value: JsonValue,
	options: { readonly encode: boolean } = { encode: true },
): string {
	const allowReserved = parameter.operator === "+" || parameter.operator === "#";
	const enc = (text: string) => (options.encode ? encodeValue(text, allowReserved) : text);
	const items = composite(value);
	switch (parameter.operator) {
		case ";": {
			if (items === undefined) {
				const text = scalarText(value);
				return text === "" ? `;${parameter.name}` : `;${parameter.name}=${enc(text)}`;
			}
			if ("list" in items) {
				return parameter.explode
					? items.list.map((item) => `;${parameter.name}=${enc(item)}`).join("")
					: `;${parameter.name}=${items.list.map(enc).join(",")}`;
			}
			return parameter.explode
				? items.pairs.map(([key, item]) => `;${key}=${enc(item)}`).join("")
				: `;${parameter.name}=${items.pairs.map(([key, item]) => `${key},${enc(item)}`).join(",")}`;
		}
		default: {
			const leader =
				parameter.operator === "." || parameter.operator === "/" ? parameter.operator : "";
			const joiner =
				parameter.explode && (parameter.operator === "." || parameter.operator === "/")
					? parameter.operator
					: ",";
			if (items === undefined) return `${leader}${enc(scalarText(value))}`;
			if ("list" in items) return `${leader}${items.list.map(enc).join(joiner)}`;
			return `${leader}${items.pairs
				.map(([key, item]) => (parameter.explode ? `${key}=${enc(item)}` : `${key},${enc(item)}`))
				.join(joiner)}`;
		}
	}
}

/**
 * A query parameter as the key/value pairs a Postman URL lists (RFC 6570 form-style expansion).
 * An exploded list repeats the key; an unexploded one joins with commas.
 */
export function expandQuery(name: string, explode: boolean, value: JsonValue): [string, string][] {
	const items = composite(value);
	if (items === undefined) return [[name, encodeValue(scalarText(value), false)]];
	if ("list" in items) {
		return explode
			? items.list.map((item) => [name, encodeValue(item, false)])
			: [[name, items.list.map((item) => encodeValue(item, false)).join(",")]];
	}
	return explode
		? items.pairs.map(([key, item]) => [key, encodeValue(item, false)])
		: [[name, items.pairs.map(([key, item]) => `${key},${encodeValue(item, false)}`).join(",")]];
}
