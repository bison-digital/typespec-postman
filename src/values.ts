import {
	type EncodeData,
	getDiscriminatedUnion,
	getDiscriminator,
	getEncode,
	getExamples,
	getFormat,
	getMaxItems,
	getMaxLength,
	getMaxValue,
	getMaxValueExclusive,
	getMinItems,
	getMinLength,
	getMinValue,
	getMinValueExclusive,
	getOpExamples,
	getPattern,
	isArrayModelType,
	isNeverType,
	isRecordModelType,
	type Model,
	type ModelProperty,
	type OpExample,
	type Program,
	resolveEncodedName,
	type Scalar,
	serializeValueAsJson,
	type Type,
	type Value,
} from "@typespec/compiler";
import { $ } from "@typespec/compiler/typekit";
import {
	type HttpOperation,
	type HttpProperty,
	isHeader,
	type MetadataInfo,
	Visibility,
} from "@typespec/http";
import { reportDiagnostic } from "./lib.js";
import type { JsonValue } from "./uri.js";

/**
 * Values for the parameters and bodies a request sends.
 *
 * **Examples first, because the author wrote them.** An `@opExample` is split into body and
 * parameters exactly as `@typespec/openapi3`'s `examples.js` splits it, so the request a collection
 * sends is the example the published document shows. Where no example exists the value is
 * synthesised, and a synthesised value has one job: satisfy every constraint the spec states, so a
 * server that validates against the spec accepts it.
 */
export interface ValueContext {
	readonly program: Program;
	readonly metadata: MetadataInfo;
}

/** The first `@opExample` on an operation. The first is the one a collection sends. */
export function operationExample(
	program: Program,
	operation: HttpOperation,
): OpExample | undefined {
	return getOpExamples(program, operation.operation)[0];
}

/** `getValueByPath` from openapi3's `examples.js`: walk an example value along an `HttpProperty.path`. */
function valueAtPath(
	value: Value | undefined,
	path: readonly (string | number)[],
): Value | undefined {
	let current = value;
	for (const key of path) {
		if (current?.valueKind === "ObjectValue") current = current.properties.get(String(key))?.value;
		else if (current?.valueKind === "ArrayValue") current = current.values[Number(key)];
		else return undefined;
	}
	return current;
}

/**
 * The rfc7231 encoding a date-time HEADER takes when it declares none, as openapi3's
 * `getDefaultHeaderEncodeAs` applies it.
 */
function headerEncoding(program: Program, property: ModelProperty): EncodeData | undefined {
	if (!isHeader(program, property) || getEncode(program, property) !== undefined) return undefined;
	const tk = $(program);
	if (property.type.kind !== "Scalar" || !tk.scalar.isUtcDateTime(property.type)) return undefined;
	return { encoding: "rfc7231", type: property.type };
}

function serialize(
	context: ValueContext,
	value: Value,
	type: Type,
	target: string,
	encodeAs?: EncodeData,
): JsonValue | undefined {
	try {
		return serializeValueAsJson(context.program, value, type, encodeAs) as JsonValue;
	} catch (error) {
		reportDiagnostic(context.program, {
			code: "unserializable-example",
			format: { target, reason: error instanceof Error ? error.message : String(error) },
			target: type,
		});
		return undefined;
	}
}

/** The body an `@opExample` declares, split off its parameters. */
export function exampleBody(
	context: ValueContext,
	operation: HttpOperation,
	example: OpExample,
	bodyType: Type,
): JsonValue | undefined {
	if (example.parameters === undefined) return undefined;
	const bodyProperty = operation.parameters.properties.find(
		(property) => property.kind === "body" || property.kind === "bodyRoot",
	);
	const value =
		bodyProperty === undefined
			? example.parameters
			: valueAtPath(example.parameters, bodyProperty.path);
	if (value === undefined) return undefined;
	return serialize(context, value, bodyType, operation.operation.name);
}

