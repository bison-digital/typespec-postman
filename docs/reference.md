# Reference

## Options

| option                            | default                                              | what it does                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `output-file`                     | `{service-name-if-multiple}.postman_collection.json` | The file written per service, relative to `emitter-output-dir`. Interpolated as `@typespec/openapi3` interpolates its own `output-file`: `{service-name}` is the service namespace's full name, and `{service-name-if-multiple}` is that name only when the program declares more than one service. |
| `collection-auth`                 | `true`                                               | Whether the auth the service namespace declares is set on the collection object. When `false`, folders and root requests carry it instead, so every request still authenticates.                                                                                                                    |
| `services.<name>.emit-collection` | `true`                                               | `false` writes no collection for that service. `<name>` is the service namespace's full name.                                                                                                                                                                                                       |

`emitter-output-dir` is honoured. Nothing is written under `noEmit`, on a dry run, or when the program
has errors.

## What is derived, and from what

| part of the collection                | derived from                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| collection name and description       | `@service` title, otherwise the namespace name; the namespace's doc comment                                                                                         |
| collection id, folder and request ids | a digest of the service, folder and operation identity (the same spec always gives the same ids)                                                                    |
| `baseUrl`                             | the first `@server`, with each `{name}` written `{{name}}`                                                                                                          |
| server variables                      | each `@server` parameter, defaulted from its default, otherwise its first enum or literal value                                                                     |
| folders                               | `HttpOperation.container`: the declaring interface or namespace, named relative to the service                                                                      |
| folder nesting                        | the chaining convention: a folder whose routes sit directly under a resource nests in that resource's folder                                                        |
| request name                          | `@summary`, otherwise the operation name                                                                                                                            |
| method and route                      | `HttpOperation.verb` and `HttpOperation.uriTemplate`, expanded per RFC 6570                                                                                         |
| path variables                        | whole-segment path parameters, valued from `@opExample`, `@example`, or generated                                                                                   |
| query parameters                      | `@query` parameters, and a query string written literally in the route (`/items?fixed=true{&param}`); optional ones are listed disabled unless an example sets them |
| headers                               | `@header` parameters; `Content-Type` from the body; `Accept` from the first response body                                                                           |
| cookies                               | `@cookie` parameters and cookie API keys, as one `Cookie` header                                                                                                    |
| body                                  | `@opExample`, then the model's `@example`, then generated at the request's visibility                                                                               |
| auth                                  | `resolveAuthentication`: collection from the service namespace, folder from the interface, request where the operation differs                                      |
| credential variables                  | each security scheme used, named for the scheme id `@typespec/openapi3` publishes, first letter lowered (`ApiKeyAuth_` is `apiKeyAuth_`)                            |
| chained id variables                  | the chaining convention                                                                                                                                             |
| order                                 | the chaining convention, then declaration order                                                                                                                     |
| assertions                            | 2xx statuses; the chaining convention's roles; an `@opExample` body for update assertions                                                                           |

### Generated values

A generated value satisfies what the spec states about it:

- **strings** are the property's wire name, padded or truncated to `@minLength` and `@maxLength`;
  a known `@format` or scalar gets a conforming value (`uuid`, `email`, `url`, `utcDateTime`, `plainDate`
  and so on); a `@pattern` the value does not match is reported;
- **numbers** take `@minValue`, or `0`, within every bound;
- **enums, literals and unions** take their first member, value or non-null variant, passing over a
  variant that would recurse into the model being built, for `null` where the union allows it;
- **arrays** carry `@minItems` elements; a list parameter carries at least one element and a record
  parameter at least one entry, because RFC 6570 does not send an empty one at all;
- **encodings** are applied: a delimited array is one string, a number or boolean encoded as a string is
  its text, date-times and durations take their declared encoding;
- **discriminated models and unions** take their first variant, with the discriminator set and any
  envelope applied.

Read-only properties are left out of a request body, as OpenAPI requires.

### Auth mapping

| scheme                            | Postman                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `BearerAuth`                      | `bearer`, token `{{<scheme>}}`                             |
| `BasicAuth`                       | `basic`, `{{<scheme>Username}}` and `{{<scheme>Password}}` |
| `ApiKeyAuth` in a header or query | `apikey`                                                   |
| `ApiKeyAuth` in a cookie          | a `Cookie` header                                          |
| another HTTP scheme               | an `Authorization: <scheme> {{<scheme>}}` header           |
| OAuth2, OpenID Connect            | `oauth2`, access token `{{<scheme>}}`                      |
| `NoAuth`                          | `noauth` where it overrides an inherited scheme            |

When an operation requires several schemes together, the one that writes `Authorization` is the auth
object and every API key is sent as its own header, query parameter or cookie. When an operation allows
alternatives, the first one that carries a credential is used.

## Diagnostics

**All warnings, never errors.** A TypeSpec error sets `program.hasError()`, and every emitter in the
compile, `@typespec/openapi3` included, then writes nothing. A collection that cannot express one
operation perfectly does not cost you the published document.

### `unrepresentable-auth`

An operation requires two schemes that both write the `Authorization` header, which one HTTP request
cannot send. The first is sent.

Remedy: require one of them, or offer them as alternatives (`A | B`) rather than together (`[A, B]`).

### `body-not-runnable`

The request body is a file, binary, a multipart body with a file part, or a media type the emitter
cannot generate (XML, JSON Lines). The request is emitted with the body mode Postman uses for it, and a
person chooses the file or writes the body.

Remedy: none needed to use the collection interactively. For an unattended run, exclude the request
with the Postman CLI's `-i` option.

### `unsatisfiable-value`

No generated value satisfies a constraint, typically a `@pattern`.

Remedy: declare an `@example` on the property.

### `unserializable-example`

An example value could not be serialized for its type. A generated value is used instead.

Remedy: correct the example; the message carries the serializer's reason.

### `update-without-example`

An update operation has no `@opExample`, so the collection cannot assert that a field holds the value
sent. With messageId `empty`, the generated body is also `{}`, which a server that refuses an empty
patch answers with a 400.

Remedy: add an `@opExample` whose body sets the fields the update is for.

### `unnamed-resource`

An operation creates a resource whose body model is anonymous, so there is no name for its variable.

Remedy: return a named model.

### `variable-collision`

Two things claim one collection variable name: two resources whose model and key names coincide, or a
resource, credential and server variable sharing a name. The first claim keeps the variable.

Remedy: rename the model or the scheme.

### `order-cycle`

No request order satisfies every dependency, because a folder runs all of its requests together. The
message lists each dependency the emitted order does not keep. The common cause is an operation outside
a resource's folder that uses the resource while the folder also deletes it.

Remedy: declare that operation in the resource's interface, or route it under the resource.

### `no-success-response`

An operation declares no 2xx response, so no status is asserted for it.

Remedy: declare the operation's success response.

### `shared-output-file`

Several services resolve to one output file, so none of them is written.

Remedy: put `{service-name}` in `output-file`.
