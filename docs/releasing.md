# Releasing

## Rehearse against a local registry

`pnpm pack` plus a `file:` dependency skips version-range resolution, so it cannot show what a consumer
installing `typespec-postman` from a registry resolves. Publish to a local registry and install from it
into an empty directory instead.

```bash
mkdir -p /tmp/rehearsal/storage && cd /tmp/rehearsal
cat > config.yaml <<'YAML'
storage: ./storage
uplinks: { npmjs: { url: https://registry.npmjs.org/ } }
packages:
  'typespec-postman': { access: $all, publish: $anonymous }
  '@*/*':             { access: $all, proxy: npmjs }
  '**':               { access: $all, proxy: npmjs }
log: { type: stdout, format: pretty, level: warn }
YAML
printf 'registry=http://localhost:4873/\n//localhost:4873/:_authToken=rehearsal\n' > npmrc
npx --yes verdaccio@6 --config ./config.yaml --listen 4873 &

# Provenance needs a CI OIDC identity; the real publish keeps it on.
cd <this package> && NPM_CONFIG_USERCONFIG=/tmp/rehearsal/npmrc \
  npm publish --registry http://localhost:4873 --provenance=false

mkdir -p /tmp/cleanroom && cd /tmp/cleanroom
printf 'registry=http://localhost:4873/\n' > .npmrc
npm init -y >/dev/null
npm install --save-dev typespec-postman @typespec/compiler @typespec/http
cp -R <this package>/example/main.tsp <this package>/example/tspconfig.yaml .
npx tsp compile .
cmp postman_collection.json <this package>/example/postman_collection.json
```

`cmp` exiting 0 is the proof: the installed package, resolved from a registry, writes the committed
worked example byte for byte.

**A GraphQL surface is rehearsed as well**, because the worked example has none. Publish the
typespec-http-graphql the release names to the same registry, install it into the clean room beside
`typespec-hono`, compile a spec declaring a create mutation, and run its collection with the Postman CLI
against the generated server, Yoga mounted beside the REST routes, refusing a duplicate of a unique
field. Every GraphQL request has to pass: a folder that creates one resource twice from one example
fails there.

Rehearsed for 0.8.0 with typespec-http-graphql 0.4.1 and typespec-hono 0.31.1, one
`typespec-http-zod@0.34.1` under both: the worked example `cmp` 0; a bookshop whose create answers the
book or a problem, every GraphQL document valid, the run against a server refusing a duplicate title
exit 0, 18 assertions; the same bookshop with no delete warned `graphql-create-repeated`, its run
failing at `createBook` as warned; 36 collections of this package's fixtures compiled by 0.7.0 from npm
and by the rehearsal 0.8.0 without typespec-http-graphql emitted, the same byte for byte; Postman's
`collection migrate` and `collection lint` over the GraphQL collection clean. With 0.7.0 from npm the
same run fails at `mutation createBook`.

Rehearsed for 0.9.0 with typespec-http-graphql 0.5.0 from the rehearsal registry, and again with
0.4.1 from npm, the two its peer range names, beside typespec-hono 0.31.1: the worked example `cmp` 0
with each; a bookshop declaring `POST /books/{bookId}/archive` before the book's create, every
GraphQL document valid, the run against a server refusing a duplicate title exit 0 with each, 22
assertions; 0.8.0's bookshop, exit 0, 18 assertions, and with no delete warned
`graphql-create-repeated`, its run failing at `createBook` as warned; 36 collections of this
package's fixtures compiled by 0.8.0 from npm and by the rehearsal 0.9.0, the same byte for byte but
the new `test/chaining/actions.tsp`; the GraphQL fixtures compiled with typespec-http-graphql emitted
too, by 0.9.0 under 0.4.1 and under 0.5.0, the same byte for byte; and the 66 `@typespec/http-specs`
scenarios, compiled by 0.8.0 and by 0.9.0, the same byte for byte. With 0.8.0 the archive bookshop
warns `variable-collision` twice, and its run fails at `archive`, which ran first, against a `bookId`
nothing had set. pnpm finds no peer issue for 0.9.0 beside either, and an unmet peer for 0.8.0 beside
0.5.0.

## Confirm the Postman app import

`test/reference/lint.test.ts` already runs Postman's own `collection migrate` and `collection lint`
over the committed collection on every commit, so what the app reads is checked. What follows is the
app's own import dialogue, which no suite can drive.

**It is not a release blocker.** Postman's own parser and linter read the file clean, and the CLI runs
the collection green against a generated server. If an import ever does warn, the collection is
regenerated from the spec, so the fix is a spec or emitter change and a patch release, never a hand
edit of the file.

Import `example/postman_collection.json` into the Postman app, into a personal workspace, and confirm
the import reports no warnings and the requests, folders, auth and variables appear as the file states.
This is the one check no suite can make; record the app version and the outcome in the changelog entry.

## Release sequence

1. Move `## [Unreleased]` in `CHANGELOG.md` to `## [x.y.z] - YYYY-MM-DD`, and bump `package.json`.
2. Run every gate and check each by exit code: `pnpm build`, `pnpm test`, `pnpm typecheck`,
   `pnpm lint`, `pnpm format:check`.
3. Rehearse against the local registry, and confirm the app import.
4. Commit, then `git tag vX.Y.Z`, `git push origin main`, and `git push origin refs/tags/vX.Y.Z`
   separately: a lightweight tag does not travel with `--follow-tags`.
5. The release workflow publishes with provenance and creates the GitHub release from the changelog
   section. Confirm by commit SHA with `gh run list --json headSha,conclusion`, then
   `npm view typespec-postman version`.
6. **Name the exact version wherever the release is announced.** pnpm 11 holds back a version newer
   than its minimum release age, so on the day of a release `pnpm add -D typespec-postman` quietly
   installs the one before it. `pnpm add -D typespec-postman@X.Y.Z` installs the release and lists
   it in `minimumReleaseAgeExclude`.
