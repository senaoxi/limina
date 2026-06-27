# Built-in Tasks

Built-in tasks are the check units `limina check` can schedule directly, and each one maps to a `limina <command>` subcommand. `limina check` (with no name) includes `graph:check`, `source:check`, `proof:check`, `checker:build`, and `checker:typecheck` by default. Their results are displayed and recorded in a stable order, but the tasks are scheduled independently: when the `execution.tasks` concurrency budget and resource locks allow it, they can run at the same time. A built-in task failure fails the run, but it does not prevent other built-in tasks from completing. `graph:prepare`, `package:check`, and `release:check` are not in the default check; add them to a named [pipeline](./config/pipelines.md) when you need an explicit graph-generation step or publish-time checks.

| Task                | Command                    | Default check       | Surface                                |
| ------------------- | -------------------------- | ------------------- | -------------------------------------- |
| `graph:check`       | `limina graph check`       | Yes, result order 1 | Declaration graph / project references |
| `graph:prepare`     | `limina graph prepare`     | No, standalone      | Generated graph files                  |
| `source:check`      | `limina source check`      | Yes, result order 2 | Package ownership boundaries           |
| `proof:check`       | `limina proof check`       | Yes, result order 3 | Source coverage / tsconfig shape       |
| `checker:build`     | `limina checker build`     | Yes, result order 4 | Build-mode type checking               |
| `checker:typecheck` | `limina checker typecheck` | Yes, result order 5 | Type checking without emit             |
| `package:check`     | `limina package check`     | No, publish-time    | Built output                           |
| `release:check`     | `limina release check`     | No, publish-time    | Release hygiene                        |

The first column is also the string name for each task inside a pipeline; you can also write it as an explicit object `{ type: 'task', name: 'graph:check' }`.

The order above is the reporting and recording order, not a guarantee of serial execution for the default check. Use a named [pipeline](./config/pipelines.md) when you need a fixed sequence.

## `graph:prepare`

Maps to `limina graph prepare`. It only refreshes Limina's generated graph files: `.limina/manifest.json`, checker build entries, generated declaration configs, declaration output directories, and tsbuildinfo paths. It does not run graph-rule validation or checker processes.

Tasks that consume the generated graph prepare it automatically before they run. Add `graph:prepare` to a named pipeline only when you want that materialization as an explicit step, for example to verify that generated files can be written or are up to date before later work.

## `graph:check`

Maps to `limina graph check`. Validates the declaration build graph generated under `.limina/`, using the source tsconfigs selected by `checker.include` as the canonical user-facing paths. Each item below explains what it detects, why, and a typical example.

::: tip
The deny/allow rules referenced here are defined in [Graph Rules](./config/graph-rules.md).
:::

### Declaration build configs need the full set of compiler options

A generated declaration build config emits only `.d.ts` incrementally through `tsc -b`. Limina writes these configs during `limina graph prepare`; each one turns on `composite`, `incremental`, `declaration`, `emitDeclarationOnly`, turns off `noEmit`, and sets `rootDir` / `outDir` / `tsBuildInfoFile`.

```jsonc
// .limina/tsconfig/checkers/typescript/projects/packages/core/tsconfig.lib.dts.json
{
  "extends": "../../../../../packages/core/tsconfig.lib.json",
  "compilerOptions": {
    "composite": true,
    "incremental": true,
    "declaration": true,
    "emitDeclarationOnly": true,
    "noEmit": false,
    "rootDir": "./src",
    "outDir": "./dist",
    "tsBuildInfoFile": "./dist/.tsbuildinfo",
  },
}
```

These files are generated, so a shape problem usually means the generated graph is stale or malformed; run `limina graph prepare` and check the reported source tsconfig path.

### Every generated config needs a paired source config

Each generated `*.dts.json` needs a `liminaOptions.sourceConfig` that points back to the ordinary source `tsconfig*.json` that owns type semantics. Type-affecting options such as `module`, `target`, and `lib` are inherited from that source config, and the generated config may not include files beyond the source config.

