# Toolchain and checks

[English](./technology-stack.md) | [简体中文](./zh/technology-stack.md)

The manifests and lockfile own tool versions. This migration retains pnpm 11.9.0, TypeScript 6.0.3, Rolldown 1.2.10 and Vitest 4.1.11. The Node floor is `^22.18.0 || >=24.11.0`; the code remains ESM. Dependencies use pnpm catalogs, strict peers, no automatic peers or hoisting, the 1,440-minute release-age policy and the existing trust policy. Three reachable patches and the manifest-utils extension remain. `verifyDepsBeforeRun: error` makes dependency synchronization an explicit install operation. The maintainer approved a release-age exception only for `logaria@0.0.4`; it does not waive the remaining migration/publication gates.

Run `pnpm install --frozen-lockfile`, then `pnpm run build`. `build:tools` compiles the two private tools before Rolldown generates JavaScript, declarations, the published manifest and licenses. `test` builds before unit, tooling and integration tests; `smoke` builds before packed-consumer tests. `docs:build` builds both languages at base `/` with local build/commit metadata.

`lint:check` and `format:check` are read-only. Mutating counterparts are `lint:fix` and `format:write`. `typecheck`, `check` and `lint:packages` invoke the product CLI wrapper from the root. Root tooling, product, docs and build-tools use vue-tsc; ESLint and smoke use tsgo. Automatic discovery remains enabled.

CI retains Linux, macOS and Windows test/build/smoke responsibilities and the isolated Vue semantic matrix. Required status rejects skipped validation jobs. All Logaria consumers now use registry 0.0.4 through the dev catalog. The setup action still rejects temporary Logaria links before frozen installation; no old-repository build is required. Local replacement evidence and remote/platform limits are recorded in [Logaria replacement validation](../../migration/LOGARIA-0.0.4.md).

## ESLint 10 migration

Repository automation, security reports, CI reuse and gated external workflows are owned by [infrastructure](./infrastructure.md). Root tooling adds only the already cataloged YAML parser; dependency versions and the task runner remain unchanged.

The lint catalog now resolves ESLint 10.11.0, typescript-eslint 8.71.0, Unicorn 76.0.0, Node plugin 18.4.0, pnpm plugin 1.9.1, HTML plugin/parser 0.66.1, Prettier plugin 5.5.6, flat-gitignore 2.4.0, JSONC parser 3.3.0 and YAML parser 2.1.0. Existing Prettier config 10.1.8 and globals 17.12.0 remain current. Regexp stays on the compatible `~3.1.1` line: 3.3.1 pulls a parser requiring Node `^22.22.2 || >=24.15.0`, above this repository's declared floor. The obsolete HTML parser wildcard hook and its now-unreachable minimatch 3 patch/overrides were removed.

The complete new Unicorn recommended preset is enabled for JavaScript and TypeScript, followed by the repository's existing rule overrides. It is not applied to YAML/JSON/HTML parser nodes. Root composition imports explicit root file settings rather than selecting every `files` entry from the composed preset, so it cannot accidentally reapply recommended rules after shared overrides. Executable controls in the [config suite](../../packages/eslint-config/src/__tests__/general.spec.ts) cover YAML comment preservation, JavaScript fixes and override ordering. Root commands continue to pass an explicit config path despite ESLint 10's file-based lookup.

Type libraries expose the collection, object, promise and iterator APIs available at Node 22.18 while retaining the ES2023 emit target. `Promise.try` is not available at that floor and is not used. The repository-wide rule remediation preserves cache lifetime, Promise identity, fixture boundaries and code-unit string ordering; mutable module state remains owned by the same module. Error wrapping and literal package-import substitution are described by the [system model](./limina-system-model.md#failure-semantics-and-projection-boundaries).

The local baseline, three independent adversarial rounds, complete check results and uncovered conditions are recorded in [ESLint 10 migration validation](../../migration/ESLINT-10.md). This evidence does not waive independent CI, publication or deployment gates.