/** The value an `@opExample` gives one path, query, header or cookie parameter. */
export function exampleParameter(
	context: ValueContext,
	example: OpExample | undefined,
	property: HttpProperty,
): JsonValue | undefined {
	if (example?.parameters === undefined) return undefined;
	const value = valueAtPath(example.parameters, property.path);
	if (value === undefined) return undefined;
	return serialize(
		context,
		value,
		property.property,
		property.property.name,
		headerEncoding(context.program, property.property),
	);
}

/** A value synthesised for a parameter: its own `@example` if declared, else generated. */
export function parameterValue(context: ValueContext, property: ModelProperty): JsonValue {
	const produced = propertyValue(context, property, Visibility.Query, new Set(), property.name);
	/**
	 * **A parameter list is never generated empty.** RFC 6570 expands an empty list to nothing, so a
	 * required `tags: string[]` would not be sent at all and a server validating against the spec
	 * would refuse the request. One element is the least a list parameter can carry and still be sent.
	 */
	const type = property.type;
	if (
		!produced.example &&
		Array.isArray(produced.value) &&
		produced.value.length === 0 &&
		type.kind === "Model" &&
		isArrayModelType(type) &&
		(getMaxItems(context.program, type) ?? 1) >= 1
	) {
		return [
			typeValue(context, type.indexer.value, Visibility.Query | Visibility.Item, new Set(), {
				name: property.name,
				top: undefined,
				ignoreMetadataAnnotations: false,
			}).value,
		];
	}
	return produced.value;
}

export interface SynthesisedBody {
	readonly value: JsonValue;
	/** Top-level wire names whose value came from an example rather than from synthesis. */
	readonly fromExample: ReadonlySet<string>;
}

/**
 * A body for `type` at `visibility`: the model's own `@example` when it declares one, otherwise
 * every property that is required at that visibility.
 */
export function synthesiseBody(
	context: ValueContext,
	type: Type,
	visibility: Visibility,
	ignoreMetadataAnnotations: boolean,
	name?: string,
): SynthesisedBody {
	const fromExample = new Set<string>();
	const value = typeValue(context, type, visibility, new Set(), {
		name,
		top: fromExample,
		ignoreMetadataAnnotations,
	});
	return { value: value.value, fromExample: value.example ? topKeys(value.value) : fromExample };
}

function topKeys(value: JsonValue): Set<string> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? new Set(Object.keys(value))
		: new Set();
}

interface Produced {
	readonly value: JsonValue;
	/** The value came from an `@example`, whole. */
	readonly example: boolean;
}

interface Position {
	/** The wire name the value will sit under, which a generated string is spelled from. */
	readonly name: string | undefined;
	/** Where top-level properties record that they came from an example, for the body only. */
	readonly top: Set<string> | undefined;
	readonly ignoreMetadataAnnotations: boolean;
}

function propertyValue(
	context: ValueContext,
	property: ModelProperty,
	visibility: Visibility,
	seen: Set<Type>,
	name: string,
): Produced {
	const [declared] = getExamples(context.program, property);
	if (declared !== undefined) {
		const value = serialize(context, declared.value, property, property.name);
		if (value !== undefined) return { value, example: true };
	}
	const produced = typeValue(
		context,
		property.type,
		visibility,
		seen,
		{ name, top: undefined, ignoreMetadataAnnotations: false },
		property,
	);
	return { ...produced, value: encoded(context.program, property, produced.value) };
}

/** What each `ArrayEncoding` member joins an array's items with. */
const ARRAY_DELIMITERS: Readonly<Record<string, string>> = {
	"ArrayEncoding.pipeDelimited": "|",
	"ArrayEncoding.spaceDelimited": " ",
	"ArrayEncoding.commaDelimited": ",",
	"ArrayEncoding.newlineDelimited": "\n",
};

/**
 * A generated value re-spelled as the property's `@encode` says it travels, as `@typespec/openapi3`
 * publishes it: a delimited array becomes one string, and a boolean or number encoded as a string
 * becomes its text. Date-time, duration and bytes encodings are applied where their scalar is.
 */
