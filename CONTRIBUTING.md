# Contributing to Limina

Use pnpm 11.9.0 and Node `^22.18.0 || >=24.11.0`. Logaria is installed from the registry through the dev catalog; see [migration status](.agents/docs/migration.md).

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run infrastructure:check
pnpm run typecheck
pnpm run check
pnpm run lint:check
pnpm run format:check
pnpm run test
pnpm run test:smoke
pnpm run lint:packages
pnpm run docs:build
pnpm run artifacts:report
```

The private root orchestrates the monorepo. `packages/limina` and `packages/migrate` own the public `limina` and `limina-migrate` packages. They form one same-version release group; the migration package depends on exactly that core version. Publication targets only their generated `dist` directories. Docs, smoke and shared scripts stay at the root; build/lint tools compile first, and deployment-only dependencies stay in private `packages/deploy-tools`. Fixtures retain independent workspace and lockfile boundaries.

Use `lint:fix` or `format:write` only when you intend to modify files. Clean commands remove their own generated output. Preserve fixture lockfiles, independent workspace boundaries, and all existing test contracts. Use `docs:dev` and `docs:preview` for the bilingual documentation workspace. Read [AGENTS.md](AGENTS.md) for validation and bilingual record maintenance.

Publishing, deployment and source-repository retirement are separate, currently closed migration gates.

Use Conventional Commit PR titles and name the affected subsystem when a scope helps. Describe observable behavior, actual validation, pre-existing failures and checks not run. Preserve checker compatibility fixtures and synchronized English/Chinese PCR records. Optional VS Code settings use the root ESLint configuration and local TypeScript; they do not automatically format fixture files.

`pnpm run security:audit` audits all dependency classes, writes reports under `.reports/security` and fails on high/critical findings or invalid output. It adds no exclusions. `artifacts:report` packs both built public packages, measures actual archive bytes and generates bundled-license reports and scoped CycloneDX SBOMs under `.reports/release`. These reports do not infer externally resolved consumer dependencies.

Renovate proposes reviewed updates; peer contracts, engines and frozen compatibility fixtures are protected. Enabling the Renovate app, dependency review/code scanning features, private security reports and required branch checks needs repository administration. See the [infrastructure record](.agents/docs/infrastructure.md) for the exact gates and coverage limits. Current public documentation remains at its existing URL until independent deployment is approved.
