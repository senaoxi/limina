# Contributing to Limina

Use pnpm 11.28.3 and Node `^22.18.0 || >=24.11.0`. Logaria is installed from the registry through the dev catalog; see [migration status](.agents/docs/migration.md).

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

The private root orchestrates the monorepo. `packages/limina` and `packages/migrate` own the public `limina` and `limina-migrate` packages. They form one same-version release group; the migration package embeds the matching core implementation at build time. Publication targets only their generated `dist` directories. Docs, smoke and shared scripts stay at the root; build/lint tools compile first. Fixtures retain independent workspace and lockfile boundaries.

Use `lint:fix` or `format:write` only when you intend to modify files. Clean commands remove their own generated output. Preserve fixture lockfiles, independent workspace boundaries, and all existing test contracts. Use `docs:dev` and `docs:preview` for the bilingual documentation workspace. Read [AGENTS.md](AGENTS.md) for validation and bilingual record maintenance.

Publishing uses manual dispatch and the Release environment. Deployment and source-repository retirement retain their separate migration gates.

Use Conventional Commit PR titles and name the affected subsystem when a scope helps. Describe observable behavior, actual validation, pre-existing failures and checks not run. Preserve checker compatibility fixtures and synchronized English/Chinese PCR records. Optional VS Code settings use the root ESLint configuration and local TypeScript; they do not automatically format fixture files.

The Security workflow directly runs pnpm dependency auditing, public-package production-license reporting and Syft directory SBOM generation, and retains their reports as workflow artifacts. Run `pnpm audit --audit-level high` for the native local audit. The build plugin continues to check bundled licenses and emit the package inventory. The directory SBOM describes the built working tree, not an individual npm tarball or consumer installation.

Renovate proposes reviewed updates; peer contracts, engines and frozen compatibility fixtures are protected. Enabling the Renovate app, dependency review/code scanning features, private security reports and required branch checks needs repository administration. See the [infrastructure record](.agents/docs/infrastructure.md) for the exact gates and coverage limits. Current public documentation remains at its existing URL until independent deployment is approved.
