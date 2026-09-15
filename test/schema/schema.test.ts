import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { compileSpec } from "../support/compile.js";
import { ownedSpecs, specLabel } from "../support/fixtures.js";

/**
 * **Every collection this emitter writes is valid against Postman's own schema for the format.** The
 * schema is vendored from Postman (see `test/reference/vendored/PROVENANCE.md`), so the expectation
 * comes from the format's owner rather than from this emitter's idea of it.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * `ajv-draft-04` ships CommonJS with a `default` export, which TypeScript's `nodenext` and vitest read
 * differently. Required and typed by the two calls this suite makes, so both agree on it.
 */
interface DraftValidator {
	(data: unknown): boolean;
	errors?: unknown;
}
const Ajv = (
	createRequire(import.meta.url)("ajv-draft-04") as {
		default: new (options: object) => {
			compile(schema: object): DraftValidator;
			errorsText(errors?: unknown): string;
		};
	}
).default;
const schema = JSON.parse(
	readFileSync(
		fileURLToPath(new URL("../reference/vendored/postman-collection-v2.1.0.json", import.meta.url)),
		"utf8",
	),
) as Record<string, unknown>;

const collections: { label: string; collection: unknown }[] = [];

beforeAll(async () => {
	for (const spec of ownedSpecs()) {
		const label = specLabel(spec);
		const compiled = await compileSpec(
			spec,
			join(here, ".out", "schema", label.replaceAll("/", "__")),
		);
		for (const file of readdirSync(compiled.outDir).filter((name) => name.endsWith(".json"))) {
			collections.push({
				label: `${label} -> ${file}`,
				collection: JSON.parse(compiled.text(file)),
			});
		}
	}
}, 900_000);

describe("the Postman Collection v2.1 schema", () => {
	it("found collections to validate, from every fixture", () => {
		expect(collections.length).toBeGreaterThanOrEqual(ownedSpecs().length);
	});

	it("accepts every collection the emitter wrote", () => {
		const ajv = new Ajv({ allErrors: true, strict: false });
		const validate = ajv.compile(schema);
		const failures = collections.flatMap(({ label, collection }) =>
			validate(collection) ? [] : [`${label}: ${ajv.errorsText(validate.errors)}`],
		);
		expect(failures).toEqual([]);
	});

	it("and rejects a collection that breaks it, so the arm above can fail", () => {
		const ajv = new Ajv({ allErrors: true, strict: false });
		const validate = ajv.compile(schema);
		const broken = structuredClone(collections[0]?.collection) as { item: { request?: unknown }[] };
		broken.item = [{ request: { method: 42 } }];
		expect(validate(broken)).toBe(false);
	});
});
