import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **What a stranger reading or installing this package depends on, checked rather than
 * remembered.** Each rule has a non-vacuity arm beside it: a rule that passes on an empty file list or
 * an empty manifest passes on a broken one too.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** Every file git tracks: source, tests, docs, workflows, manifests. Not just `src/`. */
function trackedFiles(): string[] {
	const out = execFileSync("git", ["ls-files"], { cwd: packageRoot, encoding: "utf8" });
	return out.split("\n").filter((line) => line.trim() !== "");
}

const TEXT = /\.(ts|tsp|md|json|jsonc|ya?ml|txt)$/;
/** Third-party data, pinned by digest in `vendored.test.ts`; its hosts are its publisher's. */
const VENDORED = /^test\/reference\/vendored\//;
/** This file spells every pattern it checks for, so it is not scanned by them. */
const SELF = "test/boundaries.test.ts";
const files = trackedFiles().filter((f) => TEXT.test(f) && f !== SELF && !VENDORED.test(f));

/** Hosts a reader can reach, which a citation here has reason to name. */
const ALLOWED_HOSTS = [
	"localhost",
	// The loopback address the run suite's generated server listens on.
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

/** RFC 2606 / 6761 names, which resolve nowhere by design. */
function isReserved(host: string): boolean {
	return (
		/(^|\.)(example|test|invalid|localhost)$/.test(host) ||
		/(^|\.)example\.(com|net|org)$/.test(host)
	);
}

describe("the package cites only hosts a reader can reach", () => {
	it("has files to inspect at all", () => {
		// Without this, every arm below passes the day `git ls-files` returns nothing.
		expect(files.length).toBeGreaterThanOrEqual(10);
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
 * **The publisher's name is published metadata, and it is bounded.** The copyright holder in
 * `LICENSE` and the repository in `package.json` are where a stranger expects it; anywhere else it is
 * a reference to something the reader cannot see.
 */
describe("the publisher's name appears only where it belongs", () => {
	const PERMITTED = ["LICENSE", "package.json"];
	const PUBLISHER = /bison[-. ]digital/i;

	it("names the organisation in no other tracked file", () => {
		const hits = files
			.filter((f) => !PERMITTED.includes(f))
			.filter((f) => PUBLISHER.test(readFileSync(join(packageRoot, f), "utf8")));
		expect(hits).toEqual([]);
	});

	it("and the permitted files really do carry it, so the arm above is not vacuous", () => {
		const carriers = PERMITTED.filter((f) =>
			PUBLISHER.test(readFileSync(join(packageRoot, f), "utf8")),
		);
		expect(carriers.toSorted()).toEqual([...PERMITTED].toSorted());
	});
});

describe("the package installs for a stranger", () => {
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as Record<
		string,
		Record<string, string> | undefined
	>;
	const MAPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
	/** Scopes published on the public registry. A dependency from any other scope will not install. */
	const PUBLIC_SCOPES = ["@hono", "@types", "@typespec"];

	it("declares scoped dependencies only from public scopes, in every map", () => {
		const scoped = MAPS.flatMap((map) =>
			Object.keys(manifest[map] ?? {})
				.filter((name) => name.startsWith("@"))
				.map((name) => ({ map, name })),
		);
		expect(scoped.length).toBeGreaterThanOrEqual(1);
		const unknown = scoped.filter(({ name }) => !PUBLIC_SCOPES.includes(name.split("/")[0] ?? ""));
		expect(unknown.map(({ map, name }) => `${map}: ${name}`)).toEqual([]);
	});

	it("names no registry but the public one", () => {
		const suspects = trackedFiles().filter((f) => /(^|\/)\.npmrc$|pnpm-workspace\.yaml$/.test(f));
		for (const file of suspects) {
			const text = readFileSync(join(packageRoot, file), "utf8");
			for (const match of text.matchAll(/registry\s*=\s*(\S+)/g)) {
				expect(match[1]).toContain("registry.npmjs.org");
			}
		}
	});
});
