# Releasing

Metis ships to npm as **ten** `@mindlynx/metis-*` packages sharing ONE version.
The `npx @mindlynx/metis-cli` quickstart only works if ALL of them are
published - the CLI resolves its runtime packages (and the editor UI) from
node_modules.

Nobody maintains that list. `scripts/publish-all.mjs` derives it from the
`metis.edition` marker in each `package.json` and topologically sorts by
workspace dependency, so `metis-ports` goes first and `metis-cli` last. A
package whose marker is missing or not `"open"` is treated as gated and is not
published.

## The release steps

```bash
# 1. Everything green (release-audit is gates + headers + lint + typecheck + tests)
npm run release-audit && npm run e2e

# 2. Bump every package together (one shared version)
npm version 0.2.0 --workspaces --no-git-tag-version
git commit -am "release: 0.2.0"

# 3. Dry run - builds all packages and shows exactly what each tarball ships
node scripts/publish-all.mjs

# 4. The real thing (needs `npm login` with publish rights on @mindlynx)
node scripts/publish-all.mjs --publish

# 5. Prove the outsider path: in an empty directory
mkdir /tmp/metis-smoke && cd /tmp/metis-smoke
npx @mindlynx/metis-cli init
METIS_ADMIN_SECRET=pick-your-own npx @mindlynx/metis-cli up
# editor on 127.0.0.1:3000 answers, login admin / that secret works
```

`METIS_ADMIN_SECRET` is not optional in that smoke test and never will be:
`up` exits non-zero on the published default before it binds a port. If you
want the old zero-argument run for a throwaway check, it is
`METIS_INSECURE_DEMO=true` and then `admin`/`metis` - which is also the one
thing a release smoke test should NOT prove works.

## Staying in sync

`node scripts/check-publish-freshness.mjs` compares every package's local
version against npm and FAILS when the registry is behind the repo (features
shipped without a release). It warns-but-passes while nothing is published,
so it can run in CI from day one.

Rule of thumb: any change that lands in `main` and matters to a CLI user
(nodes, engine, editor, routes) means a version bump + publish. The packages
version together - never publish a subset.
