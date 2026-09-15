import {
	type CallableMessage,
	createTypeSpecLibrary,
	type DiagnosticReport,
	type JSONSchemaType,
	paramMessage,
	type Program,
	type TypeSpecLibrary,
} from "@typespec/compiler";

/**
 * This emitter's name, as `tspconfig.yaml`, the compiler and every diagnostic code spell it.
 *
 * **One literal.** A second copy that drifted would name a library the compiler never loads, and
 * nothing would say so. `test/architecture/architecture.test.ts` asserts it appears nowhere else.
 */
export const PACKAGE_NAME = "typespec-postman";

/**
 * The options this emitter accepts. **Genuine choices only**: where the collection is written,
 * whether shared auth sits on the collection object, and which services are emitted. Everything
 * else the collection says is derived from the spec, so there is nothing else to configure.
 */
export interface EmitterOptions {
	/**
	 * The file written per service, relative to `emitter-output-dir`. Interpolated exactly as
	 * `@typespec/openapi3` interpolates its own `output-file`, with `{service-name}` and
	 * `{service-name-if-multiple}`.
	 */
	"output-file"?: string;
	/** Whether auth the service namespace declares is set on the collection object itself. */
	"collection-auth"?: boolean;
	/** Per-service overrides, keyed by the service namespace's full name. */
	services?: Record<string, { "emit-collection"?: boolean }>;
}

export const DEFAULT_OUTPUT_FILE = "{service-name-if-multiple}.postman_collection.json";

const EmitterOptionsSchema: JSONSchemaType<EmitterOptions> = {
	type: "object",
	additionalProperties: false,
	properties: {
		"output-file": { type: "string", nullable: true },
		"collection-auth": { type: "boolean", nullable: true },
		services: {
			type: "object",
			nullable: true,
			required: [],
			additionalProperties: {
				type: "object",
				additionalProperties: false,
				properties: { "emit-collection": { type: "boolean", nullable: true } },
				required: [],
			},
		},
	},
	required: [],
};

/**
 * **Every diagnostic is a warning, never an error.** An error sets `program.hasError()`, and every
 * emitter in the same compile, `@typespec/openapi3` included, then writes nothing. A collection
 * that cannot express one operation perfectly must not cost the consumer their published document.
 */
const diagnostics = {
	"unrepresentable-auth": {
		severity: "warning",
		messages: {
			default: paramMessage`Operation '${"operation"}' requires ${"schemes"} together. A Postman request sends one Authorization header, so '${"dropped"}' is not sent.`,
		},
	},
	"body-not-runnable": {
		severity: "warning",
		messages: {
			default: paramMessage`The request body of operation '${"operation"}' is ${"kind"}, which cannot be generated to run unattended. The request is emitted with a '${"mode"}' body a person has to complete.`,
		},
	},
	"unsatisfiable-value": {
		severity: "warning",
		messages: {
			default: paramMessage`No value could be generated for '${"target"}' that satisfies ${"constraint"}. Declare an @example for it.`,
		},
	},
	"unserializable-example": {
		severity: "warning",
		messages: {
			default: paramMessage`The example for '${"target"}' could not be serialized (${"reason"}), so a generated value is used instead.`,
		},
	},
	"update-without-example": {
		severity: "warning",
		messages: {
			default: paramMessage`Update operation '${"operation"}' has no @opExample, so no assertion that a field was updated can be derived.`,
			empty: paramMessage`Update operation '${"operation"}' has no @opExample and its body has no required property, so the request sends an empty object and no assertion that a field was updated can be derived.`,
		},
	},
	"unnamed-resource": {
		severity: "warning",
		messages: {
			default: paramMessage`Operation '${"operation"}' creates a resource whose body model has no name, so its id is not chained to later requests.`,
		},
	},
	"variable-collision": {
		severity: "warning",
		messages: {
			default: paramMessage`Collection variable '${"variable"}' is claimed by ${"first"} and by ${"second"}. The first claim is kept, and the second does not get a variable of its own.`,
		},
	},
	"order-cycle": {
		severity: "warning",
		messages: {
			default: paramMessage`No request order satisfies every dependency, because a folder runs all of its requests together. These are not kept: ${"operations"}.`,
		},
	},
	"no-success-response": {
		severity: "warning",
		messages: {
			default: paramMessage`Operation '${"operation"}' declares no 2xx response, so no status assertion is generated for it.`,
		},
	},
	"schema-unavailable": {
		severity: "warning",
		messages: {
			default: paramMessage`No response schema could be read for service '${"service"}' (${"reason"}), so its responses are not checked against a schema.`,
		},
	},
	"shared-output-file": {
		severity: "warning",
		messages: {
			default: paramMessage`Services ${"services"} all resolve to '${"path"}', so none of them is written. Put '{service-name}' in 'output-file'.`,
		},
	},
} as const;

/**
 * Written out rather than inferred. An inferred `$lib` type names the compiler's internal
 * declaration files, which reports `TS2883` as not portable whenever two compiler copies resolve.
 */
type Diagnostics = {
	"unrepresentable-auth": {
		readonly default: CallableMessage<["operation", "schemes", "dropped"]>;
	};
	"body-not-runnable": { readonly default: CallableMessage<["operation", "kind", "mode"]> };
	"unsatisfiable-value": { readonly default: CallableMessage<["target", "constraint"]> };
	"unserializable-example": { readonly default: CallableMessage<["target", "reason"]> };
	"update-without-example": {
		readonly default: CallableMessage<["operation"]>;
		readonly empty: CallableMessage<["operation"]>;
	};
	"unnamed-resource": { readonly default: CallableMessage<["operation"]> };
	"variable-collision": { readonly default: CallableMessage<["variable", "first", "second"]> };
	"order-cycle": { readonly default: CallableMessage<["operations"]> };
	"no-success-response": { readonly default: CallableMessage<["operation"]> };
	"shared-output-file": { readonly default: CallableMessage<["services", "path"]> };
	"schema-unavailable": { readonly default: CallableMessage<["service", "reason"]> };
};

export const $lib: TypeSpecLibrary<Diagnostics, EmitterOptions> = createTypeSpecLibrary({
	name: PACKAGE_NAME,
	capabilities: { dryRun: true },
	diagnostics,
	emitter: { options: EmitterOptionsSchema },
});

export const reportDiagnostic: <C extends keyof Diagnostics, M extends keyof Diagnostics[C]>(
	program: Program,
	diagnostic: DiagnosticReport<Diagnostics, C, M>,
) => void = $lib.reportDiagnostic;

export { EmitterOptionsSchema };
