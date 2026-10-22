import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Every `.tsp` this repository owns, found rather than listed, so a sweep can never be narrower than
 * the fixtures that exist: a new fixture is swept the moment it is added.
 */
export function ownedSpecs(): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry.startsWith(".") || entry === "dist") continue;
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (entry.endsWith(".tsp") && !full.includes(`${join("lib", "main.tsp")}`))
				found.push(full);
		}
	};
	walk(join(root, "test"));
	walk(join(root, "example"));
	return found.toSorted();
}

export function specLabel(file: string): string {
	return relative(root, file).replaceAll("\\", "/");
}
