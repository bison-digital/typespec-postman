import { getDoc, getSummary, type Program } from "@typespec/compiler";
import { $ } from "@typespec/compiler/typekit";
import {
	type HttpOperation,
	type HttpOperationParameter,
	type HttpProperty,
	isOrExtendsHttpFile,
	resolveRequestVisibility,
} from "@typespec/http";
import type { Requirement } from "./auth.js";
import { reportDiagnostic } from "./lib.js";
import type { PlanBody, PlanFormPart, PlanParam, PlanUrl } from "./model.js";
import type { Chains } from "./resources.js";
import {
	encodeValue,
	expandQuery,
	expandValue,
	type JsonValue,
	splitTemplate,
	type UriTemplateParameter,
} from "./uri.js";
import {
	encoded,
	exampleBody,
	exampleParameter,
	operationExample,
	parameterValue,
	synthesiseBody,
	type ValueContext,
} from "./values.js";

export interface DerivedRequest {
	readonly name: string;
	readonly description: string | undefined;
	readonly method: string;
	readonly url: PlanUrl;
	readonly headers: readonly PlanParam[];
	readonly body: PlanBody | undefined;
	/** The JSON body sent, and which of its top-level fields an example supplied. */
	readonly sent:
		| { readonly value: JsonValue; readonly fromExample: ReadonlySet<string> }
		| undefined;
}

const JSON_MEDIA = /^application\/(?:[\w.+-]+\+)?json$/i;

function param(
	key: string,
	value: string,
	disabled: boolean,
	description: string | undefined,
): PlanParam {
	return { key, value, disabled, description };
}

/**
 * One operation as the request a collection sends.
 */
export function deriveRequest(
	context: ValueContext,
	operation: HttpOperation,
	chains: Chains,
	requirement: Requirement,
): DerivedRequest {
	const { program } = context;
	const example = operationExample(program, operation);
	const properties = operation.parameters.properties;
	const propertyFor = (parameter: HttpOperationParameter): HttpProperty | undefined =>
		properties.find((property) => property.property === parameter.param);

	/** An example's value if it gives one, else a synthesised value; and whether the example did. */
	const valueFor = (
		parameter: HttpOperationParameter,
	): { value: JsonValue; fromExample: boolean } => {
		const property = propertyFor(parameter);
		const exampled =
			property === undefined ? undefined : exampleParameter(context, example, property);
		if (exampled !== undefined) return { value: exampled, fromExample: true };
		return { value: parameterValue(context, parameter.param), fromExample: false };
	};

	const url = deriveUrl(program, operation, chains, valueFor);
	const query: PlanParam[] = [...url.query];
	for (const parameter of operation.parameters.parameters) {
		if (parameter.type !== "query") continue;
		const { value, fromExample } = valueFor(parameter);
		const disabled = parameter.param.optional && !fromExample;
		for (const [key, text] of expandQuery(
			parameter.name,
			parameter.explode ?? false,
			encoded(program, parameter.param, value),
		)) {
			query.push(param(key, text, disabled, getDoc(program, parameter.param)));
		}
	}
	query.push(...requirement.query);

	const body = deriveBody(context, operation, example);
	const headers: PlanParam[] = [];
	const cookies: string[] = [];
	for (const parameter of operation.parameters.parameters) {
		if (parameter.type === "header") {
			const { value, fromExample } = valueFor(parameter);
			const disabled = parameter.param.optional && !fromExample;
			const text =
				parameter.name.toLowerCase() === "content-type" && body.contentType !== undefined
					? body.contentType
					: expandValue(
							{ name: parameter.name, operator: undefined, explode: parameter.explode ?? false },
							value,
							{
								encode: false,
							},
						);
			headers.push(param(parameter.name, text, disabled, getDoc(program, parameter.param)));
		} else if (parameter.type === "cookie") {
			const { value } = valueFor(parameter);
			if (!parameter.param.optional)
				cookies.push(`${parameter.name}=${encodeValue(String(value), false)}`);
		}
	}
	if (
		body.contentType !== undefined &&
		!headers.some((header) => header.key.toLowerCase() === "content-type")
	) {
		headers.unshift(param("Content-Type", body.contentType, false, undefined));
	}
	const accept = acceptOf(operation);
	if (accept !== undefined && !headers.some((header) => header.key.toLowerCase() === "accept")) {
		headers.push(param("Accept", accept, false, undefined));
	}
	headers.push(...requirement.headers.filter((header) => header.key !== "Cookie"));
	const authCookie = requirement.headers.find((header) => header.key === "Cookie");
	if (authCookie !== undefined) cookies.push(authCookie.value);
	if (cookies.length > 0) headers.push(param("Cookie", cookies.join("; "), false, undefined));

	return {
		name: getSummary(program, operation.operation) ?? operation.operation.name,
		description: getDoc(program, operation.operation),
		method: operation.verb.toUpperCase(),
		url: { ...url, query },
		headers,
		body: body.body,
		sent: body.sent,
	};
}

