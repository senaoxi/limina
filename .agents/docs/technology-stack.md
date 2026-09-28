# Toolchain and checks

[English](./technology-stack.md) | [简体中文](./zh/technology-stack.md)

The manifests and lockfile own tool versions. This migration retains pnpm 11.9.0, TypeScript 6.0.3, Rolldown 1.2.10 and Vitest 4.1.11. The Node floor is `^22.18.0 || >=24.11.0`; the code remains ESM. Dependencies use pnpm catalogs, strict peers, no automatic peers or hoisting, the 1,440-minute release-age policy and the existing trust policy. Four reachable patches and the manifest-utils extension remain. `verifyDepsBeforeRun: error` makes dependency synchronization an explicit install operation.

Run `pnpm install --frozen-lockfile`, then `pnpm run build`. `build:tools` compiles the two private tools before Rolldown generates JavaScript, declarations, the published manifest and licenses. `test` builds before unit, tooling and integration tests; `smoke` builds before packed-consumer tests. `docs:build` builds both languages at base `/` with local build/commit metadata.

`lint:check` and `format:check` are read-only. Mutating counterparts are `lint:fix` and `format:write`. `typecheck`, `check` and `lint:packages` invoke the product CLI wrapper from the root. Root tooling, product, docs and build-tools use vue-tsc; ESLint and smoke use tsgo. Automatic discovery remains enabled.

CI retains Linux, macOS and Windows test/build/smoke responsibilities and the isolated Vue semantic matrix. Required status rejects skipped validation jobs. The temporary Logaria link deliberately blocks independent CI until an independently consumable source is approved; it does not authorize building the old repository in CI.