```text
packages/core/
  tsconfig.lib.json       # source config owns type-affecting options
.limina/tsconfig/checkers/typescript/projects/packages/core/
  tsconfig.lib.dts.json   # generated config, sourceConfig -> packages/core/tsconfig.lib.json
```

Generated configs without `sourceConfig` are rejected. When diagnostics mention a generated path, Limina maps it back to the source tsconfig path whenever possible.

### Source-owned imports need matching references

A generated config's `references` must match real source edges: static imports that resolve to source files owned by another declaration project, plus any documented `liminaOptions.implicitRefs`. Code that imports another package's source entry must have a matching reference; otherwise the incremental build cannot get the upstream declarations. Conversely, a reference justified by neither static imports nor `implicitRefs` is flagged too, so there are no dead edges.

```ts
// packages/app/src/main.ts
import { createClient } from '@acme/core'; // references core
```

Generated declaration references come from real imports that resolve to source files owned by another generated config. If a source-owned edge is missing, make sure both source tsconfig files are selected by `checker.include`, then run `limina graph prepare`. Imports that resolve to built declarations such as `dist/*.d.ts` do not require a project reference.

When a real edge cannot be seen from static imports, document it on the source tsconfig that needs the edge:

```jsonc
{
  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../core/tsconfig.json",
        "reason": "Loaded by generated route manifest.",
      },
    ],
  },
}
```

`implicitRefs.path` points to another ordinary source tsconfig relative to the declaring config. Limina maps it to the generated declaration project. Do not put `references` on source leaf configs; only solution-style `tsconfig.json` aggregators should carry TypeScript `references`.

### Workspace package exports must resolve

For every workspace package that declares `exports`, graph check pre-resolves each real public subpath with the active checker profiles. `null` export entries are treated as denied package subpaths and skipped. Each real export must resolve to a concrete module through the runtime resolver; declaration-only exports may use TypeScript's `.d.ts` result as the effective runtime result.

When checked source imports one of these exports, TypeScript resolution must reach a stable type entry or source entry: `.d.ts` family files, TypeScript source files, `.json`, or checker-supported source files such as `.vue`. Runtime-only exports that are not imported by checked source may point at JavaScript artifacts, but once source imports them they need a type entry.

```jsonc
// the dependency's packages/core/package.json
{
  "exports": {
    ".": "./src/index.ts",
    "./types": { "types": "./dist/types.d.ts" },
    "./runtime": {
      "types": "./dist/runtime.d.ts",
      "default": "./dist/runtime.js",
    },
  },
}
```

Unresolved exports report `Workspace package export is not resolvable by TypeScript:` or `Workspace package export is not resolvable by Oxc:`. If checked source imports an export that only resolves to runtime JavaScript, it reports `Workspace source import uses package export without a type entry:`.

### References/dependencies that hit a deny rule are rejected

If you define an architecture boundary under `graph.rules.<label>.deny` (for example, "client must not depend on the node runtime") and opt a source tsconfig in through `liminaOptions.graphRules`, then a reference or dependency that hits the boundary is rejected.

```jsonc
// packages/app/tsconfig.client.json
{ "liminaOptions": { "graphRules": ["runtime-client"] } }
```

`limina graph prepare` carries the rule labels into the generated build config. A hit reports `Denied graph access:`, along with the `reason` you wrote in the rule.

## `source:check`

Maps to `limina source check`. Validates source ownership, package-scope relative import boundaries, and whether dependencies are declared.

### No cross-package relative imports

You cannot use `../` to reach into another package's directory; reaching another package must go through its package name, so the dependency stays explicit and traceable.

```ts
// packages/b/src/index.ts (wrong)
import { helper } from '../../a/src/util';
```

Reports `Relative import escapes package scope:`. Fix: declare a dependency on `@acme/a` in `packages/b/package.json` and change it to `import { helper } from '@acme/a'`.

### A bare import must be declared first

A dependency imported by package name must be authorized by the nearest pnpm workspace source owner. A matching `source.importAuthority.allow` package rule can also let Limina check the workspace root `package.json`, but that root manifest must exist and declare the package. True non-manifest exceptions can use `source.importAuthority.allow` specifier rules.

```ts
import pMap from 'p-map'; // but package.json does not declare p-map
```