function deriveUrl(
	program: Program,
	operation: HttpOperation,
	chains: Chains,
	valueFor: (parameter: HttpOperationParameter) => { value: JsonValue; fromExample: boolean },
): PlanUrl {
	const split = splitTemplate(operation.uriTemplate);
	const byName = new Map<string, HttpOperationParameter>();
	for (const parameter of operation.parameters.parameters) {
		if (parameter.type === "path") byName.set(parameter.name, parameter);
	}

	const render = (template: UriTemplateParameter): string | undefined => {
		const parameter = byName.get(template.name);
		if (parameter === undefined) return undefined;
		const resource = chains.consumed(operation, template.name);
		if (resource !== undefined) {
			return expandValue({ ...template, explode: false }, `{{${resource.variable}}}`, {
				encode: false,
			});
		}
		return expandValue(template, valueFor(parameter).value);
	};

	const path: string[] = [];
	const variables: PlanParam[] = [];
	for (const segment of split.segments) {
		const [only] = segment;
		if (
			segment.length === 1 &&
			only !== undefined &&
			typeof only !== "string" &&
			only.operator === undefined &&
			chains.consumed(operation, only.name) === undefined
		) {
			const parameter = byName.get(only.name);
			if (parameter !== undefined) {
				path.push(`:${only.name}`);
				variables.push({
					key: only.name,
					value: expandValue(only, valueFor(parameter).value),
					disabled: false,
					description: getDoc(program, parameter.param),
				});
				continue;
			}
		}
		let text = "";
		for (const part of segment) {
			if (typeof part === "string") {
				text += part;
				continue;
			}
			const rendered = render(part);
			if (rendered === undefined) continue;
			// `{/x}` opened this segment; its leading slash is the segment boundary itself.
			text += part.operator === "/" ? rendered.replace(/^\//, "") : rendered;
		}
		path.push(text);
	}

	const fragment = split.fragment === undefined ? undefined : byName.get(split.fragment.name);
	const hash =
		split.fragment === undefined || fragment === undefined
			? undefined
			: expandValue(split.fragment, valueFor(fragment).value);
	const query = split.literalQuery.map(([key, value]) => param(key, value, false, undefined));
	return { path, query, variables, hash };
}

/**
 * The media type a request asks for: the first one a 2xx arm with a body declares, otherwise the
 * first one any arm declares. An operation that only ever answers with an error body still answers
 * in a media type, and Postman's own OpenAPI importer asks for it the same way.
 */
function acceptOf(operation: HttpOperation): string | undefined {
	const isSuccess = (codes: HttpOperation["responses"][number]["statusCodes"]) =>
		codes !== "*" &&
		(typeof codes === "number"
			? codes >= 200 && codes <= 299
			: codes.start >= 200 && codes.end <= 299);
	const ordered = [
		...operation.responses.filter((response) => isSuccess(response.statusCodes)),
		...operation.responses.filter((response) => !isSuccess(response.statusCodes)),
	];
	for (const response of ordered) {
		for (const content of response.responses) {
			const [type] = content.body?.contentTypes ?? [];
			if (type !== undefined) return type;
		}
	}
	return undefined;
}

interface DerivedBody {
	readonly body: PlanBody | undefined;
	readonly contentType: string | undefined;
	readonly sent: DerivedRequest["sent"];
}

function deriveBody(
	context: ValueContext,
	operation: HttpOperation,
	example: ReturnType<typeof operationExample>,
): DerivedBody {
	const { program } = context;
	const body = operation.parameters.body;
	if (body === undefined) return { body: undefined, contentType: undefined, sent: undefined };
	const visibility = resolveRequestVisibility(program, operation.operation, operation.verb);
	const notRunnable = (
		kind: string,
		mode: PlanBody["mode"],
		contentType: string | undefined,
	): DerivedBody => {
		reportDiagnostic(program, {
			code: "body-not-runnable",
			format: { operation: operation.operation.name, kind, mode },
			target: operation.operation,
		});
		const empty: PlanBody =
			mode === "file"
				? { mode: "file" }
				: mode === "formdata"
					? { mode: "formdata", parts: [] }
					: { mode: "raw", raw: "", language: "text" };
		return { body: empty, contentType, sent: undefined };
	};

	const bodyType = body.type;
	/**
	 * `bytes` is binary only when the media type is not JSON. `@header contentType: "application/json"`
	 * with a `bytes` body is a base64 JSON string, which is as runnable as any other JSON body.
	 */
	const binary =
		bodyType.kind === "Scalar" &&
		$(program).scalar.extendsBytes(bodyType) &&
		!body.contentTypes.some((type) => JSON_MEDIA.test(type));
	if (body.bodyKind === "file" || binary) {
		const [contentType] = body.contentTypes;
		return notRunnable(body.bodyKind === "file" ? "a file" : "binary", "file", contentType);
	}

	if (body.bodyKind === "multipart") {
		const [contentType] = body.contentTypes;
		const parts: PlanFormPart[] = [];
		for (const part of body.parts) {
			if (part.optional || part.name === undefined) continue;
			const partType = part.body.type;
			const isFile = partType.kind === "Model" && isOrExtendsHttpFile(program, partType);
			const isBytes = partType.kind === "Scalar" && partType.name === "bytes";
			if (isFile || isBytes) {
				parts.push({ type: "file", key: part.name });
				continue;
			}
			const [partContentType] = part.body.contentTypes;
			const produced = synthesiseBody(context, partType, visibility, false, part.name).value;
			parts.push({
				type: "text",
				key: part.name,
				value: typeof produced === "string" ? produced : JSON.stringify(produced),
				contentType: partContentType,
			});
		}
		if (parts.some((part) => part.type === "file")) {
			reportDiagnostic(program, {
				code: "body-not-runnable",
				format: {
					operation: operation.operation.name,
					kind: "a multipart body with a file part",
					mode: "formdata",
				},
				target: operation.operation,
			});
		}
		// `multipart/form-data` carries a boundary Postman writes itself, so no Content-Type is set here.
		void contentType;
		return { body: { mode: "formdata", parts }, contentType: undefined, sent: undefined };
	}

	const contentTypes = body.contentTypes.length === 0 ? ["application/json"] : body.contentTypes;
	const contentType =
		contentTypes.find((type) => JSON_MEDIA.test(type)) ?? contentTypes[0] ?? "application/json";
	const ignoreMetadata = body.isExplicit && body.containsMetadataAnnotations;

	const fromOperationExample =
		example === undefined ? undefined : exampleBody(context, operation, example, body.type);
	const synthesised =
		fromOperationExample === undefined
			? synthesiseBody(context, body.type, visibility, ignoreMetadata)
			: undefined;
	const value = fromOperationExample ?? synthesised?.value ?? null;
	const fromExample =
		fromOperationExample !== undefined
			? new Set(
					fromOperationExample !== null &&
						typeof fromOperationExample === "object" &&
						!Array.isArray(fromOperationExample)
						? Object.keys(fromOperationExample)
						: [],
				)
			: (synthesised?.fromExample ?? new Set<string>());

	if (JSON_MEDIA.test(contentType)) {
		return {
			body: { mode: "raw", raw: JSON.stringify(value, null, 2), language: "json" },
			contentType,
			sent: { value, fromExample },
		};
	}
	if (
		contentType.toLowerCase() === "application/x-www-form-urlencoded" &&
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value)
	) {
		return {
			body: {
				mode: "urlencoded",
				fields: Object.entries(value).map(([key, item]) =>
					param(key, typeof item === "string" ? item : JSON.stringify(item), false, undefined),
				),
			},
			contentType,
			sent: undefined,
		};
	}
	if (contentType.toLowerCase().startsWith("text/") && typeof value === "string") {
		return { body: { mode: "raw", raw: value, language: "text" }, contentType, sent: undefined };
	}
	return notRunnable(`'${contentType}'`, "raw", contentType);
}
