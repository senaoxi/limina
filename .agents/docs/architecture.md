# Repository architecture

[English](./architecture.md) | [简体中文](./zh/architecture.md)

## Limina boundary

Repository security/reporting and external workflow boundaries are owned by [infrastructure](./infrastructure.md). The build plugin's bundled inventory is a publication asset, separate from Limina's governed artifact namespace.

The private root `@limina/monorepo` orchestrates commands and shared tooling. Within this monorepo, `packages/limina` owns the public core package, `limina`; its `src`, `bin`, `schemas`, `fixtures` and `integration` retain their internal organization. The second public package, `limina-migrate`, lives in `packages/migrate`. Only their generated `dist` directories are publication targets. The migration package uses `limina` only as a workspace development dependency and embeds the required current-source core implementation at build time. Both products still share one release version; published migrate has no Limina dependency, peer or optional dependency. Its own runtime dependencies and capability peers are explicit. The core has no runtime dependency on the migration package. The source-only `limina/internal/migration` bridge remains available in development; the core publication hook removes its entire export mapping while retaining normal workers, public API, types and schema. The CLI-only migration package runs publint and runtime boundary checks; its installed CLI is covered by tarball smoke tests. The core retains ATTW for its TypeScript API. Development dependencies may be bundled; their manifest category is not a runtime dependency declaration.

The other private workspaces are `docs`, `smoke`, `packages/build-tools` and `packages/eslint-config`. Root `scripts` owns release tooling. Fixture repositories retain independent workspace manifests and lockfiles and are outside the main workspace. Build tools and ESLint rules bootstrap through TypeScript without invoking Limina. Rolldown then builds the product before governance and consumer checks. Toolchain and dependency versions are recorded in [technology-stack](./technology-stack.md).

Root release scripts, the product and build-tools consume registry Logaria through the dev catalog (`^0.0.4`), locked to 0.0.4. No sibling Logaria build is required. The package generator resolves the catalog through pnpm and rejects unsupported local protocols; the temporary Logaria link exception has been removed.

The independent migration package preserves the existing migration transaction and governance semantics. The old `limina migration` command forwards to a local matching package or downloads that exact version through npm. Both packages share one version, release group and `limina/v<version>` tag. See [migration status](./migration.md) for evidence and the independence gate, and [Limina architecture](./limina.md) for product invariants.

Deployment-only CLI dependencies belong to the private `packages/deploy-tools` workspace and the dev catalog. They do not join the two-package publication group; see the [infrastructure owner](./infrastructure.md).
