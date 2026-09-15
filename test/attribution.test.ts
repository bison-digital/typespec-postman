import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **Nothing here credits a tool for the work, in the files or in the history.**
 *
 * The history half is the one that cannot be corrected. A commit message is written once, never
 * looked at again, and cannot be edited after it is pushed without rewriting every hash below it --
 * and on a public repository it is exactly as visible as the source.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The single identity this project publishes under.
 *
 * **This string is why `test/attribution.test.ts` is on the permitted list in
 * `provenance.test.ts`.** The domain appears here because the arms below have to compare against
 * it; it is not a reference to a private codebase, and the two rules are kept separate deliberately.
 */
const PUBLISHED_IDENTITY = "zach@bison.digital";

const ATTRIBUTION = [
	/\bCo-authored-by:\s*(?!.*<[^>]*\bzach@)/i,
	/\bgenerated (?:with|by)\b[^\n]*\b(?:AI|assistant|model|copilot)\b/i,
	/\bClaude\b/i,
	/\bAnthropic\b/i,
	/\bChatGPT\b/i,
	/\bOpenAI\b/i,
	/\bCopilot\b/i,
	/\bCursor\b/i,
	/\bGemini\b/i,
	/\bLLM-generated\b/i,
	/\bAI[- ]generated\b/i,
	/\bwritten by an? (?:AI|assistant|model)\b/i,
];

function git(...args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd: packageRoot,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
}

const TEXT = /\.(ts|tsp|md|json|jsonc|ya?ml|txt)$/;
const SELF = "test/attribution.test.ts";

describe("the package credits no tool for the work", () => {
	const files = git("ls-files")
		.split("\n")
		.filter((n) => n !== "" && TEXT.test(n) && n !== SELF);

	it("has files and history to inspect at all", () => {
		expect(files.length).toBeGreaterThanOrEqual(10);
		expect(git("rev-list", "--count", "HEAD").trim()).not.toBe("0");
	});

	it("names no assistant, model or vendor in any tracked file", () => {
		const offenders = files.flatMap((name) => {
			const text = readFileSync(`${packageRoot}/${name}`, "utf8");
			return ATTRIBUTION.flatMap((pattern) => {
				const match = pattern.exec(text);
				return match === null ? [] : [`${name}: ${match[0]}`];
			});
		});
		expect(offenders).toEqual([]);
	});

	it("names none in any commit message, over the whole history", () => {
		const messages = git("log", "--all", "--format=%H%n%B%n%(trailers)");
		const offenders = ATTRIBUTION.flatMap((pattern) => {
			const match = pattern.exec(messages);
			return match === null ? [] : [`history: ${match[0]}`];
		});
		expect(offenders).toEqual([]);
	});

	it("carries exactly one identity, the one this project publishes under", () => {
		const identities = new Set(
			git("log", "--all", "--format=%ae%n%ce")
				.split("\n")
				.filter((line) => line !== ""),
		);
		expect([...identities]).toEqual([PUBLISHED_IDENTITY]);
	});
});
