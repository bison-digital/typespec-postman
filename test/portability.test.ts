import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { compileSpec } from "./support/compile.js";
import { ownedSpecs, specLabel } from "./support/fixtures.js";

/**
 * **Nothing tracked or generated names one machine's filesystem, and everything is ASCII.**
 *
 * The generated half matters most: a consumer commits the collection, so a home-directory path or an
 * encoding that differs by platform lands in their repository and fails their drift check on the
 * next machine. Home directories are matched by shape, so the guard means the same thing anywhere.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const here = fileURLToPath(new URL(".", import.meta.url));

const MACHINE_PATHS = [
	/\/Users\/[^/\s"']+\//,
	/\/home\/[^/\s"']+\//,
	/\b[A-Za-z]:\\\\?Users\\\\?/,
	/\bfile:\/\/\/[A-Za-z]/,
];

/**
 * Vendored files are third-party bytes pinned by digest (`vendored.test.ts`); re-encoding one would
 * break the digest that proves it unedited. Nothing else is exempt.
 */
const VENDORED = /^test\/reference\/vendored\//;

let emitted: { label: string; text: string }[] = [];

beforeAll(async () => {
	emitted = [];
	for (const spec of ownedSpecs()) {
		const label = specLabel(spec);
		const compiled = await compileSpec(
			spec,
			join(here, ".out-portability", label.replaceAll("/", "__")),
		);
		for (const file of readdirSync(compiled.outDir).filter((name) => name.endsWith(".json"))) {
			emitted.push({ label: `${label} -> ${file}`, text: compiled.text(file) });
		}
	}
}, 900_000);

function nonAscii(text: string): string | undefined {
	// eslint-disable-next-line no-control-regex
	const match = /[^\x00-\x7F]/.exec(text);
	return match === null
		? undefined
		: `U+${(match[0].codePointAt(0) ?? 0).toString(16).toUpperCase()}`;
}

describe("nothing this package tracks or writes is tied to one machine", () => {
	const tracked = execFileSync("git", ["ls-files"], { cwd: packageRoot, encoding: "utf8" })
		.split("\n")
		.filter((name) => name !== "");

	it("has files to inspect at all", () => {
		expect(tracked.length).toBeGreaterThanOrEqual(30);
		expect(emitted.length).toBeGreaterThanOrEqual(10);
	});

	it("carries no machine path in any tracked file", () => {
		const offenders = tracked.flatMap((name) => {
			if (name === "test/portability.test.ts") return [];
			const text = readFileSync(join(packageRoot, name), "utf8");
			return MACHINE_PATHS.flatMap((pattern) =>
				pattern.test(text) ? [`${name}: ${pattern}`] : [],
			);
		});
		expect(offenders).toEqual([]);
	});

	it("carries no machine path in anything the emitter writes", () => {
		const offenders = emitted.flatMap(({ label, text }) =>
			MACHINE_PATHS.flatMap((pattern) => (pattern.test(text) ? [`${label}: ${pattern}`] : [])),
		);
		expect(offenders).toEqual([]);
	});

	it("is ASCII in every tracked file but the vendored ones", () => {
		const offenders = tracked.flatMap((name) => {
			if (VENDORED.test(name)) return [];
			const found = nonAscii(readFileSync(join(packageRoot, name), "utf8"));
			return found === undefined ? [] : [`${name}: ${found}`];
		});
		expect(offenders).toEqual([]);
	});

	it("writes ASCII only (escaping itself is graded in render/render.test.ts)", () => {
		const offenders = emitted.flatMap(({ label, text }) => {
			const found = nonAscii(text);
			return found === undefined ? [] : [`${label}: ${found}`];
		});
		expect(offenders).toEqual([]);
	});
});