export function encoded(program: Program, property: ModelProperty, value: JsonValue): JsonValue {
	const encoding = getEncode(program, property);
	if (encoding === undefined) return value;
	const delimiter =
		encoding.encoding === undefined ? undefined : ARRAY_DELIMITERS[encoding.encoding];
	if (delimiter !== undefined && Array.isArray(value)) {
		return value
			.map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item)))
			.join(delimiter);
	}
	if (
		encoding.type.name === "string" &&
		(typeof value === "boolean" || typeof value === "number")
	) {
		return String(value);
	}
	return value;
}

function typeValue(
	context: ValueContext,
	type: Type,
	visibility: Visibility,
	seen: Set<Type>,
	position: Position,
	property?: ModelProperty,
): Produced {
	const { program } = context;
	switch (type.kind) {
		case "String":
			return { value: type.value, example: false };
		case "Number":
			return { value: type.value, example: false };
		case "Boolean":
			return { value: type.value, example: false };
		case "Enum": {
			const [member] = type.members.values();
			return { value: member === undefined ? null : (member.value ?? member.name), example: false };
		}
		case "EnumMember":
			return { value: type.value ?? type.name, example: false };
		case "Intrinsic":
			return { value: type.name === "null" ? null : null, example: false };
		case "Tuple":
			return {
				value: type.values.map(
					(item) =>
						typeValue(context, item, visibility | Visibility.Item, seen, {
							...position,
							top: undefined,
						}).value,
				),
				example: false,
			};
		case "UnionVariant":
			return typeValue(context, type.type, visibility, seen, position, property);
		case "Union":
			return unionValue(context, type, visibility, seen, position, property);
		case "Scalar":
			return scalarValue(context, type, position.name, property);
		case "Model":
			return modelValue(context, type, visibility, seen, position, property);
		default:
			void program;
			return { value: null, example: false };
	}
}

function unionValue(
	context: ValueContext,
	union: Extract<Type, { kind: "Union" }>,
	visibility: Visibility,
	seen: Set<Type>,
	position: Position,
	property: ModelProperty | undefined,
): Produced {
	const [declared] = getExamples(context.program, union);
	if (declared !== undefined) {
		const value = serialize(context, declared.value, union, union.name ?? "union");
		if (value !== undefined) return { value, example: true };
	}
	const [discriminated] = getDiscriminatedUnion(context.program, union);
	if (discriminated !== undefined) {
		const [first] = discriminated.variants;
		if (first !== undefined) {
			const [key, variant] = first;
			const inner = typeValue(context, variant, visibility, seen, { ...position, top: undefined });
			const { discriminatorPropertyName, envelopePropertyName, envelope } = discriminated.options;
			if (envelope === "object") {
				return {
					value: { [discriminatorPropertyName]: key, [envelopePropertyName]: inner.value },
					example: false,
				};
			}
			if (inner.value !== null && typeof inner.value === "object" && !Array.isArray(inner.value)) {
				return { value: { ...inner.value, [discriminatorPropertyName]: key }, example: false };
			}
		}
	}
	const variants = [...union.variants.values()].map((variant) => variant.type);
	const concrete = variants.filter(
		(variant) => !(variant.kind === "Intrinsic" && variant.name === "null"),
	);
	const [first] = concrete;
	if (first === undefined) return { value: null, example: false };
	return typeValue(context, first, visibility, seen, position, property);
}

/** A constraint read from the property first, then up the scalar chain. */
function constraint<T>(
	program: Program,
	property: ModelProperty | undefined,
	scalar: Scalar,
	read: (program: Program, target: Type) => T | undefined,
): T | undefined {
	if (property !== undefined) {
		const own = read(program, property);
		if (own !== undefined) return own;
	}
	for (
		let current: Scalar | undefined = scalar;
		current !== undefined;
		current = current.baseScalar
	) {
		const value = read(program, current);
		if (value !== undefined) return value;
	}
	return undefined;
}

