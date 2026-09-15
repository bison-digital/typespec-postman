import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **This package is published open source and may name no private codebase, anywhere.**
 *
 * The sibling emitters carry a guard of this shape because a term from the codebase they were
 * extracted from was once a live defect rather than a comment: a `.filter(p => p.name !== "...")`
 * naming one application's tenant identifier, dropped from every consumer's generated input type
 * while the validator went on requiring it. Behaviour derived from nothing any document states.
 *
 * Here the stakes are higher in one specific way: those packages were extracted into a private
 * estate's repositories, and this one is written to be read by strangers. A docblock citing a
 * repository the reader cannot see explains nothing; a dependency naming a registry they cannot
 * reach does not install at all.
 *
 * Four classes are guarded, the fourth by digest.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * (a) Proper nouns: private scopes, registries, projects, templates. Nobody outside one estate has
 *     these, so any occurrence is a leak.
 * (b) Ordinary words used as if they named a specific component. The kind that READS generic and is
 *     not -- "the gateway asserts this" describes an arrangement the reader has no reason to have.
 * (c) Terms from a sibling package's dependency decisions, kept so the estate's guards stay one list.
 */
const FORBIDDEN: readonly RegExp[] = [
	// (a)
	/@bison\//,
	/\bnpm\.bison\.digital\b/,
	/\bBISON_NPM_TOKEN\b/,
	/\bcreate-bison\b/,
	/\bbison-mail\b/,
	/\bbison-post\b/,
	/\bcompany-manager\b/,
	/@cm\//,
	/\bcopal\b/,
	/\bagent-world\b/,
	/\bhono-gateway\b/,
	/\bauth-service\b/,
	/\bvault-service\b/,
	/\bmcp-service\b/,
	/\bworker-rpc\b/,
	// (b)
	/\bthe gateway\b/,
	/\bgateway's\b/,
	/\bthe estate\b/,
	/\bthe backend\b/,
	/\bthe domain\b/,
	// (c)
	/@modelcontextprotocol\/sdk\b/,
	/\bMcpAgent\b/,
	/\bagents\/mcp\b/,
];

/**
 * (d) The first consumer's private spec, which this package was verified against and must never
 *     quote: its product, repository and scheme names.
 *
 * **Held as SHA-256 digests of the exact terms, never as the terms.** A guard that spells a private
 * name publishes it, and the first version of this list did exactly that in a public repository. A
 * digest names nothing, and a tracked file that carries the term still hashes to it. Each term is a
 * word, or a hyphen-joined run of words, as {@link termsOf} reads a line.
 */
const FORBIDDEN_DIGESTS: ReadonlySet<string> = new Set([
	"7c4f01b9770663e38975ccb451cd12daeb296a57a4ae302e06351905d80234bf",
	"faa11e532b06ac71174fd097ba2d84ac63e0da04232905818c2f8f18d25ff0a5",
	"39d0d3d571e88b8c0c451b69099c055c3d338109fb5fec4141597507f7209ebf",
	"c52d4ec9ecf44fad6e5244abd2b9aba13d3d25a97453a95ad5641705e4cdfa0f",
	"93040afde9f39a8ddff1cec4980f84d999ba770317f519460299eda48c5ca56b",
	"12ff97f65f937c37234932bf59faf2ead78100e6bc2926731b074e39712aead3",
	"b3aa250265e58a7f1cb449acf14aa9093200172fc82b20cfbfa6bf7ffdb432b0",
	"cbc2d2b20d29284de1b47ea40edb9731e035bfe719368f52ca3c984525569367",
]);

/**
 * A term that names nothing, scanned for beside the private ones, so the positive control can plant a
 * term the matcher must find without the control spelling a private one. Assembled at run time, so no
 * tracked file carries it as one word.
 */
const CANARY = ["provenance", "canary"].join("-");
const CANARY_DIGEST = "2618fb4a0978c83bdcb1b1bf6d7a1352487c7ef4828833c17af74be40ec1c3de";
const SCANNED_DIGESTS: ReadonlySet<string> = new Set([...FORBIDDEN_DIGESTS, CANARY_DIGEST]);

/**
 * Every word a line carries, and every run of hyphen-joined words: `a-b-c` yields a, b, c, a-b, b-c,
 * a-b-c. **A backslash escape separates words**, so a term spelled inside a regular expression
 * (`\\bterm\\b`) or a string escape (`\\nterm`) is still read as the term; without that, the
 * spelling that leaked the first time would pass this scan.
 */
function termsOf(line: string): string[] {
	const terms: string[] = [];
	for (const [token] of line
		.replace(/\\[A-Za-z]/g, " ")
		.matchAll(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g)) {
		const words = token.split("-");
		for (let start = 0; start < words.length; start++) {
			for (let end = start + 1; end <= words.length; end++)
				terms.push(words.slice(start, end).join("-"));
		}
	}
	return terms;
}

