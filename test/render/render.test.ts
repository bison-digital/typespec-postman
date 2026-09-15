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
