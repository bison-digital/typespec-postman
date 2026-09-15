import { getDoc, type Interface, type Namespace, type Program } from "@typespec/compiler";
import {
	getAuthentication,
	type Authentication,
	type HttpAuth,
	type HttpOperation,
	type HttpService,
	resolveAuthentication,
} from "@typespec/http";
import { reportDiagnostic } from "./lib.js";
import type { AuthSetting, PlanAuth, PlanParam, PlanVariable } from "./model.js";
import { camelCase } from "./names.js";

/**
 * What one operation, interface or namespace requires, as Postman can carry it.
 *
 * **A Postman auth object holds one scheme**, while TypeSpec lets an operation require several at
 * once (`@useAuth([A, B])`). The split: at most one scheme that writes `Authorization` goes in the
 * auth object, and every API key travels as the header, query or cookie parameter its scheme names.
 * When the requirement is only API keys, the first header or query key goes in the auth object so
 * that folders and the collection can still share it.
 */
export interface Requirement {
	readonly setting: AuthSetting;
	/** Headers (including `Cookie`) and query parameters that carry the rest of the requirement. */
	readonly headers: readonly PlanParam[];
	readonly query: readonly PlanParam[];
}

const NO_AUTH: Requirement = { setting: { kind: "none" }, headers: [], query: [] };

export interface AuthDerivation {
	/** The requirement the service namespace itself declares, or `undefined` when it declares none. */
	readonly service: Requirement | undefined;
	/** The requirement a container declares on itself, or `undefined` when it inherits. */
	declaredOn(container: Interface | Namespace): Requirement | undefined;
	/** What an operation effectively requires. */
	forOperation(operation: HttpOperation): Requirement;
	/** Every credential variable the requirements above reference, in first-use order. */
	readonly credentials: readonly PlanVariable[];
}

