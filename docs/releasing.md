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

## Confirm the Postman app import

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

**Only Zach authorises a release, directly.**
