import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { $lib, EmitterOptionsSchema } from "../src/lib.js";

/**
 * **The documentation and the code say the same thing, graded in both directions**, each computed from
 * `$lib` or the tree rather than from a list someone keeps: every option and diagnostic is documented
 * and nothing documented is gone, and every suite has a row in `docs/oracles.md` and no row names one
 * that is gone.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) => readFileSync(join(packageRoot, file), "utf8");
const reference = read("docs/reference.md");
const readme = read("README.md");
const changelog = read("CHANGELOG.md");
const oracles = read("docs/oracles.md");

const schema = EmitterOptionsSchema as unknown as {
	properties: Record<string, unknown> & {
		services: { additionalProperties: { properties: Record<string, unknown> } };
	};
};

describe("the reference documents every option", () => {
	const topLevel = Object.keys(schema.properties).filter((name) => name !== "services");
	const perService = Object.keys(schema.properties.services.additionalProperties.properties);
	const documented = [...reference.matchAll(/^\|\s*`([a-z.<>-]+)`\s*\|/gm)].map(
		(match) => match[1] ?? "",
	);

	it("has options to check at all", () => {
		expect(topLevel.length).toBeGreaterThanOrEqual(2);
		expect(perService.length).toBeGreaterThanOrEqual(1);
	});

	it("documents every option", () => {
		const expected = [...topLevel, ...perService.map((name) => `services.<name>.${name}`)];
		expect(expected.filter((name) => !documented.includes(name))).toEqual([]);
	});

	it("documents no option that does not exist", () => {
		const known = new Set([...topLevel, ...perService.map((name) => `services.<name>.${name}`)]);
		expect(documented.filter((name) => !known.has(name))).toEqual([]);
	});
});

describe("the reference documents every diagnostic", () => {
	const codes = Object.keys($lib.diagnostics);
	const section = reference.slice(reference.indexOf("## Diagnostics"));

	it("gives every diagnostic a section with a remedy, and documents none that is gone", () => {
		expect(codes.length).toBeGreaterThanOrEqual(8);
		const documented = [...section.matchAll(/^### `([a-z-]+)`$/gm)].map((match) => match[1] ?? "");
		expect(codes.filter((code) => !documented.includes(code))).toEqual([]);
		expect(documented.filter((code) => !codes.includes(code))).toEqual([]);
		for (const code of codes) {
			const body = section.slice(section.indexOf(`### \`${code}\``)).split(/\n### /)[0] ?? "";
			expect(body, code).toContain("Remedy:");
		}
	});

	it("declares no diagnostic that nothing can raise", () => {
		// `lib.ts` declares every code, so it is excluded: scanning it would make this pass for all.
		const sources = readdirSync(join(packageRoot, "src"))
			.filter((name) => name.endsWith(".ts") && name !== "lib.ts")
			.map((name) => read(join("src", name)))
			.join("\n");
		expect(codes.filter((code) => !sources.includes(`"${code}"`))).toEqual([]);
		expect(sources.length).toBeGreaterThanOrEqual(5000);
	});

	it("states that every diagnostic is a warning, and why", () => {
		expect(reference).toContain("never errors");
		expect(reference).toContain("hasError");
		expect(
			Object.values($lib.diagnostics).every((diagnostic) => diagnostic.severity === "warning"),
		).toBe(true);
	});
});

describe("the documentation set holds together", () => {
	it("the README links every document, and every link resolves", () => {
		for (const doc of [
			"docs/reference.md",
			"docs/guides.md",
			"docs/oracles.md",
			"docs/releasing.md",
			"CHANGELOG.md",
			"HANDOVER.md",
		]) {
			expect(readme, doc).toContain(`(${doc})`);
		}
		const linked = [...readme.matchAll(/\]\(([^)#]+)\)/g)]
			.map((match) => match[1] ?? "")
			.filter((link) => !link.startsWith("http"));
		expect(linked.filter((link) => !existsSync(join(packageRoot, link)))).toEqual([]);
	});

	it("the changelog has a section for the version package.json names, in the form the release workflow reads", () => {
		const { version } = JSON.parse(read("package.json")) as { version: string };
		expect(changelog).toMatch(new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\] - `, "m"));
		expect(read(".github/workflows/release.yml")).toContain('awk -v v="## [$version]"');
	});

	it("names every test suite as a row in docs/oracles.md, and no suite that is gone", () => {
		const suites: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.name.startsWith(".out")) continue;
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name.endsWith(".test.ts"))
					suites.push(relative(packageRoot, full).replaceAll("\\", "/"));
			}
		};
		walk(join(packageRoot, "test"));
		expect(suites.length).toBeGreaterThanOrEqual(20);
		expect(suites.filter((suite) => !oracles.includes(`\`${suite}\``))).toEqual([]);
		const named = [...oracles.matchAll(/`(test\/[^`]+\.test\.ts)`/g)].map(
			(match) => match[1] ?? "",
		);
		expect([...new Set(named)].filter((suite) => !suites.includes(suite))).toEqual([]);
	});
});
