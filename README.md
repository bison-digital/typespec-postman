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
  Schema, as the spec declares them; that a created resource returned its id and that its `Location`
  resolves to where the spec says the resource now lives, that a list is an array, that a fetched
  resource is the one requested, and that an updated field holds the value sent.
- **Error cases** the spec declares: an unknown id answered 404, a body missing a required property
  answered 400, and a request without credentials answered 401, each with its declared error body.

The file is Postman Collection Format v2.1, byte-identical for identical input.

## The chaining convention

A created resource's id reaches the requests that need it without any annotation in the spec.

1. **An item route declares a resource.** A `GET` on a collection path plus one whole path parameter,
   returning a named model whose key carries the same kind of value as that parameter, says what the
   resource is, what its key is and where its collection lives. The key is the `@key` property,
   otherwise `id`.
2. **An operation answering that model with its key creates it.** A `POST` on the collection route
   creates under it, whatever 2xx status it answers with - 200 and 202 carry a created resource as
   readily as 201 does. A `PUT` whose route ends in the key creates at it, and only where it answers
   **201**: RFC 9110 9.3.4 makes 201 the signal that a PUT created the resource rather than replacing
   one that was there, and nothing else distinguishes the two.
3. **The id is read from the created resource, otherwise from `Location`.** A create that answers with
   the resource reads the key out of its body. One whose body wraps the resource, carries it beside
   something else, or is not the resource at all, reads it from the `Location` header, which RFC 9110
   9.3.1 defines as the identifier of the resource the **201** created. Those are the two places HTTP
   puts a created id, and nothing else is inferred from the shape of a body. Only a 201's `Location`
   is read or checked that way: a 202's conventionally names a status endpoint rather than the
   resource, so it is asserted present and nothing more.
4. **The id is stored** in a collection variable named for the model and its key: `Author` with `id`
   sets `authorId`, and `Project` with `@key slug` sets `projectSlug`.
5. **A path parameter consumes the id** when it carries the same kind of value as the key (the same
   scalar, format and encoding) and either sits directly after the route the resource was created on
   (`/authors/{anything}`) or is named for the variable (`{authorId}`, anywhere).
6. **A resource no operation creates is supplied to the run.** Its variable carries the value the
   request would have sent anyway, described as one to fill in, and every check on a request that
   needs it is reported skipped until it is - a request sent with an id nothing created can say
   nothing about the service, and a failure would say the service was at fault.
7. **One resource per collection path**, and what an item route answers is that resource however it is
   spelled. A detail representation returned beside the one a create takes is another view of the same
   thing, not a second resource: a model carrying a key of the same kind, at the resource's own item
   route, is a read of it.
8. **Roles follow the same route.** A `GET` on the creation route that returns the model as an array,
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
- [Changelog](CHANGELOG.md).

## Licence

MIT.
