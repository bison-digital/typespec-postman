# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major version is 0, the
generated collection counts as API: a change to what it contains for an unchanged spec is a minor
version.

## [Unreleased]

## [0.1.0] - unreleased

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
