import {
	getNamespaceFullName,
	interpolatePath,
	listServices,
	type Namespace,
	type Program,
	sanitizePathSegment,
} from "@typespec/compiler";
import { unsafe_mutateSubgraphWithNamespace } from "@typespec/compiler/experimental";
import { getAllHttpServices, getHttpService, type HttpService } from "@typespec/http";
import { DEFAULT_OUTPUT_FILE, type EmitterOptions } from "./lib.js";

/** The subset of `@typespec/versioning` this module calls. */
interface VersioningModule {
	getVersioningMutators(
		program: Program,
		namespace: Namespace,
	):
		| { kind: "transient"; mutator: unknown }
		| { kind: "versioned"; snapshots: { mutator: unknown; version?: { value: string } }[] }
		| undefined;
}

/**
 * `@typespec/versioning`, when the consumer has it installed. It is an optional peer: a spec that
 * does not version needs nothing from it, and importing it unconditionally would make every consumer
 * install a package their spec never names.
 */
async function resolveVersioning(): Promise<VersioningModule | undefined> {
	try {
		return (await import("@typespec/versioning")) as unknown as VersioningModule;
	} catch {
		return undefined;
	}
}

export interface SelectedService {
	readonly service: HttpService;
	/** The service namespace's full name, the key `services.<name>` is matched on. */
	readonly fullName: string;
	/** Relative to `emitter-output-dir`. */
	readonly outputFile: string;
}

/**
 * Every service to emit, each projected to its current version, with the file it is written to.
 *
 * **The LAST version snapshot, as `@typespec/openapi3` and the sibling emitters take it.** Without a
 * projection `getHttpService` returns every operation any version ever declared, so a collection
 * would call operations the current server no longer serves.
 */
export async function selectServices(
	program: Program,
	options: EmitterOptions,
): Promise<SelectedService[]> {
	const versioning = await resolveVersioning();
	const services = projectedServices(program, versioning);
	const multiple = services.length > 1;
	const selected: SelectedService[] = [];
	for (const service of services) {
		const fullName = getNamespaceFullName(service.namespace);
		if (options.services?.[fullName]?.["emit-collection"] === false) continue;
		const serviceName = sanitizePathSegment(fullName);
		selected.push({
			service,
			fullName,
			outputFile: interpolatePath(options["output-file"] ?? DEFAULT_OUTPUT_FILE, {
				"service-name": serviceName,
				"service-name-if-multiple": multiple ? serviceName : undefined,
			}),
		});
	}
	return selected;
}

function projectedServices(
	program: Program,
	versioning: VersioningModule | undefined,
): HttpService[] {
	const [unversioned] = getAllHttpServices(program);
	if (versioning === undefined) return unversioned;
	const projected: HttpService[] = [];
	for (const declared of listServices(program)) {
		const mutators = versioning.getVersioningMutators(program, declared.type);
		if (mutators === undefined) {
			const match = unversioned.find((candidate) => candidate.namespace === declared.type);
			if (match !== undefined) projected.push(match);
			continue;
		}
		const mutator =
			mutators.kind === "transient" ? mutators.mutator : mutators.snapshots.at(-1)?.mutator;
		if (mutator === undefined) continue;
		const subgraph = unsafe_mutateSubgraphWithNamespace(
			program,
			[mutator as Parameters<typeof unsafe_mutateSubgraphWithNamespace>[1][number]],
			declared.type,
		);
		if (subgraph.type.kind !== "Namespace") continue;
		const [service] = getHttpService(program, subgraph.type);
		projected.push(service);
	}
	return projected.length === 0 ? unversioned : projected;
}
