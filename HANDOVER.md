# Working record

Everything here was measured. Read it before changing the emitter.

## START HERE

- **State:** `0.1.0`, unpublished. Every gate is green by exit code; see the latest commit for the
  counts. Publishing is Zach's decision alone.
- **Gates:** `pnpm build`, `pnpm test` (unit and system projects), `pnpm typecheck`, `pnpm lint`,
  `pnpm format:check`. `pnpm test` builds first because the compiler loads the emitter from `dist/`.
- **The system project needs the Postman CLI on `PATH`** and fails without it.

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
   own operations before every interface.

## Findings in sibling packages, not fixed here

- **typespec-hono made optional auth required. Fixed on its `main` (`d180e18`), unreleased.**
  `@useAuth(NoAuth | X)` publishes `security: [{}, {X}]`, and the generated gate dropped the `{}`, so a
  correct `authorize` refused anonymous callers the contract allows. Measured by request on
  `authentication/noauth/union` (401). The gate now passes the empty requirement; this emitter's run
  suite never depended on it, because it sends the credentialed alternative.
- **typespec-http-zod refuses a multipart text part carrying a number.** `payload/multipart`
  `non-string-float` declares `HttpPart<{ @body body: float64; @header contentType: "text/plain" }>`;
  the validator is `z.number()`, so the text part the scenario documents is refused with a 400. Named in
  `test/corpus/corpus.test.ts` as `SERVER_DEFECTS`.

## Open

- **The Postman app import** has not been confirmed. It is the one acceptance check no suite can make;
  `docs/releasing.md` makes it a release step.
- **Postman's authored templates are not an oracle.** The public copies are forks in individual users'
  workspaces, with no established licence or fidelity. The importer differential is the reference.

## How this work is done

- Measure, never assert. Every fix above came from running something.
- A new output gets a row in `docs/oracles.md` and a planted defect that turns something red.
- A difference from Postman's importer is a defect unless `test/reference/importer.test.ts` lists it with
  a reason.
