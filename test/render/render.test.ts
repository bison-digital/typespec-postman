import { describe, expect, it } from "vitest";
import type { CollectionPlan } from "../../src/model.js";
import { renderCollection } from "../../src/render.js";

/**
 * **The renderer on its own, for the properties no ASCII fixture can reach.** A TypeSpec string has
 * no Unicode escape and the fixtures are ASCII by rule, so text outside ASCII can only reach the
 * renderer from a consumer's spec. It is built here from TypeScript escapes.
 */

const plan = (description: string): CollectionPlan => ({
	name: "Escapes",
	description,
	identity: "Escapes",
	auth: undefined,
	variables: [],
	credentials: [],
	items: [],
});

describe("text outside ASCII", () => {
	// Built from code points: a formatter rewrites `\u` escapes in a string literal into the characters.
	const text = `Caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x201c)}quoted${String.fromCodePoint(0x201d)} ${String.fromCodePoint(0x1f600)}`;

	it("is written as JSON escapes, so the file is ASCII", () => {
		const rendered = renderCollection(plan(text));
		// eslint-disable-next-line no-control-regex
		expect(/[^\x00-\x7F]/.test(rendered)).toBe(false);
		expect(rendered).toContain("Caf\\u00e9 \\u201cquoted\\u201d \\ud83d\\ude00");
	});

	it("and those escapes read back as exactly the original string", () => {
		const parsed = JSON.parse(renderCollection(plan(text))) as { info: { description: string } };
		expect(parsed.info.description).toBe(text);
	});
});

describe("stable output", () => {
	it("derives the collection id from identity alone, formatted as a version 8 UUID", () => {
		const first = JSON.parse(renderCollection(plan("a"))) as { info: { _postman_id: string } };
		const second = JSON.parse(renderCollection(plan("b"))) as { info: { _postman_id: string } };
		expect(first.info._postman_id).toBe(second.info._postman_id);
		expect(first.info._postman_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("ends with exactly one newline and indents with tabs", () => {
		const rendered = renderCollection(plan("a"));
		expect(rendered.endsWith("}\n")).toBe(true);
		expect(rendered.split("\n")[1]?.startsWith("\t")).toBe(true);
	});
});

/**
 * **Every string a spec gives a capture script reaches it as a JSON literal**, so none can end the
 * string it is in: a key, a variable, a typename and a path segment each carrying a quote, a
 * backslash, a newline and code meant to run. The script still parses, and run against an answer
 * it sets only the variable it names, to the id the answer holds.
 */
describe("a capture script built from hostile strings", () => {
	const hostile = `x"+(pm.collectionVariables.set("pwned","yes"),"")+"\\\n'\u2028`;
	const capture = (paths: Readonly<Record<string, readonly string[] | null>>): CollectionPlan => ({
		...plan("hostile"),
		items: [
			{
				kind: "request",
				identity: "hostile",
				name: "mutation create",
				description: undefined,
				method: "POST",
				url: { path: ["graphql"], query: [], variables: [], hash: undefined },
				headers: [],
				body: undefined,
				auth: undefined,
				assertions: [
					{ kind: "graphql-captures", key: hostile, type: "string", variable: hostile, paths },
				],
				guard: undefined,
			},
		],
	});
	const scriptOf = (rendered: string): string => {
		const collection = JSON.parse(rendered) as {
			item: { event: { script: { exec: string[] } }[] }[];
		};
		return collection.item[0]?.event[0]?.script.exec.join("\n") ?? "";
	};
	const run = (script: string, answer: unknown): Map<string, unknown> => {
		const variables = new Map<string, unknown>();
		const expect_ = (value: unknown) => ({
			to: {
				be: {
					a: (type: string) => {
						if (typeof value !== type) throw new Error(`not a ${type}`);
					},
					an: (type: string) => {
						const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
						if (kind !== type) throw new Error(`not an ${type}`);
					},
				},
			},
		});
		const pm = {
			test: (_name: string, body: () => void) => body(),
			expect: expect_,
			response: { json: () => answer },
			collectionVariables: {
				set: (key: string, value: unknown) => variables.set(key, value),
				unset: (key: string) => variables.delete(key),
			},
		};
		new Function("pm", script)(pm);
		return variables;
	};

	it("parses, and sets only its own variable, read by one path", () => {
		const script = scriptOf(renderCollection(capture({ Book: [hostile, hostile] })));
		const variables = run(script, { data: { [hostile]: { [hostile]: "b1" } } });
		expect([...variables]).toEqual([[hostile, "b1"]]);
	});

	it("parses, and sets only its own variable, read by the member's typename", () => {
		const script = scriptOf(
			renderCollection(capture({ [hostile]: [hostile, hostile], Accepted: null })),
		);
		const variables = run(script, {
			data: { [hostile]: { __typename: hostile, [hostile]: "b2" } },
		});
		expect([...variables]).toEqual([[hostile, "b2"]]);
	});
});