const EPOCH = "1970-01-01T00:00:00Z";

/** A value that satisfies a string format, for the formats JSON Schema and TypeSpec name. */
const FORMATTED: Readonly<Record<string, string>> = {
	uuid: "00000000-0000-0000-0000-000000000000",
	email: "user@example.com",
	"idn-email": "user@example.com",
	uri: "https://example.com/",
	url: "https://example.com/",
	"uri-reference": "https://example.com/",
	iri: "https://example.com/",
	hostname: "example.com",
	"idn-hostname": "example.com",
	ipv4: "192.0.2.1",
	ipv6: "2001:db8::1",
	"date-time": EPOCH,
	date: "1970-01-01",
	time: "00:00:00Z",
	duration: "PT0S",
};

function scalarValue(
	context: ValueContext,
	scalar: Scalar,
	name: string | undefined,
	property: ModelProperty | undefined,
): Produced {
	const { program } = context;
	for (
		let current: Scalar | undefined = scalar;
		current !== undefined;
		current = current.baseScalar
	) {
		const [declared] = getExamples(program, current);
		if (declared !== undefined) {
			const value = serialize(context, declared.value, property ?? scalar, current.name);
			if (value !== undefined) return { value, example: true };
		}
	}
	const tk = $(program);
	const std = tk.scalar.getStdBase(scalar);
	const encode =
		(property === undefined ? undefined : getEncode(program, property)) ??
		getEncode(program, scalar);
	const target = property?.name ?? scalar.name;
	const stdName = std?.name ?? "string";

	switch (stdName) {
		case "boolean":
			return { value: false, example: false };
		case "utcDateTime":
		case "offsetDateTime":
			if (encode?.encoding === "unixTimestamp") return { value: 0, example: false };
			if (encode?.encoding === "rfc7231")
				return { value: "Thu, 01 Jan 1970 00:00:00 GMT", example: false };
			return {
				value: stdName === "offsetDateTime" ? "1970-01-01T00:00:00+00:00" : EPOCH,
				example: false,
			};
		case "plainDate":
			return { value: "1970-01-01", example: false };
		case "plainTime":
			return { value: "00:00:00", example: false };
		case "duration":
			if (encode?.encoding === "seconds" || encode?.encoding === "milliseconds") {
				return { value: 0, example: false };
			}
			return { value: "PT0S", example: false };
		case "bytes":
			return { value: "", example: false };
		case "url":
			return { value: FORMATTED["url"] ?? "", example: false };
	}

	if (std !== null && tk.scalar.extendsNumeric(std)) {
		const integer = !["float", "float32", "float64", "decimal", "decimal128", "numeric"].includes(
			stdName,
		);
		const minimum = constraint(program, property, scalar, getMinValue);
		const exclusiveMinimum = constraint(program, property, scalar, getMinValueExclusive);
		const maximum = constraint(program, property, scalar, getMaxValue);
		const exclusiveMaximum = constraint(program, property, scalar, getMaxValueExclusive);
		let value = 0;
		if (minimum !== undefined && value < minimum) value = minimum;
		if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) {
			value = integer ? Math.floor(exclusiveMinimum) + 1 : exclusiveMinimum + 1;
		}
		if (maximum !== undefined && value > maximum) value = maximum;
		if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) {
			value = integer ? Math.ceil(exclusiveMaximum) - 1 : exclusiveMaximum - 1;
		}
		const outOfRange =
			(minimum !== undefined && value < minimum) ||
			(exclusiveMinimum !== undefined && value <= exclusiveMinimum) ||
			(maximum !== undefined && value > maximum) ||
			(exclusiveMaximum !== undefined && value >= exclusiveMaximum);
		if (outOfRange) {
			reportDiagnostic(program, {
				code: "unsatisfiable-value",
				format: { target, constraint: "its numeric bounds" },
				target: property ?? scalar,
			});
		}
		return { value: encode?.type.name === "string" ? String(value) : value, example: false };
	}

	// A string, or a scalar a JSON body carries as one.
	const format = constraint(program, property, scalar, getFormat);
	const minLength = constraint(program, property, scalar, getMinLength) ?? 0;
	const maxLength = constraint(program, property, scalar, getMaxLength);
	const pattern = constraint(program, property, scalar, getPattern);
	let text =
		format !== undefined && FORMATTED[format] !== undefined
			? (FORMATTED[format] ?? "")
			: (name ?? target);
	if (text.length < minLength) text = text.padEnd(minLength, "x");
	if (maxLength !== undefined && text.length > maxLength) text = text.slice(0, maxLength);
	if (pattern !== undefined) {
		let matches = false;
		try {
			matches = new RegExp(pattern, "u").test(text);
		} catch {
			matches = false;
		}
		if (!matches) {
			reportDiagnostic(program, {
				code: "unsatisfiable-value",
				format: { target, constraint: `the pattern ${JSON.stringify(pattern)}` },
				target: property ?? scalar,
			});
		}
	}
	return { value: text, example: false };
}

