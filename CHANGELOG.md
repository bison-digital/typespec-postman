# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major version is 0, the
generated collection counts as API: a change to what it contains for an unchanged spec is a minor
version.

## [0.7.0] - 2026-10-22

A minor, by this file's own rule: a collection's GraphQL folder changes for an unchanged spec, its id
among them. A spec without a GraphQL surface emits what 0.6.0 emits.

### Fixed

- **A GraphQL request sends every argument its field requires.** `@typespec/openapi3` marks optional,
  on the operation itself, each parameter of a shared route that not every operation of the route
  takes, and this emitter left such a parameter out of the REST request and so out of the GraphQL
  one, whose field typespec-http-graphql had planned with it required. The GraphQL request now takes
  the value the REST request leaves out.
- **The GraphQL folder runs each request after what creates what it uses, and a delete after every
  other use of what it deletes.** It took the REST order, which folders that run as wholes can force
  to give such an edge up (`order-cycle`), and could run a read after the delete of what it read.
- **The GraphQL folder's id is its own.** A folder for an interface named `graphql` had the same one.
- **`graphql-url` keeps a trailing slash**, and a `graphql-url` naming no host is warned of once, not
  once per service.

### Changed

- `typespec-http-graphql` `^0.3.1` as the optional peer: 0.3.1 writes a document the schema accepts
  for every root field.

## [0.6.0] - 2026-10-22

A minor, by this file's own rule: a spec with a GraphQL surface, compiled with typespec-http-graphql,
gets requests it did not get before. A spec without one emits what 0.5.1 emits.

### Added

- **GraphQL requests.** Where the same compile emits typespec-http-graphql (0.3.0 or later, listed
  first in `emit:`), the collection gains a `GraphQL` folder: a `graphql`-mode request for each
  `@queryField` and `@mutationField` it served, at `{{baseUrl}}/graphql`. Each document is the one
  typespec-http-graphql writes for the field, read from the copy of it the compiler ran, so it
  matches the schema that emitter serves; each request's variables are the values the REST request
  for its operation sends, a created id as its collection variable, and its auth is that request's.
  The folder starts with copies of the creates its reads need, so a read runs against data that
  exists, and each request asserts a 200, no `errors`, a value for its field and, for a mutation,
  one of its success members.
- **`graphql-url`** and **`services.<name>.graphql-url`**: where the GraphQL requests go.
- `graphql-emitted-later`, `graphql-requests-unavailable` and `graphql-url-invalid`: the warnings for
  a typespec-http-graphql listed after this emitter, one too old to publish its requests, and a
  `graphql-url` with no host.
- `typespec-http-graphql` `^0.3.0` as an optional peer. Nothing imports it.

## [0.5.1] - 2026-10-22

A patch: the emitted collection is unchanged.

### Changed

- **Comments, documentation and test fixtures are rewritten in neutral terms.**

## [0.5.0] - 2026-10-21

A minor, by this file's own rule: the collection's variables and error cases move for an unchanged
spec that declares a namespace's own operations between its interfaces.

### Changed

- **Every derivation reads the operations in the order the spec declares them**, by source file,
  then position, the order requests already broke ties by. `@typespec/http` lists them in the order
  the compiler finished checking their interfaces, so a second file whose only statement was an
  augment decorator naming an operation, a GraphQL surface's `@link`, moved a collection's error
  cases and variables with nothing else changed. It also lists a namespace's own operations ahead of
  every interface, which put the variable a root `createShelf` declared after `Books` creates ahead
  of the one `Books` creates; the variables now follow the declarations. Requests still run in
  dependency order.

### Added

- `typespec-postman/package.json` is exported.

## [0.4.0] - 2026-10-19

A minor, by this file's own rule: a create body changes for an unchanged spec where openapi3
publishes OpenAPI 3.1.

### Fixed

- **A request body sends a required read-only property where the document requires it.** openapi3
  shares such a property into the schema a request is published with, and OAS 3.0.4 requires it "on
  the response only", so the collection always left it out. At 3.1 `readOnly` is an annotation and
  the document requires it in the request too, so a create body without its server-assigned `id` was
  one the document, and a `typespec-hono` server built from it, refused with 400. The collection now
  reads the version openapi3 publishes from its `openapi-versions` option, `3.0.0` where unset, and
  sends the property at 3.1 (`test/readonly`). Found by the run suite against `typespec-hono` 0.28.0.
