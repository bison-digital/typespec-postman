import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type Compiled,
	codes,
	compileFixture,
	folderNamed,
	headerOf,
	type PostmanCollection,
	requestNamed,
} from "../support/compile.js";

/**
 * **Auth comes from the resolved requirements, and sits where the spec declares it.** The service's
 * `@useAuth` is the collection's auth, an interface's is its folder's, and an operation carries an
 * override only where what it requires differs from what it inherits, which is the rule
 * `@typespec/openapi3` applies to `security`. Credentials are variables, never literals.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
let compiled: Compiled;
let collection: PostmanCollection;

const bearer = {
	type: "bearer",
	bearer: [{ key: "token", value: "{{bearerAuth}}", type: "string" }],
};
const shopKey = {
	type: "apikey",
	apikey: [
		{ key: "key", value: "X-Shop-Key", type: "string" },
		{ key: "value", value: "{{shopKey}}", type: "string" },
		{ key: "in", value: "header", type: "string" },
	],
};

beforeAll(async () => {
	compiled = await compileFixture(here, "auth", { outName: "auth" });
	collection = compiled.collection();
}, 180_000);

describe("where auth sits", () => {
	it("puts the service's requirement on the collection", () => {
		expect(collection.auth).toEqual(bearer);
	});

	it("lets an operation that inherits it carry no auth of its own", () => {
		expect(requestNamed(collection, "inherited").request?.auth).toBeUndefined();
	});

	it("puts an interface's requirement on its folder", () => {
		expect(folderNamed(collection, "Keyed").auth).toEqual(shopKey);
		expect(requestNamed(collection, "read", "Keyed").request?.auth).toBeUndefined();
	});

	it("overrides per request where an operation differs from its folder", () => {
		expect(requestNamed(collection, "write", "Keyed").request?.auth).toEqual(bearer);
		expect(requestNamed(collection, "remove", "Keyed").request?.auth).toEqual({
			type: "basic",
			basic: [
				{ key: "username", value: "{{basicAuthUsername}}", type: "string" },
				{ key: "password", value: "{{basicAuthPassword}}", type: "string" },
			],
		});
	});

	it("sends no credential where the operation declares NoAuth, even under collection auth", () => {
		expect(requestNamed(collection, "open").request?.auth).toEqual({ type: "noauth" });
	});

	it("still sends the credential where anonymous access is only an alternative", () => {
		expect(requestNamed(collection, "optional").request?.auth).toBeUndefined();
	});
});

describe("requirements Postman's single auth object cannot hold", () => {
	it("sends an API key required alongside a bearer token as its header", () => {
		const both = requestNamed(collection, "both");
		expect(both.request?.auth).toBeUndefined();
		expect(headerOf(both, "X-Shop-Key")?.value).toBe("{{shopKey}}");
	});

	it("puts the first of two API keys in the auth object and the second where its scheme says", () => {
		const keys = requestNamed(collection, "keys");
		expect(keys.request?.auth).toEqual(shopKey);
		expect(keys.request?.url.query).toEqual([{ key: "key", value: "{{queryKey}}" }]);
	});

	it("sends a cookie API key as a Cookie header, which Postman's apikey helper cannot", () => {
		const cookie = requestNamed(collection, "cookie");
		expect(cookie.request?.auth).toEqual({ type: "noauth" });
		expect(headerOf(cookie, "Cookie")?.value).toBe("session={{sessionCookie}}");
	});

	it("writes an HTTP scheme Postman has no helper for as its Authorization header", () => {
		const signed = requestNamed(collection, "signed");
		expect(signed.request?.auth).toEqual({ type: "noauth" });
		expect(headerOf(signed, "Authorization")?.value).toBe("Signature {{signature}}");
	});

	it("reports two schemes that both need the Authorization header, and sends the first", () => {
		expect(codes(compiled)).toContain("typespec-postman/unrepresentable-auth");
		expect(
			compiled.diagnostics.find((d) => d.code === "typespec-postman/unrepresentable-auth")?.message,
		).toContain("'BasicAuth' is not sent");
		expect(requestNamed(collection, "twoAuthorizations").request?.auth).toBeUndefined();
	});

	it("maps OAuth2 to Postman's oauth2 helper, fed by a token variable", () => {
		expect(requestNamed(collection, "oauth").request?.auth).toEqual({
			type: "oauth2",
			oauth2: [
				{ key: "accessToken", value: "{{oAuth2Auth}}", type: "string" },
				{ key: "addTokenTo", value: "header", type: "string" },
			],
		});
	});
});

describe("credentials", () => {
	it("are collection variables named for the scheme, with no value", () => {
		const credentials = (collection.variable ?? []).filter(
			(variable) => variable.key !== "baseUrl",
		);
		expect(credentials.map((variable) => variable.key)).toEqual([
			"bearerAuth",
			"shopKey",
			"queryKey",
			"sessionCookie",
			"signature",
			"oAuth2Auth",
			"basicAuthUsername",
			"basicAuthPassword",
		]);
		expect(credentials.every((variable) => variable.value === "")).toBe(true);
	});

	it("never appear as a literal anywhere in the collection", () => {
		const text = compiled.text();
		for (const variable of collection.variable ?? []) {
			if (variable.key === "baseUrl") continue;
			// Every mention of a credential is the {{reference}}, never a value.
			expect(text.split(`"${variable.key}"`).length - 1, variable.key).toBe(1);
		}
	});

	it("carry the scheme's own description", () => {
		expect(collection.variable?.find((variable) => variable.key === "shopKey")?.description).toBe(
			"The key issued to a shop.",
		);
	});
});

describe("collection-auth: false", () => {
	let off: PostmanCollection;
	beforeAll(async () => {
		off = (
			await compileFixture(here, "auth", {
				outName: "auth-off",
				postman: { "collection-auth": false },
			})
		).collection();
	}, 180_000);

	it("sets no auth on the collection object", () => {
		expect(off.auth).toBeUndefined();
	});

	it("and moves it to the requests that inherited it, so every request still authenticates", () => {
		expect(requestNamed(off, "inherited").request?.auth).toEqual(bearer);
		expect(requestNamed(off, "open").request?.auth).toBeUndefined();
		expect(folderNamed(off, "Keyed").auth).toEqual(shopKey);
	});
});
