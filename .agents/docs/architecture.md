# Repository architecture

[English](./architecture.md) | [简体中文](./zh/architecture.md)

## Limina boundary

The private root `limina-monorepo` orchestrates commands and shared tooling. Within this monorepo, `packages/limina` owns the public core package, `limina`; its `src`, `bin`, `schemas`, `fixtures` and `integration` retain their internal organization. The second public package, `limina-migrate`, lives in `packages/migrate`. Only their generated `dist` directories are publication targets. The migration package has an exact-version runtime dependency on `limina`; the core has no runtime dependency on the migration package. The CLI-only migration package runs publint and runtime boundary checks; its installed CLI is covered by tarball smoke tests. The core retains ATTW for its TypeScript API. Development dependencies may be bundled; their manifest category is not a runtime dependency declaration.

The other private workspaces are `docs`, `smoke`, `packages/build-tools` and `packages/eslint-config`. Root `scripts` owns release tooling. Fixture repositories retain independent workspace manifests and lockfiles and are outside the main workspace. Build tools and ESLint rules bootstrap through TypeScript without invoking Limina. Rolldown then builds the product before governance and consumer checks. The migration retains the existing toolchain and dependency versions.

Logaria currently comes from the explicitly authorized sibling `docs-islands/packages/logaria/dist`. Root release scripts use `link:../docs-islands/packages/logaria/dist`; product and build-tools use `link:../../../docs-islands/packages/logaria/dist`. Existing output is consumed without rebuilding it. The package generator normalizes only the product’s exact temporary Logaria link to that manifest’s version. Other unsupported local protocols remain errors.

The independent migration package preserves the existing migration transaction and governance semantics. The old `limina migration` command forwards to a local matching package or downloads that exact version through npm. Both packages share one version, release group and `limina/v<version>` tag. See [migration status](./migration.md) for evidence and the independence gate, and [Limina architecture](./limina.md) for product invariants.
