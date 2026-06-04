# Built-in Tasks

Built-in tasks are the check units `limina check` runs directly, and each one maps to a `limina <command>` subcommand. `limina check` (with no name) runs the first six below in a fixed order, stopping at the first failure and marking the rest as skipped. `package:check` and `release:check` are not in the default flow; they usually go into a publish [pipeline](./config/pipelines.md).

| Task                | Command                    | Default `limina check` | Surface                                  |
| ------------------- | -------------------------- | ---------------------- | ---------------------------------------- |
| `graph:check`       | `limina graph check`       | Yes, step 1            | Declaration graph / project references   |
| `source:check`      | `limina source check`      | Yes, step 2            | Package ownership boundaries             |
| `nx:check`          | `limina nx check`          | Yes, step 3            | Nx build edges                           |
| `proof:check`       | `limina proof check`       | Yes, step 4            | Source coverage / tsconfig shape         |
| `checker:build`     | `limina checker build`     | Yes, step 5            | First-class compile (emits declarations) |
| `checker:typecheck` | `limina checker typecheck` | Yes, step 6            | Second-class type checking               |
| `package:check`     | `limina package check`     | No, publish-time       | Built output                             |
| `release:check`     | `limina release check`     | No, publish-time       | Release hygiene                          |

The first column is also the string name for each task inside a pipeline; you can also write it as an explicit object `{ type: 'task', name: 'graph:check' }`.

## `graph:check`

Maps to `limina graph check`. Validates the project-reference graph formed by declaration leaves (`tsconfig*.dts.json`). Each item below explains what it detects, why, and a typical example.

::: tip
The deny/allow rules referenced here are defined in [Graph Rules](./config/graph-rules.md).
:::

### Declaration leaves need the full set of compiler options

A declaration leaf emits only `.d.ts` incrementally through `tsc -b`. So it must turn on `composite`, `incremental`, `declaration`, `emitDeclarationOnly`, turn off `noEmit`, and set `rootDir` / `outDir` / `tsBuildInfoFile`. Missing one means the incremental build cannot emit declarations correctly.

```jsonc
// packages/core/tsconfig.lib.dts.json
{
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

A missing option like `composite` reports `Invalid declaration leaf compiler option:`; a missing output field like `outDir` reports `Missing declaration leaf output option:`.

### Every leaf needs a paired companion

Each `*.dts.json` needs a same-scope ordinary `tsconfig*.json` (the companion) that owns type semantics. Their type-affecting options (such as `strict`, `module`, `target`) must agree, and the leaf may not include files beyond the companion — otherwise the "config that emits declarations" and the "config that type-checks" disagree.

```text
packages/core/
  tsconfig.lib.json       # companion: strict: true
  tsconfig.lib.dts.json   # leaf: also strict: true, file set is a subset of the companion
