import { type EmitContext, emitFile, NoTarget, resolvePath } from "@typespec/compiler";
import { deriveCollection } from "./collection.js";
import { graphqlRequestsIn, graphqlUrlOf } from "./graphql.js";
import { type EmitterOptions, reportDiagnostic } from "./lib.js";
import { renderCollection } from "./render.js";
import { loadResponseSchemas } from "./schemas.js";
import { selectServices } from "./select.js";

/**
 * Write one Postman collection per selected service.
 *
 * **Nothing is written when the program has errors or the compile is a dry run**, matching
 * `@typespec/openapi3`. `noEmit` needs no check here: the compiler does not call an emitter at all
 * under it.
 */
export async function $onEmit(context: EmitContext<EmitterOptions>): Promise<void> {
	const { program } = context;
	if (program.compilerOptions.dryRun || program.hasError()) return;

	const selected = await selectServices(program, context.options);
	// Read once: the warnings it raises are about the compile, not about any one service.
	const graphql = graphqlRequestsIn(program);
	const byPath = new Map<string, string[]>();
	for (const entry of selected)
		byPath.set(entry.outputFile, [...(byPath.get(entry.outputFile) ?? []), entry.fullName]);

	for (const entry of selected) {
		const sharing = byPath.get(entry.outputFile) ?? [];
		if (sharing.length > 1) continue;
		const schemas = await loadResponseSchemas(program, entry.service);
		const requests = graphql?.get(entry.fullName);
		const plan = deriveCollection(
			program,
			entry.service,
			{
				collectionAuth: context.options["collection-auth"] !== false,
				...(requests === undefined
					? {}
					: {
							graphql: {
								requests,
								url: graphqlUrlOf(program, context.options, entry.fullName),
							},
						}),
			},
			schemas,
		);
		await emitFile(program, {
			path: resolvePath(context.emitterOutputDir, entry.outputFile),
			content: renderCollection(plan),
		});
	}

	for (const [path, services] of byPath) {
		if (services.length < 2) continue;
		reportDiagnostic(program, {
			code: "shared-output-file",
			format: { services: services.map((name) => `'${name}'`).join(", "), path },
			target: NoTarget,
		});
	}
}