Reports `Unauthorized bare package import:`. Fix: add `p-map` to the right dependency section.

### `#subpath` imports follow package-scope imports

A `#xxx` subpath import is matched against the nearest package scope `package.json#imports` for the importing file. When that mapping uses a relative target, the resolved file must stay inside the package scope that declares the mapping.

```jsonc
// package.json
{ "imports": { "#utils/*": "./src/utils/*.ts" } }
```

`imports` targets may also name a package, for example `{ "imports": { "#dep": "p-map" } }`. In that case Limina treats the result as an external package dependency: it may resolve to a third-party package or a workspace dependency, but the importing file's pnpm workspace source owner must authorize that dependency through its dependency sections or a matching `source.importAuthority.allow` rule.

No match reports `Unauthorized package import specifier:` and points at the nearest package scope. Unresolvable matches report `Unresolved package import specifier:`. Relative targets that escape the declaring package scope report `Package import relative target escapes package scope:`. Package targets that are not authorized reuse the dependency authorization diagnostic.

### A tsconfig / module may belong to only one owner

A governing tsconfig, or a source module, must not span more than one pnpm workspace source owner, otherwise ownership is unclear.

Reports `Tsconfig source file set mixes source owners:` or `Source module belongs to multiple source owners:`. Fix: split the tsconfig so each governance unit covers a single package.

### Declared-but-unused workspace dependencies (Knip)

A dependency on another package in the pnpm workspace is declared in `package.json`, but no source file in the importing package actually imports it. Detection is by dependency name: any of the four sections (`dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies`) counts, regardless of the version protocol (`workspace:`, `link:`, `catalog:`, a plain version range, and so on). The reachability analysis is delegated to Knip.

```js
// limina.config.mjs
export default defineConfig({
  source: {
    knip: {
      workspaces: {
        '@acme/app': {
          ignoreDependencies: [
            {
              dep: '@acme/codegen',
              reason: 'Used only by a generate script.',
            },
          ],
        },
      },
    },
  },
});
```

Reports `Unused workspace package dependency:`. If it is genuinely used through generated code or a runtime string, ignore it via `source.knip.workspaces[pkg].ignoreDependencies`; otherwise remove the dependency.

### Source modules unreachable from exports (Knip)

Limina lets Knip check whether an owner's source module is unreachable from package `exports`, `bin`, scripts, Knip-supported plugin entries, and `source.knip.workspaces[pkg].entry` — in which case it is a dead module.

```js
source: {
  knip: {
    workspaces: {
      '@acme/app': {
        ignoreFiles: [
          { file: 'packages/app/src/generated/runtime.ts', reason: 'Loaded by the framework runtime.' },
        ],
      },
    },
  },
}
```

Reports `Unused source module:`. If the module is a real extra entry, add it through `source.knip.workspaces[pkg].entry`; for something intentionally kept but invisible to Knip, ignore it via `source.knip.workspaces[pkg].ignoreFiles`.

## `graph export`

Maps to `limina graph export`. It exports the package dependency graph that Limina inferred from real imports and module resolution inside the governed tsconfig domains.

```sh
pnpm exec limina graph export --view all --output .limina/dependency-graph.json
```

The JSON contains package nodes and `source` / `artifact` edges. A `source` edge means the import resolved to source governed by the type graph. An `artifact` edge means the import resolved to built output such as `dist/*.js` or `dist/*.d.ts`. Dependency protocols do not decide the edge kind; the resolved file does.

Each edge respects the importing project's compiler options, including `compilerOptions.customConditions`. Because this is a Limina-governed graph rather than a global build resolver graph, use it for architecture inspection and diagnostics, not as an authoritative task graph or build-order source:

```sh
pnpm exec limina graph export --view artifact
```

## `proof:check`

Maps to `limina proof check`. Proves that every source file is covered by some checker, and validates tsconfig shape and roles.

::: tip
Files you intentionally leave uncovered go in the [Proof Allowlist](./config/proof-allowlist.md).
:::

### Every file in the boundary must be covered

Every source file inside the `config.source` boundary must be covered by a checker entry, a graph project, or `proof.allowlist`; an unowned file is flagged.

