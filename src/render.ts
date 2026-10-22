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
	const before = credentialCheck(plan.credentials);
	const collection = {
		info: {
			_postman_id: stableId("collection", plan.identity),
			name: plan.name,
			...(plan.description === undefined ? {} : { description: plan.description }),
			schema: COLLECTION_SCHEMA,
		},
		item: plan.items.map(renderNode),
		...(plan.auth === undefined ? {} : { auth: renderAuth(plan.auth) }),
		...(before.length === 0
			? {}
			: { event: [{ listen: "prerequest", script: { type: "text/javascript", exec: before } }] }),
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
	const tests = scriptOf(request);
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

/**
 * The test script: every assertion in plan order, or, where the request needs a value nothing in the
 * run produces, the same checks under the same names, reported skipped. **Skipped, never dropped**:
 * the count of assertions is the same whether or not the value was supplied, so a collection that
 * quietly stopped checking anything cannot read like one that passed.
 */
function scriptOf(request: PlanRequest): string[] {
	const scripts = request.assertions.map(renderAssertion);
	const guard = request.guard;
	if (guard === undefined) return scripts.flatMap((script) => [...script.lines]);
	/**
	 * **Unset means unset or empty.** A runner that always passes the flag and lets an undefined shell
	 * variable expand to nothing supplies an empty string, which is not the value the collection put
	 * there and is not an id either: the request would go to `/things/` and fail on checks that should
	 * be skipped.
	 */
	const pairs = JSON.stringify(guard.needs.map((need) => [need.variable, need.value]));
	const naming = guard.needs.map((need) => need.variable).join(" and ");
	return [
		`const unmet = ${pairs}.some(([name, placeholder]) =>`,
		"    !pm.variables.get(name) || pm.variables.get(name) === placeholder);",
		"if (unmet) {",
		...scripts.flatMap((script) =>
			script.name === undefined
				? []
				: [
						`    pm.test.skip(${JSON.stringify(`${script.name} (needs ${naming})`)}, function () {});`,
					],
		),
		"} else {",
		...scripts.flatMap((script) => script.lines.map((line) => `    ${line}`)),
		"}",
	];
}

/**
 * **A credential nobody supplied is not the service's fault, and a 401 cannot say which one it was.**
 * Postman sends an unset variable as an empty credential, so the run reads as a service refusing
 * every correct call. One script at the collection level, before the first request: it names what to
 * set, stops the run rather than repeating itself for every request, and leaves a non-zero exit.
 * Both halves measured on the Postman CLI.
 */
function credentialCheck(credentials: readonly string[]): string[] {
	if (credentials.length === 0) return [];
	const [first] = credentials;
	return [
		`const missing = ${JSON.stringify([...credentials])}.filter((name) => !pm.variables.get(name));`,
		"if (missing.length !== 0) {",
		"    pm.execution.setNextRequest(null);",
		'    throw new Error("This collection authenticates with " + missing.join(" and ") +',
		`        ", which this run has not set (--env-var ${first ?? ""}=...)");`,
		"}",
	];
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

/** One assertion's script: the `pm.test` name it reports under, and the lines it contributes. */
interface AssertionScript {
	readonly name: string | undefined;
	readonly lines: readonly string[];
}

/**
 * A `pm.test` block, in the form Postman's own snippets and templates write them. **The name is held
 * beside the lines rather than read back out of them**: a guarded request reports the same names as
 * skipped, and two copies of one name are two things that can drift.
 */
function test(
	name: string,
	body: readonly string[],
	after: readonly string[] = [],
): AssertionScript {
	return {
		name,
		lines: [
			`pm.test(${JSON.stringify(name)}, function () {`,
			...body.map((line) => `    ${line}`),
			"});",
			...after,
		],
	};
}

function renderAssertion(assertion: PlanAssertion): AssertionScript {
	switch (assertion.kind) {
		case "status":
			return renderStatus(assertion.codes);
		case "has-key":
			return test(
				`Response has ${/^[aeiou]/i.test(assertion.key) ? "an" : "a"} ${assertion.key}`,
				[`pm.expect(${jsonAt([assertion.key])}).to.be.a(${JSON.stringify(assertion.type)});`],
				[
					`pm.collectionVariables.set(${JSON.stringify(assertion.variable)}, ${jsonAt([assertion.key])});`,
				],
			);
		case "is-array":
			return test(
				assertion.path.length === 0
					? "Response is an array"
					: `Response ${assertion.path.join(".")} is an array`,
				[`pm.expect(${jsonAt(assertion.path)}).to.be.an("array");`],
			);
		case "key-matches":
			return test(`Returns the requested ${assertion.resource}`, [
				`pm.expect(String(${jsonAt([assertion.key])})).to.eql(pm.variables.get(${JSON.stringify(assertion.variable)}));`,
			]);
		case "field-updated":
			return test(`${assertion.field} was updated`, [
				`pm.expect(${jsonAt([assertion.field])}).to.eql(${JSON.stringify(assertion.value)});`,
			]);
		/**
		 * `headers.get(...)` with `include`, never `to.have.header(name, value)`: the second is exact
		 * equality and fails `application/json; charset=utf-8`. Measured on the Postman CLI.
		 */
		case "content-type": {
			const [only] = assertion.types;
			if (assertion.types.length === 1 && only !== undefined) {
				return test(`Content-Type header is ${only}`, [
					`pm.expect(String(pm.response.headers.get("Content-Type")).toLowerCase()).to.include(${JSON.stringify(only.toLowerCase())});`,
				]);
			}
			return test(`Content-Type header is one of ${assertion.types.join(", ")}`, [
				`const contentType = String(pm.response.headers.get("Content-Type")).toLowerCase();`,
				`pm.expect(${JSON.stringify(assertion.types.map((type) => type.toLowerCase()))}.some((type) => contentType.includes(type))).to.eql(true);`,
			]);
		}
		case "header-present":
			return test(`${assertion.name} header is present`, [
				`pm.response.to.have.header(${JSON.stringify(assertion.name)});`,
			]);
		/**
		 * **RFC 3986 resolution against the request is what makes this a real check.** A `Location` of
		 * `/things/1` behind a proxy that serves the API under a base path resolves to a URL with the
		 * base path gone - a location a client cannot follow, and one that a presence check reports as
		 * correct. `new URL` and `pm.request.url` are both the sandbox's own, measured on the CLI.
		 */
		case "location-created": {
			const collection = `pm.variables.replaceIn(${JSON.stringify(`{{baseUrl}}/${assertion.collection.join("/")}/`)})`;
			/**
			 * **The path, not the whole URL.** A service is entitled to answer its own canonical origin
			 * where a run reaches it through another - a test host, a tunnel, a local port - and
			 * comparing origins would fail it for being right. The path is where the defect this check
			 * exists for lives: a proxy serving the API under a base path forwards a `Location` written
			 * without one, and RFC 3986 resolution drops the base path.
			 */
			const head = [
				`const collection = new URL(${collection}).pathname;`,
				`const location = pm.response.headers.get("location");`,
				`pm.expect(location, "location header").to.be.a("string");`,
				`const resolved = new URL(location, pm.request.url.toString()).pathname;`,
			];
			const name = `location identifies the created ${assertion.spoken}`;
			if (!assertion.capture) {
				return test(name, [
					...head,
					`pm.expect(resolved).to.eql(collection + pm.collectionVariables.get(${JSON.stringify(assertion.variable)}));`,
				]);
			}
			return test(name, [
				...head,
				`pm.expect(resolved.startsWith(collection), "location under " + collection).to.be.true;`,
				`const id = resolved.slice(collection.length);`,
				`pm.expect(id, "one path segment").to.not.have.string("/");`,
				`pm.collectionVariables.set(${JSON.stringify(assertion.variable)}, id);`,
			]);
		}
		case "no-body":
			return test("Response has no body", ["pm.response.to.not.be.withBody;"]);
		/**
		 * `unknownFormats` names the formats Ajv 6 does not know, or `jsonSchema` throws on a valid body.
		 * With several statuses, the schema is the one for the status the response answered with; the
		 * status assertion already refuses a status the operation does not declare.
		 */
		case "json-schema": {
			const options = `{ unknownFormats: ${JSON.stringify(assertion.unknownFormats)} }`;
			const [only] = assertion.schemas;
			if (assertion.schemas.length === 1 && only !== undefined) {
				return test("Response matches the schema", [
					`pm.response.to.have.jsonSchema(${JSON.stringify(only.schema)}, ${options});`,
				]);
			}
			const byStatus = Object.fromEntries(
				assertion.schemas.map((entry) => [String(entry.status), entry.schema]),
			);
			return test("Response matches the schema for its status", [
				`const schemas = ${JSON.stringify(byStatus)};`,
				"pm.expect(schemas).to.have.property(String(pm.response.code));",
				`pm.response.to.have.jsonSchema(schemas[String(pm.response.code)], ${options});`,
			]);
		}
	}
}

function renderStatus(codes: readonly StatusMatch[]): AssertionScript {
	const [only] = codes;
	if (codes.length === 1 && typeof only === "number") {
		return test(`Status code is ${only}`, [`pm.response.to.have.status(${only});`]);
	}
	if (codes.length === 1 && only !== undefined && typeof only !== "number") {
		return test(`Status code is ${only.start} to ${only.end}`, [
			`pm.expect(pm.response.code).to.be.within(${only.start}, ${only.end});`,
		]);
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
		return test(`Status code is one of ${label}`, [
			`pm.expect(pm.response.code).to.be.oneOf([${exact.join(", ")}]);`,
		]);
	}
	return test(`Status code is one of ${label}`, [
		`pm.expect(${checks.join(" || ")}).to.eql(true);`,
	]);
}
