import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **No two suites compile into one directory.** Vitest runs files in parallel; two suites writing one
 * directory grade whichever compile finished last, and the failure looks exactly like a flaky emitter.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const SELF = "test/isolation.test.ts";

describe("no two suites share a compile destination", () => {
	const suites = execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "test"],
		{
			cwd: packageRoot,
			encoding: "utf8",
		},
	)
		.split("\n")
		.filter((name) => name.endsWith(".test.ts") && name !== SELF);

	it("has suites to inspect at all", () => {
		expect(suites.length).toBeGreaterThanOrEqual(15);
	});

	it("claims each output name exactly once across every suite", () => {
		const claims = new Map<string, string[]>();
		for (const suite of suites) {
			const text = readFileSync(join(packageRoot, suite), "utf8");
			const names = [
				...[...text.matchAll(/outName:\s*"([^"]+)"/g)].map((match) => match[1] ?? ""),
				...[...text.matchAll(/join\(here,\s*"(\.out[^"]*)",\s*"([^"$]+)"/g)].map(
					(match) => `${match[1]}/${match[2]}`,
				),
			];
			for (const name of new Set(names)) claims.set(name, [...(claims.get(name) ?? []), suite]);
		}
		expect([...claims.entries()].filter(([, files]) => files.length > 1)).toEqual([]);
		// Non-vacuity: a pattern that matched nothing would report no sharing either.
		expect(claims.size).toBeGreaterThanOrEqual(15);
	});
});