```text
packages/core/src/generated/runtime.ts  # not covered by any checker entry
```

Reports `Source files are not covered by typecheck proof:`. Fix: bring it into a tsconfig reachable from a checker entry; if it is generated code or a fixture, add it to `config.source.exclude`, or add a `proof.allowlist` entry with a reason.

### The same file must not be covered twice

A source file included by two source tsconfigs of the same checker causes duplicate generated declaration owners and ownership ambiguity.

Reports `Duplicate checker graph coverage:`. Fix: make each file belong to a single source tsconfig per checker.

### Aggregators must be pure aggregators

Source-level aggregator `tsconfig.json` files (those with `references`) may only carry `$schema` / `files: []` / `references`, with no `compilerOptions` and so on. Limina writes a checker root build aggregator under `.limina/tsconfig/checkers/<checker>/tsconfig.build.json`, and writes source solution build aggregators under `.limina/tsconfig/checkers/<checker>/solutions/.../tsconfig.build.json`.

```jsonc
// tsconfig.json
{ "files": [], "references": [{ "path": "./tsconfig.lib.json" }] }
```

Otherwise it reports `Default tsconfig.json is not a pure aggregator:`.

### Declaration build configs must have the right shape

Each generated `*.dts.json` must be reachable from a generated checker build entry, have a `sourceConfig`, be valid for `tsc -b`, and align its file set and (non-output) options with the source config.

These report `DTS config is not reachable from any checker entry:`, `DTS config is not valid for tsc -b:`, `DTS config file set does not match its local typecheck config:`, and `DTS config overrides a typecheck compiler option from its local typecheck config:` respectively.

### The role of `tsconfig.json` per directory

When a directory has a single typecheck environment, use the default `tsconfig.json` as the leaf; with multiple environments, `tsconfig.json` should be a pure aggregator.

Reports `Single typecheck environment should use default tsconfig.json:` or `Directory with multiple typecheck environments must use tsconfig.json as an aggregator:`.

### Typecheck shape constraints

A leaf must transitively `extends` its companion, the build graph may reference only build/dts projects, and each module belongs to exactly one typecheck config.

These report `Declaration leaf does not transitively extend its companion typecheck config:`, `Build graph references a non-build project:`, and `Source file belongs to multiple typecheck configs:` respectively.

## `checker:build`

Maps to `limina checker build`. Runs the checkers that support build mode, so they type-check and emit declarations.

### It preflights every checker's peer dependencies first

Before running compilers, it confirms that the tool packages each configured checker needs are installed; a single missing one fails immediately with the install command.

For example, using the `tsgo` preset without installing `@typescript/native-preview` reports `Missing checker peer dependencies:` with `Fix: pnpm add -D @typescript/native-preview`.

### It runs the build compilers and emits declarations

It runs the build-execution presets: `tsc -b`, `tsgo -b`, `vue-tsc -b`. `-b` is an incremental project build that really emits `.d.ts` and `.tsbuildinfo`.

::: warning
Because it runs a real `tsc -b`, the default `limina check` emits declarations and `.tsbuildinfo` — it is not side-effect-free.
:::

### It warns about incompatible build checker combinations

After the build processes finish, Limina checks which build checker presets reached the same generated declaration config. This does not change the exit code; it is a warning about cache safety.

No warning is printed when every reachable checker uses the same preset, or when the only mixed presets are `tsc` and `vue-tsc`. Other mixed build presets, such as `tsgo` with `tsc` or `tsgo` with `vue-tsc`, are reported because they do not safely share the same underlying build cache semantics.

The warning includes the generated config, the source config behind it, and a `reachable from` section:

```text
Potentially incompatible build checker combination:
  source config: packages/core/tsconfig.lib.json
  reachable from:
    - config.checkers.typescript (tsgo)
      entry tsconfigs:
        - packages/app/tsconfig.json
    - config.checkers.vue (vue-tsc)
      entry tsconfigs:
        - packages/theme/tsconfig.json
```

The important part is not only the `source config`. A checker may reach that config through another entry that imports it. To remove the warning, align the reachable entry area shown in `entry tsconfigs`, or switch to a compatible preset combination such as `tsc` with `vue-tsc`.