function modelValue(
	context: ValueContext,
	model: Model,
	visibility: Visibility,
	seen: Set<Type>,
	position: Position,
	property?: ModelProperty,
): Produced {
	const { program, metadata } = context;
	if (isArrayModelType(model)) {
		// `@minItems` on the property constrains this use of the array; on the model, every use.
		const minimum =
			(property === undefined ? undefined : getMinItems(program, property)) ??
			getMinItems(program, model);
		const maximum =
			(property === undefined ? undefined : getMaxItems(program, property)) ??
			getMaxItems(program, model);
		const count = Math.max(minimum ?? 0, 0);
		const capped = Math.min(count, maximum ?? count);
		const element = model.indexer.value;
		return {
			value: Array.from(
				{ length: capped },
				() =>
					typeValue(context, element, visibility | Visibility.Item, seen, {
						name: position.name,
						top: undefined,
						ignoreMetadataAnnotations: false,
					}).value,
			),
			example: false,
		};
	}
	const [declared] = getExamples(program, model);
	if (declared !== undefined) {
		const value = serialize(context, declared.value, model, model.name);
		if (value !== undefined) return { value, example: true };
	}
	if (isRecordModelType(model) && model.properties.size === 0) return { value: {}, example: false };
	if (seen.has(model)) {
		reportDiagnostic(program, {
			code: "unsatisfiable-value",
			format: { target: model.name, constraint: "a required property that contains itself" },
			target: model,
		});
		return { value: {}, example: false };
	}

	/**
	 * **A discriminated base is synthesised as its first derived model**, because the base alone
	 * is not a value any variant accepts: its discriminator has no value to take.
	 */
	const discriminator = getDiscriminator(program, model);
	if (discriminator !== undefined) {
		const [derived] = model.derivedModels;
		if (derived !== undefined) return modelValue(context, derived, visibility, seen, position);
	}

	const inner = new Set(seen).add(model);
	const chain: Model[] = [];
	for (let current: Model | undefined = model; current !== undefined; current = current.baseModel) {
		chain.unshift(current);
	}
	const object: { [key: string]: JsonValue } = {};
	for (const current of chain) {
		const discriminatorName = getDiscriminator(program, current)?.propertyName;
		for (const property of current.properties.values()) {
			if (isNeverType(property.type)) continue;
			if (!metadata.isPayloadProperty(property, visibility, position.ignoreMetadataAnnotations))
				continue;
			const wire = resolveEncodedName(program, property, "application/json");
			const isDiscriminator = wire === discriminatorName || property.name === discriminatorName;
			if (metadata.isOptional(property, visibility) && !isDiscriminator) continue;
			const produced = propertyValue(context, property, visibility, inner, wire);
			object[wire] = produced.value;
			if (produced.example) position.top?.add(wire);
		}
	}
	return { value: object, example: false };
}
