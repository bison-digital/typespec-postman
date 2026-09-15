/**
 * The collection as this emitter decides it, before any Postman JSON is written.
 *
 * **Compiler-free on purpose.** Everything that reads the TypeSpec program produces one of these, and
 * `render.ts` turns one into text without ever seeing a TypeSpec type. That split is what lets the
 * renderer be graded on its own and keeps a decision from being made twice, once in each half.
 */

export interface CollectionPlan {
	readonly name: string;
	readonly description: string | undefined;
	/** What the collection's id is derived from. */
	readonly identity: string;
	readonly auth: AuthSetting | undefined;
	readonly variables: readonly PlanVariable[];
	readonly items: readonly PlanNode[];
}

export interface PlanVariable {
	readonly key: string;
	readonly value: string;
	readonly description: string | undefined;
}

export type PlanNode = PlanFolder | PlanRequest;

export interface PlanFolder {
	readonly kind: "folder";
	readonly identity: string;
	readonly name: string;
	readonly description: string | undefined;
	/** `undefined` inherits from the parent. */
	readonly auth: AuthSetting | undefined;
	readonly items: readonly PlanNode[];
}

export interface PlanRequest {
	readonly kind: "request";
	readonly identity: string;
	readonly name: string;
	readonly description: string | undefined;
	readonly method: string;
	readonly url: PlanUrl;
	readonly headers: readonly PlanParam[];
	readonly body: PlanBody | undefined;
	/** `undefined` inherits from the parent. */
	readonly auth: AuthSetting | undefined;
	readonly assertions: readonly PlanAssertion[];
}

/** `none` is an explicit `noauth`: it stops an inherited scheme reaching this request. */
export type AuthSetting =
	| { readonly kind: "none" }
	| { readonly kind: "scheme"; readonly scheme: PlanAuth };

export type PlanAuth =
	| {
			readonly type: "apikey";
			readonly name: string;
			readonly in: "header" | "query";
			readonly variable: string;
	  }
	| { readonly type: "bearer"; readonly variable: string }
	| { readonly type: "basic"; readonly username: string; readonly password: string }
	| { readonly type: "oauth2"; readonly variable: string };

export interface PlanParam {
	readonly key: string;
	readonly value: string;
	readonly disabled: boolean;
	readonly description: string | undefined;
}

export interface PlanUrl {
	/** Path segments as Postman stores them: a literal, `:name`, or text carrying `{{variable}}`. */
	readonly path: readonly string[];
	readonly query: readonly PlanParam[];
	/** One entry per `:name` segment. */
	readonly variables: readonly PlanParam[];
	readonly hash: string | undefined;
}

export type PlanBody =
	| { readonly mode: "raw"; readonly raw: string; readonly language: "json" | "text" }
	| { readonly mode: "urlencoded"; readonly fields: readonly PlanParam[] }
	| { readonly mode: "formdata"; readonly parts: readonly PlanFormPart[] }
	| { readonly mode: "file" };

export type PlanFormPart =
	| {
			readonly type: "text";
			readonly key: string;
			readonly value: string;
			readonly contentType: string | undefined;
	  }
	| { readonly type: "file"; readonly key: string };

/**
 * An assertion as data. The script text is the renderer's job, so the rule deciding WHEN an
 * assertion applies and the text saying WHAT it checks live in exactly one place each.
 */
export type PlanAssertion =
	| { readonly kind: "status"; readonly codes: readonly StatusMatch[] }
	| {
			readonly kind: "has-key";
			readonly key: string;
			readonly type: "string" | "number";
			readonly variable: string;
	  }
	| { readonly kind: "is-array"; readonly path: readonly string[] }
	| {
			readonly kind: "key-matches";
			readonly key: string;
			readonly variable: string;
			readonly resource: string;
	  }
	| {
			readonly kind: "field-updated";
			readonly field: string;
			readonly value: string | number | boolean;
	  }
	/** The response's media type is one the operation declares for the status it answers with. */
	| { readonly kind: "content-type"; readonly types: readonly string[] }
	/** A header every declared response for the expected statuses marks required. */
	| { readonly kind: "header-present"; readonly name: string }
	/** Every declared response for the expected statuses has no body. */
	| { readonly kind: "no-body" }
	/**
	 * The body satisfies the schema declared for the status the response answers with, as draft-07
	 * the Postman sandbox checks. One entry per status.
	 */
	| {
			readonly kind: "json-schema";
			readonly schemas: readonly { readonly status: number; readonly schema: unknown }[];
			readonly unknownFormats: readonly string[];
	  };

export type StatusMatch = number | { readonly start: number; readonly end: number };
