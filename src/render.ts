import { stableId } from "./ids.js";
import type {
	AuthSetting,
	CollectionPlan,
	PlanAssertion,
	PlanBody,
	PlanNode,
	PlanParam,
	PlanRequest,
	PlanUrl,
	PlanVariable,
	StatusMatch,
} from "./model.js";

/** The collection format this emitter writes, as the Postman schema names itself. */
export const COLLECTION_SCHEMA =
	"https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

/**
 * One UTF-16 code unit outside ASCII. Built from a string so the source stays ASCII: a formatter
 * rewrites escapes inside a regex literal into the characters they name.
 */
const NON_ASCII = new RegExp("[\\u0080-\\uFFFF]", "g");

/** Every request URL is rooted here, so pointing the collection at a deployment is one variable. */
export const BASE_URL_VARIABLE = "baseUrl";

/**
 * A collection plan as Postman Collection v2.1 JSON.
 *
 * **Byte-deterministic.** Keys are written in a fixed order, arrays in plan order, ids are derived
 * from identity, and nothing reads a clock. Tab indentation and a trailing newline, as the Postman
 * app exports.
 *
 * **ASCII only.** Every character outside ASCII is written as a `\uXXXX` escape, which JSON defines
 * as the same string. Spec text flows into descriptions (a doc comment with a curly quote, which
 * `@typespec/http`'s own `BearerAuth` doc has), and a committed file that differs by encoding from
 * machine to machine is a drift check that fails for no reason.
 */
export function renderCollection(plan: CollectionPlan): string {
	const collection = {
		info: {
			_postman_id: stableId("collection", plan.identity),
			name: plan.name,
			...(plan.description === undefined ? {} : { description: plan.description }),
			schema: COLLECTION_SCHEMA,
		},
		item: plan.items.map(renderNode),
		...(plan.auth === undefined ? {} : { auth: renderAuth(plan.auth) }),
		variable: plan.variables.map(renderVariable),
	};
	const text = JSON.stringify(collection, null, "\t");
	return `${text.replace(NON_ASCII, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

function renderVariable(variable: PlanVariable): object {
	return {
		key: variable.key,
		value: variable.value,
		type: "string",
		...(variable.description === undefined ? {} : { description: variable.description }),
	};
}

function renderNode(node: PlanNode): object {
	if (node.kind === "folder") {
		return {
			id: stableId("folder", node.identity),
			name: node.name,
			...(node.description === undefined ? {} : { description: node.description }),
			item: node.items.map(renderNode),
			...(node.auth === undefined ? {} : { auth: renderAuth(node.auth) }),
		};
	}
	return renderRequest(node);
}

function renderRequest(request: PlanRequest): object {
	const tests = request.assertions.flatMap(renderAssertion);
	return {
		id: stableId("request", request.identity),
		name: request.name,
		...(tests.length === 0
			? {}
			: {
					event: [
						{
							listen: "test",
							script: { type: "text/javascript", exec: tests },
						},
					],
				}),
		/**
		 * **Postman drops a GET or HEAD body unless told not to**, measured on the Postman CLI: the same
		 * request arrived with an empty body without this flag and with its body with it.
		 */
		...(request.body !== undefined && (request.method === "GET" || request.method === "HEAD")
			? { protocolProfileBehavior: { disableBodyPruning: true } }
			: {}),
		request: {
			...(request.auth === undefined ? {} : { auth: renderAuth(request.auth) }),
			method: request.method,
			header: request.headers.map(renderParam),
			...(request.body === undefined ? {} : { body: renderBody(request.body) }),
			url: renderUrl(request.url),
			...(request.description === undefined ? {} : { description: request.description }),
		},
		response: [],
	};
}

function renderParam(param: PlanParam): object {
	return {
		key: param.key,
		value: param.value,
		...(param.disabled ? { disabled: true } : {}),
		...(param.description === undefined ? {} : { description: param.description }),
	};
}

function renderUrl(url: PlanUrl): object {
	const enabled = url.query.filter((param) => !param.disabled);
	const raw =
		`{{${BASE_URL_VARIABLE}}}` +
		url.path.map((segment) => `/${segment}`).join("") +
		(enabled.length === 0
			? ""
			: `?${enabled.map((param) => `${param.key}=${param.value}`).join("&")}`) +
		(url.hash === undefined ? "" : `#${url.hash}`);
	return {
		raw,
		host: [`{{${BASE_URL_VARIABLE}}}`],
		path: url.path,
		...(url.query.length === 0 ? {} : { query: url.query.map(renderParam) }),
		...(url.variables.length === 0 ? {} : { variable: url.variables.map(renderParam) }),
		...(url.hash === undefined ? {} : { hash: url.hash }),
	};
}

