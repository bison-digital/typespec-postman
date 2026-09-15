# Working record

Everything here was measured. Read it before changing the emitter.

## START HERE

- **State:** `0.1.0`, unpublished. Every gate is green by exit code; see the latest commit for the
  counts. Publishing is Zach's decision alone.
- **Gates:** `pnpm build`, `pnpm test` (unit and system projects), `pnpm typecheck`, `pnpm lint`,
  `pnpm format:check`. `pnpm test` builds first because the compiler loads the emitter from `dist/`.
- **The system project needs the Postman CLI on `PATH`** and fails without it.
- **The registry rehearsal passed at `a27f730`** (2026-09-16): published to a local verdaccio,
  installed into an empty npm project from it with `@typespec/compiler`, `@typespec/http` and the new
  `@typespec/openapi3` peer, compiled `example/main.tsp`, and `cmp` against the committed collection
  exited 0. The app import is the one release step left.

## The things most easily lost

1. **The run suite is the proof that matters.** `test/run/run.test.ts` serves a typespec-hono server
   generated from `example/main.tsp` and runs the committed-shape collection through the real Postman
   CLI. Every assertion kind has a mutant server that must turn it red, on that assertion by name.
2. **Postman prunes a GET or HEAD body** unless the item sets `protocolProfileBehavior.disableBodyPruning`.
   Measured on the CLI: without the flag the body arrived empty.
3. **Postman resolves a variable inside another variable's value**, both in `--env-var` values and in
   path variables. `baseUrl` defaults to `{{endpoint}}`-style templates because of it, and a credential
   can be wired to a chained id from the command line.
4. **Root requests run in file order**, not "folders first" as one Postman docs page says.
5. **openapi3 publishes a create body as the canonical model**, with a read-only id both `readOnly` and
   `required`. The generated server forbids the id. The emitter follows OpenAPI's read-only rule and
   leaves it out; the corpus judge applies the same rule to the document before validating.
6. **`@typespec/http`'s `parseUriTemplate` is not exported.** `src/uri.ts` carries a copy; never build a
   URL from `HttpOperation.path`, which drops the expansion operator.
7. **Declaration order is source position**, not `service.operations` order, which lists a namespace's
   own operations before every interface. The compiler loads imports one at a time
   (`source-loader.js` awaits each), so `program.sourceFiles` order depends on the import graph alone.
8. **A response body is compared as the model the document names.** `@typespec/http` resolves a body
   whose model has a property invisible at Read to an anonymous copy; `getEffectivePayloadType` is how
   openapi3 names it, and comparing the copy by identity silently lost every role of such a resource.
9. **A numeric key reads back as text** only because every collection variable is declared
   `type: "string"`: `postman-collection` casts a `set` value through the declared type. Remove it and
   "Returns the requested widget" fails through the CLI (`test/run/edges.tsp`).
10. **The server judge's verdict is reaching a handler.** A wrong route answers 404 from the router
    without any validator seeing it; the judge once stayed green with every bodiless URL broken.
11. **Response schemas come from `getOpenAPI3` in-process, converted to draft-07.** The Postman
    sandbox is Ajv 6.12.5: it ignores `prefixItems` and `unevaluatedProperties`, refuses a 2020-12
    `$schema`, cannot resolve `#/components`, and throws on a format it does not know.
    `src/draft07.ts` rewrites each, only ever toward accepting more, and
    `test/schemas/fidelity.test.ts` holds it to the document's verdict under `ajv@6.12.5` (`ajv6`).
12. **Hono merges the previous response's headers into a replacement `c.res`**, so a test server
    that edits response headers has to clear `c.res` first. And a 204 cannot carry a body on the
    wire, so the no-body mutant answers 200.
13. **The provenance gate holds private terms as SHA-256 digests.** The first version spelled them in
    plain text in this public repository. Never add a term in plain text; add its digest.

## Findings in sibling packages, not fixed here

- **typespec-hono made optional auth required. Fixed on its `main` (`d180e18`), unreleased.**
  `@useAuth(NoAuth | X)` publishes `security: [{}, {X}]`, and the generated gate dropped the `{}`, so a
  correct `authorize` refused anonymous callers the contract allows. Measured by request on
  `authentication/noauth/union` (401). The gate now passes the empty requirement; this emitter's run
  suite never depended on it, because it sends the credentialed alternative.
- **typespec-http-zod refused a multipart text part carrying a number. Fixed on its `main`
  (`134ee96`), unreleased.** `HttpPart<float64>` was `z.number()` on the text a form carries. This
  package resolves typespec-hono and typespec-http-zod from the registry, so `test/corpus/corpus.test.ts`
  still names the request in `SERVER_DEFECTS`; the arm requiring every listed defect to occur fails the
  day a released pair carries the fix, and that is when the entry is deleted.
- **typespec-http-zod refused a JSON multipart part. Fixed on its `main` (`4443274`), unreleased.**
  `HttpPart<Address>` arrives as JSON text with `Content-Type: application/json`; measured 400 on the
  Postman CLI's bytes. No corpus scenario sends one (each also has a file part), so nothing here lists it.
- **typespec-hono refused 34 conformant corpus requests. Fixed on its `main` (`a53d8f3`), unreleased.** Path expansions
  (`{.x}`, `{;x}`, `{/x}`, `primitive{x}`, and `optional{/name}` in `parameters/path`) are mounted with
  the operator dropped, and a literal query string is mounted inside the router path: 31 answer 404,
  including the exact URIs http-specs' own mock declares. A form-expanded record or model query answers
  400 (3). `SERVER_DEFECTS` names each request until a released pair carries the fix, and the arm
  requiring every listed defect to occur fails the day one does. typespec-hono now mounts from the
  library's `pathSegments`, and every mock URI reaches its handler.

## Open

- **GitHub still serves the pre-rewrite commits by SHA.** `test/provenance.test.ts` spelled the first
  consumer's names in plain text from the first commit. The tree was fixed, and history was rewritten
  with `git filter-repo --replace-text` and force-pushed on 2026-09-15 (no object in the new history
  carries a term). The unreachable old commits stay viewable on GitHub until GitHub Support purges them.

- **The Postman app import** has not been confirmed. It is the one acceptance check no suite can make;
  `docs/releasing.md` makes it a release step.
- **Postman's authored templates are not an oracle.** The public copies are forks in individual users'
  workspaces, with no established licence or fidelity. The importer differential is the reference.

## How this work is done

- Measure, never assert. Every fix above came from running something.
- A new output gets a row in `docs/oracles.md` and a planted defect that turns something red.
- A difference from Postman's importer is a defect unless `test/reference/importer.test.ts` lists it with
  a reason.