/** Lines of `text` carrying a term whose digest is in `digests`, reported by line and digest prefix, never by term. */
function digestHits(file: string, text: string, digests: ReadonlySet<string>): string[] {
	const hits: string[] = [];
	text.split("\n").forEach((line, i) => {
		for (const term of termsOf(line)) {
			const digest = createHash("sha256").update(term).digest("hex");
			if (digests.has(digest)) hits.push(`${file}:${i + 1} sha256:${digest.slice(0, 12)}`);
		}
	});
	return hits;
}

/**
 * Hosts this package may cite. **An allowlist, because a blocklist only catches what someone thought
 * of**, and the whole risk here is a private hostname nobody knew to forbid.
 */
const ALLOWED_HOSTS = [
	/**
	 * Loopback, which appears in `docs/releasing.md`'s local-registry recipe. It is not a private
	 * host: it names no machine anyone else could reach, which is the whole point of the recipe.
	 * Note the separate and stricter rule in `portability.test.ts` -- emitted output may name no
	 * host at all, loopback included, because that would be the emitter choosing a deployment.
	 */
	"localhost",
	// The loopback address the run suite's generated server listens on; no machine anyone else reaches.
	"127.0.0.1",
	"github.com",
	"registry.npmjs.org",
	"www.npmjs.com",
	"npmjs.com",
	"typespec.io",
	"modelcontextprotocol.io",
	"developers.cloudflare.com",
	"json-schema.org",
	"www.iana.org",
	"datatracker.ietf.org",
	"www.rfc-editor.org",
	"zod.dev",
	"schema.getpostman.com",
	"schema.postman.com",
	"learning.postman.com",
	"dl-cli.pstmn.io",
	"keepachangelog.com",
	"semver.org",
	"json.schemastore.org",
	"spdx.org",
	"opensource.org",
];

/**
 * Hostnames RFC 2606 and RFC 6761 reserve for documentation and testing.
 *
 * **Allowed as a CLASS rather than one at a time.** These are guaranteed to resolve to nothing,
 * anywhere, which is exactly why a doc or a fixture should use one -- and enumerating
 * `example.test`, then `widgets.example.com`, then the next one is how an allowlist rots into a
 * list of whatever somebody happened to write.
 */
function isReserved(host: string): boolean {
	return (
		/(^|\.)(example|test|invalid|localhost)$/.test(host) ||
		/(^|\.)example\.(com|net|org)$/.test(host)
	);
}

/** Every file git tracks: source, tests, docs, workflows, manifests. Not just `src/`. */
function trackedFiles(): string[] {
	const out = execFileSync("git", ["ls-files"], { cwd: packageRoot, encoding: "utf8" });
	return out.split("\n").filter((line) => line.trim() !== "");
}

const TEXT = /\.(ts|tsp|md|json|jsonc|ya?ml|txt)$/;
/**
 * Third-party files copied verbatim and pinned by digest (`vendored.test.ts`). Their text is their
 * authors', and editing it to satisfy this guard would break the digest that proves it unedited.
 */
const VENDORED = /^test\/reference\/vendored\//;
/** This file names every forbidden term by definition; scanning it makes the rule unsatisfiable. */
const SELF = "test/provenance.test.ts";

