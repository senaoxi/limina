# Repository architecture

[English](./architecture.md) | [简体中文](./zh/architecture.md)

## Limina boundary

The private root `@limina/monorepo` orchestrates commands and shared tooling. Within this monorepo, `packages/limina` owns the single public package, `limina`; its `src`, `bin`, `schemas`, `fixtures` and `integration` retain their internal organization. Only generated `packages/limina/dist` is published. Development dependencies may be bundled; their manifest category is not a runtime dependency declaration.

The other private workspaces are `docs`, `smoke`, `packages/build-tools` and `packages/eslint-config`. Root `scripts` owns release tooling. Fixture repositories retain independent workspace manifests and lockfiles and are outside the main workspace. Build tools and ESLint rules bootstrap through TypeScript without invoking Limina. Rolldown then builds the product before governance and consumer checks. The migration retains the existing toolchain and dependency versions.

Logaria currently comes from the explicitly authorized sibling `docs-islands/packages/logaria/dist`. Root release scripts use `link:../docs-islands/packages/logaria/dist`; product and build-tools use `link:../../../docs-islands/packages/logaria/dist`. Existing output is consumed without rebuilding it. The package generator normalizes only the product’s exact temporary Logaria link to that manifest’s version. Other unsupported local protocols remain errors.

This layout does not alter Limina’s governance semantics or its `migration` command. See [migration status](./migration.md) for evidence and the independence gate, and [Limina architecture](./limina.md) for product invariants.