### Any compiler failure fails the task

If any compiler process exits non-zero (a type error, or a missing/invalid tsconfig), the task fails.

Reports `build checks failed:` followed by the failing entries. Fix: resolve the reported type errors.

## `checker:typecheck`

Maps to `limina checker typecheck`. Runs checkers that type-check without emitting files.

### It preflights typecheck checker peer dependencies

This step only preflights the configured typecheck-only checker entries it is about to run, such as `vue-tsgo` and `svelte-check`. Build-execution presets are handled by `checker:build`.

Reports `Missing checker peer dependencies:` with `Fix: pnpm add -D <packages>`.

### It runs the typecheck checkers (no emit)

It runs the typecheck-execution presets: `vue-tsgo --project`, `svelte-check --tsconfig`. They only report type errors and emit nothing.

```js
// limina.config.mjs (excerpt)
checkers: { vue: { preset: 'vue-tsgo', include: ['apps/app/tsconfig.json'] } }
```

A `.vue` type error makes it exit non-zero and report `typecheck checks failed:`. Fix: resolve the reported `.vue` type error.

### Repositories without typecheck-only checkers are a no-op

If no explicit typecheck-only checker is configured, for example auto mode or only `tsc` / `tsgo` / `vue-tsc`, this step passes and prints `No second-class checker entries configured.`; the actual type-check happens in `checker:build`.

## `package:check`

Maps to `limina package check`. Runs packaging-correctness checks against **built output** (not source), so it needs a prior build.

### publint: is the package well-formed

It runs publint against the output to check `exports`, the `main` / `module` / `types` fields, whether published files are complete, and other packaging-correctness issues.

Reports something like `publint found N issue(s): <label>`. Fix: address the publint findings in `package.json`.

### attw: do the types resolve correctly

It uses `@arethetypeswrong/core` to check whether types resolve under the target mode (default profile `esm-only`, overridable with `--attw-profile`).

Reports something like `attw found N problem(s): <label>`. Fix: complete or correct the `types` exports.

### boundary: output may import only declared dependencies

It parses the output's `.js` / `.cjs` / `.mjs`, and the packages they import must appear in the output manifest's `dependencies` / `peerDependencies` / `optionalDependencies`, or be the package's own exports.

Reports something like `package boundary found N issue(s): <label>`. Fix: add the missing runtime dependency to `dependencies`.

### It needs a prior build

It checks the output under `outDir`, so you must build first. Running it without a build reports `outDir package.json not found` with `Run the package build first.`. Fix: run `pnpm build` first.

### The output manifest must be publishable

The output `package.json` must be a complete npm manifest with no `workspace:` / `link:` / `file:` / `catalog:` pnpm-local dependencies.

Reports something like `[<label>] output package.json ...`.

## `release:check`

Maps to `limina release check`. Runs publish-time hygiene and consistency checks against built output.

### It cannot be private (or carry local dependencies)

If the output manifest is `private: true`, npm will not publish it, so it is rejected outright; release check also rejects `workspace:` / `link:` / `file:` / `catalog:` dependencies in the output.

A private manifest reports `selected release package has "private": true; npm publish would reject it`.

### The tarball must contain README/LICENSE and no source maps

The packed tarball must contain `README.md` and `LICENSE.md`, and must not contain `.map` files or `sourceMappingURL` directives (so source maps are not shipped).

A missing file reports `tarball is missing required file(s): LICENSE.md`. Fix: add the file and make sure it is included in the published files.

### The published manifest must not expose local dependencies

The packed manifest must not contain `workspace:` / `link:` / `file:` / `catalog:` local specifiers in any dependency section; workspace publish dependencies must point at real, published packages.

Reports something like `packed package manifest must not expose workspace:, link:, file:, or catalog: dependency specifiers in any dependency section`, or `<dep> is not published to the npm registry`.

### It compares content hashes against npm

It compares the local output against the published content on the npm baseline dist-tag (default `latest`) by content hash, reporting drift (local-only, remote-only, or changed files).

Drift reports `[release-check] FAIL <importer> -> <dep>`.