```

No companion reports `Missing typecheck companion config:`; mismatched options report `Typecheck option mismatch between declaration leaf and companion config:`.

### Source-owned imports need matching references

A leaf's `references` must match the real imports that resolve to source files owned by another declaration project. Code that imports another package's source entry must have a matching reference; otherwise the incremental build cannot get the upstream declarations. Conversely, a reference no import justifies is flagged too, so there are no dead edges.

```ts
// packages/app/src/main.ts
import { createClient } from '@acme/core'; // references core
```

If `packages/app/tsconfig.lib.dts.json` does not list core in `references`, it reports `Missing project reference for workspace import:`; an extra reference with no import behind it reports `Extra project reference not proven by static imports:`. Imports that resolve to built declarations such as `dist/*.d.ts` do not require a project reference. Fix source-owned edges by adding or removing the reference, or run `limina graph sync` to align automatically.

### Workspace package exports must resolve

For every workspace package that declares `exports`, graph check pre-resolves each public subpath with the active checker profiles. TypeScript resolution must reach a stable type entry or source entry: `.d.ts` family files, TypeScript source files, `.json`, or checker-supported source files such as `.vue`. Oxc resolution must also resolve; declaration-only exports may use TypeScript's `.d.ts` result as the effective Oxc result.

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

Unresolved exports report `Workspace package export is not resolvable by TypeScript:` or `Workspace package export is not resolvable by Oxc:`. If TypeScript only resolves an export to runtime JavaScript, it reports `Workspace package export resolves to runtime JavaScript in TypeScript:`.

### References/dependencies that hit a deny rule are rejected

If you define an architecture boundary under `graph.rules.<label>.deny` (for example, "client must not depend on the node runtime") and opt a leaf in through `liminaOptions.graphRules`, then a reference or dependency that hits the boundary is rejected.

```jsonc
// tsconfig.lib.dts.json
{ "liminaOptions": { "graphRules": ["runtime-client"] } }
```

A hit reports `Denied graph access:`, along with the `reason` you wrote in the rule.

## `source:check`

Maps to `limina source check`. Validates package ownership boundaries — who may import whom, and whether dependencies are declared.

### No cross-package relative imports

You cannot use `../` to reach into another package's directory; reaching another package must go through its package name, so the dependency stays explicit and traceable.

```ts
// packages/b/src/index.ts (wrong)
import { helper } from '../../a/src/util';
```

Reports `Relative import escapes package owner scope:`. Fix: declare a `workspace:*` dependency on `@acme/a` in `packages/b/package.json` and change it to `import { helper } from '@acme/a'`.

### A bare import must be declared first

A dependency imported by package name must appear in one of the nearest `package.json`'s `dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies` sections (Node builtins and the package's own name are exempt); otherwise it is an undeclared dependency.

```ts
import pMap from 'p-map'; // but package.json does not declare p-map
```

Reports `Unauthorized bare package import:`. Fix: add `p-map` to the right dependency section.

### `#subpath` imports must match imports and stay in scope

A `#xxx` subpath import must be defined in the package's `package.json#imports`, and must still resolve inside the package.

```jsonc
// package.json
{ "imports": { "#utils/*": "./src/utils/*.ts" } }
```

No match reports `Unauthorized package import specifier:`; unresolvable reports `Unresolved package import specifier:`; resolving into another package reports `Package import resolves to another package owner:`.

### Strict: cross-package must use the `workspace:` protocol

In strict mode, when an import resolves to another workspace package, the dependency must be declared with `workspace:`, not `link:` / `file:` / `catalog:` or a plain version range — so the source graph is deterministic.

```jsonc
// package.json (not "link:../a")
{ "dependencies": { "@acme/a": "workspace:*" } }
```

Otherwise it reports `Workspace bare package import must use workspace: dependency:`.

### A tsconfig / module may belong to only one owner

A governing tsconfig, or a source module, must not span more than one package (that is, more than one nearest `package.json`), otherwise ownership is unclear.

Reports `Tsconfig source file set mixes package owners:` or `Source module belongs to multiple package owners:`. Fix: split the tsconfig so each governance unit covers a single package.

### Declared-but-unused workspace dependencies (Knip)

A dependency on another package in the pnpm workspace is declared in `package.json`, but no source file in the importing package actually imports it. Detection is by dependency name: any of the four sections (`dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies`) counts, regardless of the version protocol (`workspace:`, `link:`, `catalog:`, a plain version range, and so on). The reachability analysis is delegated to Knip.

```js
// limina.config.mjs
export default defineConfig({
  source: {
    unusedDependencies: {
      ignore: [
        {
          importer: '@acme/app',
          dependency: '@acme/codegen',
          reason: 'Used only by a generate script.',
        },
      ],
    },
  },
});
```

Reports `Unused workspace package dependency:`. If it is genuinely used through generated code or a runtime string, ignore it via `source.unusedDependencies.ignore`; otherwise remove the dependency.

### Strict: source modules unreachable from exports (Knip)

In strict mode, Limina also lets Knip check whether an owner's source module is unreachable from package `exports`, `bin`, scripts, Knip-supported plugin entries, and `source.additionalEntries` — in which case it is a dead module.

```js
source: {
  unusedModules: {
    ignore: [
      { owner: '@acme/app', file: 'packages/app/src/generated/runtime.ts', reason: 'Loaded by the framework runtime.' },
    ],
  },
}
```

Reports `Unused source module:`. If the module is a real extra entry, add it through `source.additionalEntries`; for something intentionally kept but invisible to Knip, ignore it via `source.unusedModules.ignore`.

## `nx:check`

Maps to `limina nx check`. Validates that each package's Nx `project.json` build edges stay in sync with artifact consumption.

### Build edges are derived from artifact dependencies

A package's `link:<dep>/dist` means "I depend on that package's built output." Limina also scans checker-covered source files: if package A declares package B with `workspace:*` and actually imports a public export that resolves into B's artifact directory, A also needs a build dependency on B. This includes pure type artifacts such as `dist/*.d.ts`.

```jsonc
// packages/app/package.json
{
  "dependencies": {
    "@acme/core": "workspace:*",
    "@acme/ui": "link:../ui/dist",
  },
}
```

Accordingly, `app`'s `build` target in `project.json` should `dependsOn` `ui`'s build, and should also `dependsOn` `core` when app actually imports a core export that resolves to `core/dist`.

### Missing `project.json` or a divergent `dependsOn` is stale

A non-root workspace package with no `project.json`, or whose `dependsOn` diverges from the derived value, is stale, and `nx:check` fails.

Reports `Nx project config state is stale; run \`limina nx sync build\`.`. Fix: run `limina nx sync`.

### Artifact dependency targets must be valid

A `link:` must point at a real workspace package, the target must have a `build` script, it must point at an artifact directory (such as `dist`), and it must not form a cycle. A consumed `workspace:*` artifact export also requires the target package to have a `build` script. Link-derived and workspace-export-derived edges are checked together for cycles.

These report `Nx build dependency points at an unknown workspace package:`, `Nx build dependency target has no build script:`, `Nx build dependency does not point at an artifact directory:`, and `Nx artifact build dependency cycle:` respectively.

::: warning
`nx:check` is in the default `limina check`, so a brand-new repo must run `limina nx sync` first to generate `project.json`, otherwise the default check stops here.
:::

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

A source file included by two declaration leaves of the same checker causes duplicate builds and ownership ambiguity.

Reports `Duplicate checker graph coverage:`. Fix: make each file belong to a single leaf.

### Aggregators must be pure aggregators

`tsconfig*.build.json` and aggregator `tsconfig.json` files (those with `references`) may only carry `$schema` / `files: []` / `references`, with no `compilerOptions` and so on.

```jsonc
// tsconfig.build.json
{ "files": [], "references": [{ "path": "./tsconfig.lib.dts.json" }] }
```

Otherwise it reports `Build graph config is not a pure aggregator:` or `Default tsconfig.json is not a pure aggregator:`.

### Declaration leaves must have the right shape

Each `*.dts.json` must be reachable from a checker entry, have a paired companion, be valid for `tsc -b`, and align its file set and (non-output) options with the companion.

These report `DTS config is not reachable from any checker entry:`, `DTS config is not valid for tsc -b:`, `DTS config file set does not match its strict local tsconfig:`, and `DTS config overrides a typecheck compiler option from its strict local tsconfig:` respectively.

### The role of `tsconfig.json` per directory

When a directory has a single typecheck environment, use the default `tsconfig.json` as the leaf; with multiple environments, `tsconfig.json` should be a pure aggregator.

Reports `Single typecheck environment should use default tsconfig.json:` or `Directory with multiple typecheck environments must use tsconfig.json as an aggregator:`.

### Strict adds extra constraints

In strict mode, a leaf must (transitively) `extends` its companion, the build graph may reference only build/dts projects, and each module belongs to exactly one typecheck config.

These report `Strict mode requires declaration leaves to transitively extend their companion typecheck config:`, `Strict mode build graph references a non-build project:`, and `Strict mode source file belongs to multiple typecheck configs:` respectively.

## `checker:build`

Maps to `limina checker build`. Runs the first-class build compilers that actually type-check and emit declarations.

### It preflights every checker's peer dependencies first

Before running compilers, it confirms that the tool packages each configured checker needs are installed; a single missing one fails immediately with the install command.

For example, using the `tsgo` preset without installing `@typescript/native-preview` reports `Missing checker peer dependencies:` with `Fix: pnpm add -D @typescript/native-preview`.

### It runs the build compilers and emits declarations

It runs the build-execution presets: `tsc -b`, `tsgo -b`, `vue-tsc -b`. `-b` is an incremental project build that really emits `.d.ts` and `.tsbuildinfo`.

::: warning
Because it runs a real `tsc -b`, the default `limina check` emits declarations and `.tsbuildinfo` — it is not side-effect-free.
:::

### Any compiler failure fails the task

If any compiler process exits non-zero (a type error, or a missing/invalid tsconfig), the task fails.

Reports `build checks failed:` followed by the failing entries. Fix: resolve the reported type errors.

## `checker:typecheck`

Maps to `limina checker typecheck`. Runs the second-class checkers that type-check without emitting.

### It runs the same peer-dependency preflight

Just like `checker:build`, it preflights every checker's peer dependencies first.

Reports `Missing checker peer dependencies:` with `Fix: pnpm add -D <packages>`.

### It runs the typecheck checkers (no emit)

It runs the typecheck-execution presets: `vue-tsgo --project`, `svelte-check --tsconfig`. They only report type errors and emit nothing.

```js
// limina.config.mjs (excerpt)
checkers: { vue: { preset: 'vue-tsgo', entry: 'tsconfig.app.dts.json' } }
```

A `.vue` type error makes it exit non-zero and report `typecheck checks failed:`. Fix: resolve the reported `.vue` type error.

### A `tsc`-only repo is a no-op

If no second-class checker is configured (only `tsc` / `tsgo` / `vue-tsc`), this step passes and prints `No second-class checker entries configured.`; the actual type-check happens in `checker:build`.

## `package:check`

Maps to `limina package check`. Runs packaging-correctness checks against **built output** (not source), so it needs a prior build.

### publint: is the package well-formed

It runs publint (strict by default) against the output to check `exports`, the `main` / `module` / `types` fields, whether published files are complete, and other packaging-correctness issues.

Reports something like `publint found N issue(s): <label>`. Fix: address the publint findings in `package.json`.

### attw: do the types resolve correctly

It uses `@arethetypeswrong/core` to check whether types resolve under the target mode (default profile `esm-only`, overridable with `--attw-profile`).

Reports something like `attw found N problem(s): <label>`. Fix: complete or correct the `types` exports.

### boundary: output may import only declared dependencies

It parses the output's `.js` / `.cjs` / `.mjs`, and the packages they import must appear in the output manifest's `dependencies` / `peerDependencies` / `optionalDependencies`, or be the package's own exports.

Reports something like `package boundary found N issue(s): <label>`. Fix: add the missing runtime dependency to `dependencies`.

### It needs a prior build

It checks the output under `outDir`, so you must build first. Running it without a build reports `outDir package.json not found` with `Run the package build first.`. Fix: run `pnpm build` first.

### Strict: the output manifest must be publishable

In strict mode, the output `package.json` must be a complete npm manifest with no `workspace:` / `link:` / `file:` / `catalog:` pnpm-local dependencies.

Reports something like `[<label>] [strict] output package.json ...`.

## `release:check`

Maps to `limina release check`. Runs publish-time hygiene and consistency checks against built output.

### It cannot be private (or carry local dependencies)

If the output manifest is `private: true`, npm will not publish it, so it is rejected outright; strict mode also rejects `workspace:` / `link:` / `file:` / `catalog:` dependencies in the output.

A private manifest reports `selected release package has "private": true; npm publish would reject it`.

### The tarball must contain README/LICENSE and no source maps

The packed tarball must contain `README.md` and `LICENSE.md`, and must not contain `.map` files or `sourceMappingURL` directives (so source maps are not shipped).

A missing file reports `tarball is missing required file(s): LICENSE.md`. Fix: add the file and make sure it is included in the published files.

### The published manifest must not expose local dependencies

The packed manifest must not contain `workspace:` / `link:` local specifiers; workspace publish dependencies must point at real, published packages.

Reports something like `packed package manifest must not expose workspace: or link: dependency specifiers`, or `<dep> is not published to the npm registry`.

### It compares content hashes against npm

It compares the local output against the published content on the npm baseline dist-tag (default `latest`) by content hash, reporting drift (local-only, remote-only, or changed files).

Drift reports `[release-check] FAIL <importer> -> <dep>`.
