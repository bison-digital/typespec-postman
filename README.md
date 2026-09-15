# typespec-postman

A TypeSpec emitter that writes a Postman collection for an HTTP service: one request per operation,
with auth, request bodies, chained ids and assertions derived from the spec.

```yaml
# tspconfig.yaml
emit:
  - typespec-postman
options:
  typespec-postman:
    emitter-output-dir: "{project-root}/postman"
```

```bash
tsp compile .
postman collection run postman/postman_collection.json \
  --env-var baseUrl=http://localhost:8080 --env-var bearerAuth=$TOKEN --no-report-events
```

The collection is generated, committed, and regenerated in CI, so it cannot drift from the spec.

## Install

Install as a devDependency beside the TypeSpec compiler. Nothing the emitter writes imports it.

```bash
pnpm add -D typespec-postman @typespec/compiler @typespec/http @typespec/openapi3
```

`@typespec/versioning` is an optional peer, needed only by a versioned spec.

## What the collection contains

- **One request per operation**, with its method, route, path and query parameters and headers taken
  from the resolved HTTP operation.
- **Folders from the interface or namespace** each operation is declared in. A folder whose routes sit
  under another resource nests inside that resource's folder.
- **Collection variables** for the server URL (`baseUrl`), each server template variable, each
  credential, and each chained resource id.
- **Auth where the spec declares it**: the service's `@useAuth` on the collection, an interface's on
  its folder, and an override on a request whose requirement differs. Credentials are variables, never
  values.
- **Request bodies** from `@opExample`, then `@example`, then generated from the model: every property
  required at the request's visibility, with formats, lengths and bounds satisfied.
- **Assertions**: the status code; the response's media type, required headers, empty body or JSON
  Schema, as the spec declares them; that a created resource returned its id, that a list is an array,
  that a fetched resource is the one requested, and that an updated field holds the value sent.
- **Error cases** the spec declares: an unknown id answered 404, a body missing a required property
  answered 400, and a request without credentials answered 401, each with its declared error body.

The file is Postman Collection Format v2.1, byte-identical for identical input.

## The chaining convention

A created resource's id reaches the requests that need it without any annotation in the spec.

1. **An operation creates a resource** when it declares a `201` response with a `Location` header and a
   JSON body that is a named model with a key. The key is the `@key` property, otherwise `id`. A `POST`
   creates under its route; a `PUT` whose route ends in the key creates at it, so its route without
   the key is where the resource was created.
2. **The id is stored** in a collection variable named for the model and its key: `Organization` with
   `id` sets `organizationId`, and `Project` with `@key slug` sets `projectSlug`.
3. **A path parameter consumes the id** when it carries the same kind of value as the key (the same
   scalar, format and encoding) and either sits directly after the route the resource was created on
   (`/organizations/{anything}`) or is named for the variable (`{organizationId}`, anywhere).
4. **Roles follow the same route.** A `GET` on the creation route that returns the model as an array,
   as `@pageItems`, or as the one array property of its body is a list. A `GET`, `PATCH` or `PUT` on
   the creation route plus the id that returns the model is a read or an update. A `DELETE` there is
   a delete.

Requests run in dependency order: a resource is created before anything uses it, a delete runs after
everything that uses what it deletes, and a folder ends with its deletes. Everything else keeps the
order it was declared in. Dependencies the spec does not state structurally, such as a credential
whose value is an id, keep declaration order.

`@typespec/rest` resource decorators are not read; the convention is structural.

## Documentation

- [Reference](docs/reference.md): options, what each part of the collection is derived from, and every
  diagnostic.
- [Guides](docs/guides.md): checking the collection in CI, running it, credentials, and examples.
- [Oracles](docs/oracles.md): what each output is compared against, and where.
- [Releasing](docs/releasing.md).
- [Changelog](CHANGELOG.md) and the [working record](HANDOVER.md).

## Licence

MIT.
