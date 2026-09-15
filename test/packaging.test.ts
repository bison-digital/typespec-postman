import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * **What a stranger gets when they install this package.** Every other suite runs inside the
 * checkout, where a source file importing an undeclared package still works. This one reads the
 * manifest as a consumer's install would, and the real tarball `pnpm pack` produces.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
	name: string;
	license?: string;
	repository?: unknown;
	files: readonly string[];
	publishConfig?: { access?: string; provenance?: boolean };
	exports: Record<string, Record<string, string>>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	dependencies?: Record<string, string>;
};

/** `@scope/name/sub` -> `@scope/name`; builtins and relative paths are not packages. */
function packageOf(specifier: string): string | undefined {
	if (specifier.startsWith(".") || specifier.startsWith("node:")) return undefined;
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

describe("the package declares what it needs to run outside this checkout", () => {
	const sources = readdirSync(join(packageRoot, "src")).filter((name) => name.endsWith(".ts"));
	const imported = new Set(
		sources.flatMap((name) => {
			const text = readFileSync(join(packageRoot, "src", name), "utf8");
			return [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)]
				.map((match) => packageOf(match[1] ?? ""))
				.filter((value): value is string => value !== undefined);
		}),
	);

	it("has source to inspect at all", () => {
		expect(imported.size).toBeGreaterThanOrEqual(2);
	});

	it("declares every package src/ imports as a peer, and depends on nothing at run time", () => {
		const declared = new Set(Object.keys(manifest.peerDependencies ?? {}));
		expect([...imported].filter((name) => !declared.has(name))).toEqual([]);
		// The output is JSON: nothing this emitter writes imports anything, so it has no dependencies.
		expect(manifest.dependencies ?? {}).toEqual({});
	});

	it("marks versioning optional, because only a versioned spec needs it", () => {
		expect(manifest.peerDependenciesMeta?.["@typespec/versioning"]?.optional).toBe(true);
	});

	it("names ranges, never paths", () => {
		for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
			expect(`${name}: ${range}`).not.toMatch(/\b(?:file|link|portal):/);
		}
	});
});

describe("the package is configured to publish the way it claims", () => {
	it("declares public access, provenance and a licence", () => {
		expect(manifest.publishConfig?.access).toBe("public");
		expect(manifest.publishConfig?.provenance).toBe(true);
		expect(manifest.license).toBe("MIT");
		expect(manifest.repository).toBeDefined();
	});

	it("tells adopters to install it as a devDependency", () => {
		expect(readFileSync(join(packageRoot, "README.md"), "utf8")).toContain("devDependency");
	});

	it("has a release workflow that publishes only from a tag, with provenance", () => {
		const workflow = readFileSync(join(packageRoot, ".github", "workflows", "release.yml"), "utf8");
		expect(workflow).toMatch(/id-token:\s*write/);
		expect(workflow).toMatch(/--provenance/);
		expect(workflow).toMatch(/tags:\s*\["v\*"\]/);
		expect(workflow).not.toMatch(/branches:\s*\[\s*["']?main/);
	});

	it("runs every gate in CI, by name, including the system suites that need the Postman CLI", () => {
		const ci = readFileSync(join(packageRoot, ".github", "workflows", "ci.yml"), "utf8");
		for (const gate of [
			"pnpm build",
			"pnpm test",
			"pnpm typecheck",
			"pnpm lint",
			"pnpm format:check",
			"postman",
		]) {
			expect(ci, gate).toContain(gate);
		}
	});
});

describe("the tarball", () => {
	let workspace = "";
	let extracted = "";

	beforeAll(() => {
		workspace = mkdtempSync(join(tmpdir(), "typespec-postman-pack-"));
		const output = execFileSync("pnpm", ["pack", "--pack-destination", workspace], {
			cwd: packageRoot,
			encoding: "utf8",
		});
		const tarball = output
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.endsWith(".tgz"))
			.at(-1);
		expect(tarball, output).toBeDefined();
		execFileSync("tar", ["-xzf", tarball ?? "", "-C", workspace]);
		extracted = join(workspace, "package");
	}, 300_000);

	afterAll(() => {
		if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
	});

	it("ships every path its entry points resolve to", () => {
		for (const entry of Object.values(manifest.exports)) {
			for (const target of Object.values(entry))
				expect(existsSync(join(extracted, target)), target).toBe(true);
		}
		expect(existsSync(join(extracted, "LICENSE"))).toBe(true);
		expect(existsSync(join(extracted, "README.md"))).toBe(true);
	});

	it("ships no tests, fixtures or example output", () => {
		expect(existsSync(join(extracted, "dist", "test"))).toBe(false);
		expect(existsSync(join(extracted, "test"))).toBe(false);
		expect(existsSync(join(extracted, "example"))).toBe(false);
	});
});
