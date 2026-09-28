# Contributing to Limina

Use pnpm 11.9.0 and Node `^22.18.0 || >=24.11.0`. During migration, the declared sibling Logaria build must already exist; see [migration status](.agents/docs/migration.md).

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run check
pnpm run lint:check
pnpm run format:check
pnpm run test
pnpm run test:smoke
pnpm run lint:packages
pnpm run docs:build
```

The private root orchestrates the monorepo workspace. `packages/limina` owns the only public package; docs, smoke and shared scripts stay at the root. Private tools compile first; publication uses only `packages/limina/dist`. `docs:dev` and `docs:preview` operate on the bilingual documentation workspace. Current public documentation remains at its existing URL until the independent site is approved.

Use `lint:fix` or `format:write` only when you intend to modify files. Clean commands remove their own generated output. Preserve fixture lockfiles, independent workspace boundaries, and all existing test contracts. Read [AGENTS.md](AGENTS.md) for validation and bilingual record maintenance.

Publishing, deployment and source-repository retirement are separate, currently closed migration gates.