describe("the package names no private codebase", () => {
	const files = trackedFiles().filter((f) => TEXT.test(f) && f !== SELF && !VENDORED.test(f));

	it("has files to inspect at all", () => {
		// Without this, every arm below passes the day `git ls-files` returns nothing.
		expect(files.length).toBeGreaterThanOrEqual(10);
	});

	it("names no forbidden term, in any tracked file", () => {
		const hits: string[] = [];
		for (const file of files) {
			const lines = readFileSync(join(packageRoot, file), "utf8").split("\n");
			lines.forEach((line, i) => {
				for (const pattern of FORBIDDEN) {
					if (pattern.test(line)) hits.push(`${file}:${i + 1} ${pattern} :: ${line.trim()}`);
				}
			});
		}
		// Reported with file, line and term: a bare count sends the reader hunting.
		expect(hits).toEqual([]);
	});

	/**
	 * **The positive control, and without it the arm above is worth nothing.** A regex change, or a
	 * filter that quietly dropped every file, reports a clean sweep exactly like a clean package
	 * does. This proves the scanner can still see.
	 */
	it("the scanner actually detects every term it claims to", () => {
		// Un-escape the pattern source into the literal text it matches: drop word boundaries, and
		// turn an escaped character back into itself.
		const synthetic = FORBIDDEN.map((pattern) =>
			pattern.source.replace(/\\b/g, "").replace(/\\(.)/g, "$1"),
		).join("\n");
		const undetected = FORBIDDEN.filter((p) => !p.test(synthetic));
		expect(undetected).toEqual([]);
		expect(FORBIDDEN.length).toBeGreaterThanOrEqual(23);
	});

	/**
	 * **Every tracked text file, this one included**, because this file no longer spells any term it
	 * guards by digest. The vendored files are the only exemption, for the reason above.
	 */
	it("names no private consumer term, by digest, in any tracked file", () => {
		const hits = trackedFiles()
			.filter((f) => TEXT.test(f) && !VENDORED.test(f))
			.flatMap((file) =>
				digestHits(file, readFileSync(join(packageRoot, file), "utf8"), SCANNED_DIGESTS),
			);
		expect(hits).toEqual([]);
	});

	it("the digest matcher finds a planted term, alone, inside a hyphenated run, and nowhere else", () => {
		expect(createHash("sha256").update(CANARY).digest("hex")).toBe(CANARY_DIGEST);
		expect(digestHits("planted", `a ${CANARY} b`, SCANNED_DIGESTS)).toHaveLength(1);
		expect(digestHits("planted", `x-${CANARY}-y`, SCANNED_DIGESTS)).toHaveLength(1);
		expect(digestHits("planted", `/\\b${CANARY}\\b/,`, SCANNED_DIGESTS)).toHaveLength(1);
		expect(digestHits("planted", "provenance canaryx", SCANNED_DIGESTS)).toEqual([]);
		// Non-vacuity: the scan above reads files that carry text at all.
		expect(trackedFiles().filter((f) => TEXT.test(f)).length).toBeGreaterThanOrEqual(30);
	});

	/**
	 * **The list may not shrink.** Removing a term to make a change pass is the failure this pins
	 * against: it would go green quietly, which is the one thing a guard must never do.
	 */
	it("keeps every term it has ever had", () => {
		expect(FORBIDDEN.length + FORBIDDEN_DIGESTS.size).toBe(31);
		expect([...FORBIDDEN_DIGESTS].every((digest) => /^[0-9a-f]{64}$/.test(digest))).toBe(true);
	});

	it("cites no host outside the allowlist", () => {
		const hits: string[] = [];
		for (const file of files) {
			const text = readFileSync(join(packageRoot, file), "utf8");
			for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
				const host = match[1] ?? "";
				if (!ALLOWED_HOSTS.includes(host) && !isReserved(host)) hits.push(`${file} :: ${host}`);
			}
		}
		expect(hits).toEqual([]);
	});
});

/**
 * The publisher's own identity is NOT a leak -- but it is bounded, and stated rather than left to
 * the absence of a pattern.
 *
 * `bison-digital` is the GitHub organisation this package is published from and `Bison Digital` is
 * the copyright holder, so both are legitimate published metadata that a stranger can resolve. The
 * PRIVATE forms -- the `@bison/` npm scope and the `npm.bison.digital` registry -- are forbidden
 * above and neither is reachable outside one network.
 *
 * **Written as a shape rather than as a blanket allowance**, because a reader who saw only "bison is
 * allowed" would simplify the two rules into one and disarm the guard that matters.
 */
describe("the publisher's identity appears only where it belongs", () => {
	/**
	 * `test/attribution.test.ts` compares against the publishing identity, so it must spell it.
	 * Listed by NAME rather than by a pattern that would permit the domain anywhere under
	 * `test/`, because the point of this arm is that the exception stays countable.
	 */
	const PERMITTED = ["LICENSE", "package.json", "test/attribution.test.ts"];

	it("names the organisation in no other tracked file", () => {
		const hits = trackedFiles()
			.filter((f) => TEXT.test(f) && f !== SELF && !PERMITTED.includes(f))
			.filter((f) => /bison[-. ]digital/i.test(readFileSync(join(packageRoot, f), "utf8")));
		expect(hits).toEqual([]);
	});

	it("and the permitted files really do carry it, so this arm is not vacuous", () => {
		const carriers = PERMITTED.filter((f) =>
			/bison[-. ]digital/i.test(readFileSync(join(packageRoot, f), "utf8")),
		);
		expect(carriers.toSorted()).toEqual([...PERMITTED].toSorted());
	});
});

describe("the package installs for a stranger", () => {
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<
		string,
		Record<string, string> | undefined
	>;

	it("declares no dependency from a private scope, in any map", () => {
		const maps = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
		const bad: string[] = [];
		for (const map of maps) {
			for (const name of Object.keys(manifest[map] ?? {})) {
				if (name.startsWith("@bison/") || name.startsWith("@cm/")) bad.push(`${map}: ${name}`);
			}
		}
		expect(bad).toEqual([]);
		// Non-vacuity: a manifest declaring nothing would satisfy the line above.
		expect(Object.keys(manifest["peerDependencies"] ?? {}).length).toBeGreaterThanOrEqual(2);
	});

	it("names no registry but the public one", () => {
		const suspects = trackedFiles().filter((f) => /(^|\/)\.npmrc$|pnpm-workspace\.yaml$/.test(f));
		for (const file of suspects) {
			const text = readFileSync(join(packageRoot, file), "utf8");
			for (const match of text.matchAll(/registry\s*=\s*(\S+)/g)) {
				expect(match[1]).toContain("registry.npmjs.org");
			}
			expect(text).not.toMatch(/npm\.bison\.digital/);
		}
	});
});
