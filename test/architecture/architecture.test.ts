import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **The boundaries, pinned.** Derivations read the program and produce a `CollectionPlan`; the
 * renderer turns a plan into Postman JSON and never sees a TypeSpec type. The split is what lets a
 * rule live in one place: a renderer that reached the compiler could start deciding things too.
 */

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const srcDir = join(packageRoot, "src");

/** Imports as the compiler sees them: comments and template literals stripped first. */
function importsOf(file: string): string[] {
	const raw = readFileSync(join(srcDir, file), "utf8");
	const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/`(?:[^`\\]|\\.)*`/gs, "``");
	return [...code.matchAll(/^\s*(?:import|export)\s[\s\S]*?from\s+"([^"]+)"/gm)].map(
		(match) => match[1] ?? "",
	);
}

const MODULES = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));

/** Every module and external package a module reaches, following local imports. */
function closure(file: string, seen = new Set<string>()): Set<string> {
	for (const specifier of importsOf(file)) {
		if (specifier.startsWith("./")) {
			const local = specifier.slice(2).replace(/\.js$/, ".ts");
			if (!seen.has(local)) {
				seen.add(local);
				closure(local, seen);
			}
		} else if (!specifier.startsWith("node:")) {
			seen.add(specifier);
		}
	}
	return seen;
}

const externalsOf = (file: string) =>
	[...closure(file)].filter((name) => !name.endsWith(".ts")).toSorted();

describe("the module graph", () => {
	it("found the modules it grades", () => {
		expect(MODULES.length).toBeGreaterThanOrEqual(15);
		for (const expected of ["render.ts", "model.ts", "emitter.ts", "lib.ts"])
			expect(MODULES).toContain(expected);
	});

	it("has no import cycle", () => {
		expect(MODULES.filter((file) => closure(file).has(file))).toEqual([]);
	});
});

describe("the renderer renders, and the derivations derive", () => {
	it("the renderer and the plan never reach the TypeSpec compiler, even transitively", () => {
		for (const file of ["render.ts", "model.ts", "ids.ts", "names.ts", "uri.ts"]) {
			expect(externalsOf(file), file).toEqual([]);
		}
		// Non-vacuity: the renderer does import local modules, so the closure is being walked.
		expect([...closure("render.ts")]).toContain("ids.ts");
	});

	it("only the entry point imports the orchestrator", () => {
		expect(
			MODULES.filter((file) => file !== "emitter.ts" && importsOf(file).includes("./emitter.js")),
		).toEqual(["index.ts"]);
	});
});

describe("facts are declared once", () => {
	it("the package name is a literal in exactly one module, and matches package.json", () => {
		const declaring = MODULES.filter((file) =>
			readFileSync(join(srcDir, file), "utf8").includes('"typespec-postman"'),
		);
		expect(declaring).toEqual(["lib.ts"]);
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
			name: string;
		};
		expect(readFileSync(join(srcDir, "lib.ts"), "utf8")).toContain(
			`export const PACKAGE_NAME = "${manifest.name}"`,
		);
	});
});
