# Releasing

Metis ships to npm as nine `@mindlynx/metis-*` packages sharing ONE version.
The `npx @mindlynx/metis-cli` quickstart only works if ALL of them are
published - the CLI resolves its runtime packages (and the editor UI) from
node_modules.

## The release steps

```bash
# 1. Everything green
npm run typecheck && npm run lint && npm test && npm run gates && npm run e2e

# 2. Bump every package together (one shared version)
npm version 0.2.0 --workspaces --no-git-tag-version
git commit -am "release: 0.2.0"

# 3. Dry run - builds all packages and shows exactly what each tarball ships
node scripts/publish-all.mjs

# 4. The real thing (needs `npm login` with publish rights on @mindlynx)
node scripts/publish-all.mjs --publish

# 5. Prove the outsider path: in an empty directory
mkdir /tmp/metis-smoke && cd /tmp/metis-smoke
npx @mindlynx/metis-cli init && npx @mindlynx/metis-cli up
# editor on :3000 answers, login admin/metis works
```

## Staying in sync

`node scripts/check-publish-freshness.mjs` compares every package's local
version against npm and FAILS when the registry is behind the repo (features
shipped without a release). It warns-but-passes while nothing is published,
so it can run in CI from day one.

Rule of thumb: any change that lands in `main` and matters to a CLI user
(nodes, engine, editor, routes) means a version bump + publish. The packages
version together - never publish a subset.
