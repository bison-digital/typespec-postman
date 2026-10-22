import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codes, compileFixture } from "../support/compile.js";

/**
 * **Several services in one program: one collection each**, named the way `@typespec/openapi3`
 * names its documents, so the two artefacts of one service sit side by side under matching names.
 */

const here = fileURLToPath(new URL(".", import.meta.url));

describe("several services in one program", () => {
	it("writes one collection per service, named for it", async () => {
		const compiled = await compileFixture(here, "services", { outName: "services-default" });
		expect(readdirSync(compiled.outDir).toSorted()).toEqual([
			"BackOffice.postman_collection.json",
			"Storefront.postman_collection.json",
		]);
		expect(compiled.collection("Storefront.postman_collection.json").info.name).toBe("Storefront");
		expect(
			compiled.collection("BackOffice.postman_collection.json").item.map((item) => item.name),
		).toEqual(["orders"]);
	});

	it("gives each collection its own id", async () => {
		const compiled = await compileFixture(here, "services", { outName: "services-ids" });
		expect(compiled.collection("Storefront.postman_collection.json").info._postman_id).not.toBe(
			compiled.collection("BackOffice.postman_collection.json").info._postman_id,
		);
	});

	it("withholds a service whose emit-collection is false, without renaming the other's file", async () => {
		const compiled = await compileFixture(here, "services", {
			outName: "services-withheld",
			postman: { services: { BackOffice: { "emit-collection": false } } },
		});
		// `{service-name-if-multiple}` counts the services the PROGRAM declares, as openapi3 does, so a
		// file's name does not change because an option withheld a different service.
		expect(readdirSync(compiled.outDir)).toEqual(["Storefront.postman_collection.json"]);
	});

	it("writes neither, and reports it, when output-file sends both to one path", async () => {
		const compiled = await compileFixture(here, "services", {
			outName: "services-shared",
			postman: { "output-file": "api.postman_collection.json" },
		});
		expect(existsSync(`${compiled.outDir}/api.postman_collection.json`)).toBe(false);
		expect(codes(compiled)).toEqual(["typespec-postman/shared-output-file"]);
	});
});