function renderBody(body: PlanBody): object {
	switch (body.mode) {
		case "raw":
			return {
				mode: "raw",
				raw: body.raw,
				options: { raw: { language: body.language } },
			};
		case "urlencoded":
			return { mode: "urlencoded", urlencoded: body.fields.map(renderParam) };
		case "formdata":
			return {
				mode: "formdata",
				formdata: body.parts.map((part) =>
					part.type === "file"
						? { key: part.key, type: "file", src: [] }
						: {
								key: part.key,
								value: part.value,
								type: "text",
								...(part.contentType === undefined ? {} : { contentType: part.contentType }),
							},
				),
			};
		case "file":
			return { mode: "file", file: { src: null } };
	}
}

function attribute(key: string, value: string): object {
	return { key, value, type: "string" };
}

function renderAuth(setting: AuthSetting): object {
	if (setting.kind === "none") return { type: "noauth" };
	const scheme = setting.scheme;
	switch (scheme.type) {
		case "apikey":
			return {
				type: "apikey",
				apikey: [
					attribute("key", scheme.name),
					attribute("value", `{{${scheme.variable}}}`),
					attribute("in", scheme.in),
				],
			};
		case "bearer":
			return { type: "bearer", bearer: [attribute("token", `{{${scheme.variable}}}`)] };
		case "basic":
			return {
				type: "basic",
				basic: [
					attribute("username", `{{${scheme.username}}}`),
					attribute("password", `{{${scheme.password}}}`),
				],
			};
		case "oauth2":
			return {
				type: "oauth2",
				oauth2: [
					attribute("accessToken", `{{${scheme.variable}}}`),
					attribute("addTokenTo", "header"),
				],
			};
	}
}

/** A property of the parsed response body, always bracketed so any wire name is safe. */
function jsonAt(path: readonly string[]): string {
	return `pm.response.json()${path.map((key) => `[${JSON.stringify(key)}]`).join("")}`;
}

/**
 * One assertion as `pm.test` lines, in the form Postman's own snippets and templates write them.
 */
function renderAssertion(assertion: PlanAssertion): string[] {
	switch (assertion.kind) {
		case "status":
			return renderStatus(assertion.codes);
		case "has-key":
			return [
				`pm.test(${JSON.stringify(`Response has ${/^[aeiou]/i.test(assertion.key) ? "an" : "a"} ${assertion.key}`)}, function () {`,
				`    pm.expect(${jsonAt([assertion.key])}).to.be.a(${JSON.stringify(assertion.type)});`,
				"});",
				`pm.collectionVariables.set(${JSON.stringify(assertion.variable)}, ${jsonAt([assertion.key])});`,
			];
		case "is-array":
			return [
				`pm.test(${JSON.stringify(assertion.path.length === 0 ? "Response is an array" : `Response ${assertion.path.join(".")} is an array`)}, function () {`,
				`    pm.expect(${jsonAt(assertion.path)}).to.be.an("array");`,
				"});",
			];
		case "key-matches":
			return [
				`pm.test(${JSON.stringify(`Returns the requested ${assertion.resource}`)}, function () {`,
				`    pm.expect(String(${jsonAt([assertion.key])})).to.eql(pm.variables.get(${JSON.stringify(assertion.variable)}));`,
				"});",
			];
		case "field-updated":
			return [
				`pm.test(${JSON.stringify(`${assertion.field} was updated`)}, function () {`,
				`    pm.expect(${jsonAt([assertion.field])}).to.eql(${JSON.stringify(assertion.value)});`,
				"});",
			];
	}
}

function renderStatus(codes: readonly StatusMatch[]): string[] {
	const [only] = codes;
	if (codes.length === 1 && typeof only === "number") {
		return [
			`pm.test(${JSON.stringify(`Status code is ${only}`)}, function () {`,
			`    pm.response.to.have.status(${only});`,
			"});",
		];
	}
	if (codes.length === 1 && only !== undefined && typeof only !== "number") {
		return [
			`pm.test(${JSON.stringify(`Status code is ${only.start} to ${only.end}`)}, function () {`,
			`    pm.expect(pm.response.code).to.be.within(${only.start}, ${only.end});`,
			"});",
		];
	}
	const exact = codes.filter((code): code is number => typeof code === "number");
	const ranges = codes.filter((code) => typeof code !== "number");
	const label = codes
		.map((code) => (typeof code === "number" ? `${code}` : `${code.start} to ${code.end}`))
		.join(", ");
	const checks = [
		...(exact.length === 0 ? [] : [`[${exact.join(", ")}].includes(pm.response.code)`]),
		...ranges.map(
			(range) => `(pm.response.code >= ${range.start} && pm.response.code <= ${range.end})`,
		),
	];
	if (ranges.length === 0) {
		return [
			`pm.test(${JSON.stringify(`Status code is one of ${label}`)}, function () {`,
			`    pm.expect(pm.response.code).to.be.oneOf([${exact.join(", ")}]);`,
			"});",
		];
	}
	return [
		`pm.test(${JSON.stringify(`Status code is one of ${label}`)}, function () {`,
		`    pm.expect(${checks.join(" || ")}).to.eql(true);`,
		"});",
	];
}