export function deriveAuth(program: Program, service: HttpService): AuthDerivation {
	/**
	 * Called first, and for a reason beyond its result: when two different schemes share a name, it
	 * renames the later one IN PLACE (appending `_`), and those are the same objects
	 * `getAuthentication` returns below. Reading ids before this call would name one credential for
	 * two schemes.
	 */
	const resolved = resolveAuthentication(service);
	const credentials = new Map<string, PlanVariable>();

	const credential = (key: string, scheme: HttpAuth): string => {
		if (!credentials.has(key)) {
			credentials.set(key, {
				key,
				value: "",
				// An empty description is no description; fall back to the doc on the scheme's model.
				description: nonEmpty(scheme.description) ?? nonEmpty(getDoc(program, scheme.model)),
			});
		}
		return key;
	};

	const map = (
		options: readonly (readonly HttpAuth[])[],
		operationName: string,
		report: boolean,
	): Requirement => {
		/**
		 * **The first option that carries a credential.** An option of only `NoAuth` means anonymous
		 * access is ALSO allowed; sending a credential the spec accepts is valid under both readings,
		 * and it exercises the scheme a deployment check most needs to reach.
		 */
		const chosen =
			options.find((option) => option.some((scheme) => scheme.type !== "noAuth")) ?? undefined;
		if (chosen === undefined) return NO_AUTH;
		const schemes = chosen.filter((scheme) => scheme.type !== "noAuth");
		const authorization = schemes.filter((scheme) => scheme.type !== "apiKey");
		const apiKeys = schemes.filter((scheme) => scheme.type === "apiKey");
		if (report && authorization.length > 1) {
			reportDiagnostic(program, {
				code: "unrepresentable-auth",
				format: {
					operation: operationName,
					schemes: authorization.map((scheme) => `'${scheme.id}'`).join(" and "),
					dropped: authorization
						.slice(1)
						.map((scheme) => scheme.id)
						.join("', '"),
				},
				target: authorization[1]?.model ?? service.namespace,
			});
		}
		const headers: PlanParam[] = [];
		const query: PlanParam[] = [];
		const cookies: string[] = [];
		let setting: AuthSetting | undefined;

		const [primary] = authorization;
		if (primary !== undefined) {
			const variable = camelCase(primary.id);
			switch (primary.type) {
				case "http":
					if (primary.scheme.toLowerCase() === "bearer") {
						setting = {
							kind: "scheme",
							scheme: { type: "bearer", variable: credential(variable, primary) },
						};
					} else if (primary.scheme.toLowerCase() === "basic") {
						setting = {
							kind: "scheme",
							scheme: {
								type: "basic",
								username: credential(`${variable}Username`, primary),
								password: credential(`${variable}Password`, primary),
							},
						};
					} else {
						// A scheme Postman has no helper for is still a header the spec fully determines.
						setting = { kind: "none" };
						headers.push({
							key: "Authorization",
							value: `${primary.scheme} {{${credential(variable, primary)}}}`,
							disabled: false,
							description: undefined,
						});
					}
					break;
				case "oauth2":
				case "openIdConnect":
					setting = {
						kind: "scheme",
						scheme: { type: "oauth2", variable: credential(variable, primary) },
					};
					break;
			}
		}
		for (const key of apiKeys) {
			if (key.type !== "apiKey") continue;
			const variable = credential(camelCase(key.id), key);
			if (setting === undefined && key.in !== "cookie") {
				const scheme: PlanAuth = { type: "apikey", name: key.name, in: key.in, variable };
				setting = { kind: "scheme", scheme };
				continue;
			}
			if (key.in === "header") {
				headers.push({
					key: key.name,
					value: `{{${variable}}}`,
					disabled: false,
					description: undefined,
				});
			} else if (key.in === "query") {
				query.push({
					key: key.name,
					value: `{{${variable}}}`,
					disabled: false,
					description: undefined,
				});
			} else {
				cookies.push(`${key.name}={{${variable}}}`);
			}
		}
		if (cookies.length > 0) {
			headers.push({
				key: "Cookie",
				value: cookies.join("; "),
				disabled: false,
				description: undefined,
			});
		}
		return { setting: setting ?? { kind: "none" }, headers, query };
	};

	const fromAuthentication = (authentication: Authentication, name: string): Requirement =>
		map(
			authentication.options.map((option) => option.schemes),
			name,
			false,
		);

	const operationCache = new Map<HttpOperation, Requirement>();
	const containerCache = new Map<Interface | Namespace, Requirement | undefined>();

	const serviceRequirement =
		resolved.defaultAuth.options.length === 0
			? undefined
			: map(
					resolved.defaultAuth.options.map((option) => option.all.map((ref) => ref.auth)),
					service.namespace.name,
					false,
				);

	return {
		service: serviceRequirement,
		declaredOn(container) {
			if (!containerCache.has(container)) {
				const authentication = getAuthentication(program, container);
				containerCache.set(
					container,
					authentication === undefined
						? undefined
						: fromAuthentication(authentication, container.name),
				);
			}
			return containerCache.get(container);
		},
		forOperation(operation) {
			let requirement = operationCache.get(operation);
			if (requirement === undefined) {
				const reference = resolved.operationsAuth.get(operation.operation) ?? resolved.defaultAuth;
				requirement =
					reference.options.length === 0
						? NO_AUTH
						: map(
								reference.options.map((option) => option.all.map((ref) => ref.auth)),
								operation.operation.name,
								true,
							);
				operationCache.set(operation, requirement);
			}
			return requirement;
		},
		get credentials() {
			return [...credentials.values()];
		},
	};
}

function nonEmpty(text: string | undefined): string | undefined {
	return text === undefined || text.trim() === "" ? undefined : text;
}

/** Two auth settings send the same credentials. */
export function sameSetting(a: AuthSetting | undefined, b: AuthSetting | undefined): boolean {
	return JSON.stringify(a ?? { kind: "none" }) === JSON.stringify(b ?? { kind: "none" });
}
