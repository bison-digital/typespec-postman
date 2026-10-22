# Guides

## Adding the emitter

```bash
pnpm add -D typespec-postman
```

```yaml
# tspconfig.yaml
emit:
  - "@typespec/openapi3"
  - typespec-postman
options:
  typespec-postman:
    emitter-output-dir: "{project-root}/postman"
```

`tsp compile .` writes `postman/postman_collection.json`. Commit it.

## Checking the collection in CI

The collection is generated, so a pull request that changes the spec and not the collection is out of
date. Regenerate and fail on any difference:

```bash
tsp compile .
git diff --exit-code -- postman/
```

The output is byte-identical for identical input, so the only difference this can find is a real one.

## Running the collection

Run the committed file with the Postman CLI. **Always run the file, never a cloud collection id**: a
run named by id is uploaded to the workspace that owns the collection. `--no-report-events` stops the
CLI sending usage events.

```bash
postman collection run postman/postman_collection.json \
  --env-var baseUrl=https://staging.example.com \
  --env-var bearerAuth="$TOKEN" \
  --no-report-events
```

The CLI exits non-zero when any assertion fails, so the same command is a deployment check.

- `baseUrl` is the whole server URL. Each `@server` template variable is also a collection variable, and
  `baseUrl` defaults to the template, so `--env-var endpoint=...` works too.
- Environment variables take precedence over collection variables, so a value passed with `--env-var`
  replaces the default the spec declares.

## Credentials

Each security scheme a request uses is a collection variable named for the scheme, with no value. Pass
it at run time or set it in a Postman environment:

| scheme                             | variables                                |
| ---------------------------------- | ---------------------------------------- |
| `model ShopKey is ApiKeyAuth<...>` | `shopKey`                                |
| `BearerAuth`                       | `bearerAuth`                             |
| `BasicAuth`                        | `basicAuthUsername`, `basicAuthPassword` |

The name is the scheme id `@typespec/openapi3` publishes, first letter lowered. Two schemes instantiated
from one template, which it publishes as `ApiKeyAuth` and `ApiKeyAuth_`, get `apiKeyAuth` and
`apiKeyAuth_`, so each carries its own credential.

**A run that has not set one is stopped before its first request**, with a message naming every
credential the collection needs. Postman sends an unset variable as an empty one, so without that the
service answers 401 to every request and the report reads as a service refusing correct calls.

A credential whose value must be an id created earlier in the run references the chained variable,
because Postman resolves a variable inside another variable's value at request time:

```bash
postman collection run postman/postman_collection.json \
  --env-var baseUrl=http://localhost:8080 \
  --env-var shopKey='{{shopId}}' \
  --no-report-events
```

The spec does not say that a scheme's value is a shop's id, so the emitter does not guess it,
and declaration order decides which folder runs first.

## A resource nothing creates

Where no operation answers `201` for a resource, its id cannot come from the run. Its variable holds
the value the request would have carried anyway, so the URL is the shape the spec describes, and every
check on a request that needs it is reported **skipped** until the run supplies one:

```
GET http://localhost:8080/archives/00000000-0000-0000-0000-000000000000 [404 Not Found]
  -  [skipped] Status code is 200 (needs archiveId)
```

```bash
postman collection run postman/postman_collection.json --env-var archiveId="$ARCHIVE_ID"
```

The same checks then run, and the run's assertion count is the same either way, so a collection that
quietly stopped checking cannot be mistaken for one that passed. Passing the variable with an empty
value counts as not supplying it, so a runner that always passes the flag reports skips rather than
failures. The not-found case for that resource
runs regardless: it needs no real id.

## Examples make better requests

A generated body satisfies the schema and nothing more, so it cannot say which fields an update is
meant to change. `@opExample` is standard TypeSpec, and `@typespec/openapi3` publishes it too:

```typespec
@opExample(#{
  parameters: #{
    authorId: "00000000-0000-0000-0000-000000000000",
    contentType: "application/merge-patch+json",
    patch: #{ bio: "Writes about bridges." },
  },
})
@route("/{authorId}")
@patch(#{ implicitOptionality: false })
update(
  @path @format("uuid") authorId: string,
  @header contentType: "application/merge-patch+json",
  @body patch: AuthorPatch,
): Author;
```

The request sends `{"bio": "Writes about bridges."}`, and the collection asserts `bio was updated`. A
chained path parameter still takes the created id rather than the example's.

## Nested resources and deletes

A folder whose routes sit under a resource nests inside that resource's folder:

```
Authors/
  create            sets authorId
  list
  read
  update
  Books/
    create          uses authorId, sets bookId
    read
    delete
  delete            runs after everything that uses the author
```

An operation that uses a resource from outside that resource's folder, while the folder also deletes
it, cannot be ordered, and `order-cycle` names it. Declare the operation in the resource's interface,
or route it under the resource, and it nests.