- **The corpus arm grades a request body against the document as it stands.** It dropped read-only
  properties from `required` first - 3.0's rule applied to the 3.1 document it reads - which is what
  let the omission above pass.

## [0.3.1] - 2026-10-11

### Changed

- **The optional `@typespec/versioning` peer admits `^0.87.0`**, the version TypeSpec 1.17.0 pairs
  with, so a consumer on the current compiler no longer gets an unmet peer. Nothing in the generated
  collection changes.
- **Built and graded against TypeSpec 1.17.0** and `@typespec/http-specs` `0.1.0-alpha.44`.

## [0.3.0] - 2026-09-20

A minor rather than a patch, by this file's own rule: the script a guarded request carries changes
for an unchanged spec.

### Fixed

- **An id supplied as an empty value counts as unset.** The guard on a request needing a resource
  nothing creates compared the variable with the value the emitter had put there, so a runner that
  always passes the flag and lets an undefined shell variable expand to nothing supplied an empty
  string - neither the placeholder nor an id. The request went to `/things/` and reported failures
  where it should have reported skips.

## [0.2.0] - 2026-09-18

Each fix is carried by a fixture that fails without it. The collection a given spec produces
changes, so this is a minor version.

### Added

- **A `Location` is checked as a location.** A create that declares one now asserts that the header,
  resolved against the request per RFC 3986, is the URL the collection's own read is sent to.
  The previous check was that the header was present, which a `Location` no client can follow also
  satisfies - as one behind a proxy serving the API under a base path does.
- **An id read from the `Location` where the body does not carry one.** A create whose body wraps the
  resource, carries it beside something else, or is not the resource at all, now chains:
  RFC 9110 9.3.1 makes the header the created
  resource's identifier, and the resource's own item route says what shape it has. Nothing is inferred
  from the shape of a body.
- **A resource no operation creates.** An item route declares a resource whether or not anything
  answers 201 for one. Its variable carries the value the request would have sent anyway, described as
  one to supply, and every check on a request that needs it is reported skipped - under the same name,
  and counted the same way - until the run supplies it. Its not-found error case still runs.
- **`keyless-create`**, for a create that answers 201 with a `Location` and no operation reads a
  resource at its route, so there is nothing to match the header against.
- **A run missing a credential is stopped before its first request**, with one message naming what to
  set. Postman sends an unset variable as an empty credential, so such a run was previously answered
  401 by the service on every request and read as a service refusing correct calls.

- **A create is not only a 201.** A `POST` on a collection route that answers the resource with its
  key creates it whatever 2xx status it uses, which is how several large public APIs answer. A `PUT`
  still creates only where it answers 201, because RFC 9110 9.3.4 makes that the one thing separating
  a PUT that created a resource from one that replaced an existing one. Before, a collection for a
  service answering 200 or 202 created the resource and then asked for its id to be supplied by hand.

### Changed

- **One resource per collection path.** A second model answering at the same item route is another
  view of the same resource, not a resource of its own; it was getting a collection variable no
  request ever used. A read is now matched by the kind of key its body carries rather than by model
  identity, so a detail representation keeps the check that it returned what was asked for, and its
  not-found case.
- A `201` no longer needs a `Location` header to create a resource: where its body carries the key and
  its route is the one an item route names, the id is chained from the body. The header remains the
  only source for a body that carries no key, and what it buys in both cases is the check above.
- A `location` presence check is no longer emitted where the create's Location is checked properly.

## [0.1.0] - 2026-09-16

The Postman app's own import dialogue is the one check no suite can drive. Postman's
`collection migrate` and `collection lint` read the committed collection clean on every commit, and
the CLI runs it green against a generated server.

### Added

- A TypeSpec emitter that writes a Postman Collection v2.1 file per service from the resolved HTTP
  model: one request per operation, folders from the declaring interface nested by route, server and
  credential variables, auth where the spec declares it, bodies from examples or generated at request
  visibility, the chaining convention for created ids, and dependency order.
- Checks on every request: the declared status, media type, required response headers, empty body,
  and the response body's JSON Schema (`@typespec/openapi3`'s, converted to the draft-07 the Postman
  sandbox checks); the chaining convention's created id, list, fetched id and updated field.
- An `Error cases` folder: not found, invalid body and unauthorized requests, where the spec declares
  those responses.
- Options `output-file`, `collection-auth` and `services.<name>.emit-collection`.
- A worked example in `example/`, with the collection it produces committed beside it.
