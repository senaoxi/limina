# CLI Reference

If you have already adopted Limina in a `TypeScript` monorepo, or you are preparing to bring `TypeScript` project references into your regular check flow, the core concern is not memorizing every command. It is understanding which commands generate the project graph, which commands check whether that graph agrees with source import relationships, and which commands only add checks for already-built artifacts.

Limina's `CLI` is centered on `TypeScript` project references. It calculates a project graph from configuration and source, then checks file ownership, package dependencies, project references, checker entries, and source coverage against that graph. Commands that need generated checker files materialize the graph under `.limina`; checks that only need graph facts use the calculated graph in memory. Without automated checks, developers have to manually decide and maintain which source relationships should enter the `references` graph. Limina turns those decisions into repeatable commands and reports.

Limina does not replace `TypeScript`, `Vue`, `Svelte`, bundlers, test frameworks, package managers, or publishing tools. It calls or coordinates part of those tools' capabilities, and adds checks on top of `TypeScript` project references, the generated project graph, and built artifacts. Package checks and release checks are supplemental capabilities and should not be understood as release security guarantees.

## Quick Start

Limina must run inside a supported workspace. The current package configuration requires `Node.js ^22.18.0 || >=24.11.0`. For manual installation, use:

```sh
pnpm add -D limina@latest typescript@^5.9.0
```

Initialize it in an existing workspace:

```sh
pnpm exec limina init --yes
pnpm i
pnpm limina:build
pnpm exec limina check
```

`limina init --yes` uses the default confirmation flow and is suitable for non-interactive environments. It writes or updates `limina.config.mts`, the `limina:build` script in the root `package.json`, and required dependencies, and ensures `.gitignore` ignores `.limina/`. If dependencies already exist, `pnpm i` may not change anything; if initialization added dependencies, install them before running the build.

The default generated config only enables automatic checker discovery:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      auto: {
        exclude: [],
      },
    },
  },
});
```

This is only a starting point. If the repository needs custom checker entries, graph rules, source exceptions, package artifact checks, or release consistency checks, continue configuring them in `limina.config.mts`.

## Command Entry and Global Options

Basic form:

```sh
limina [--config <path>] [--config-loader <loader>] [--mode <mode>] <command>
```

Global options apply to commands that need to load a Limina config file. `init` operates directly on the owning workspace and does not depend on an existing config.

| Option                     | Type             | Default behavior                                            | Related configuration                   | Example                                     | Boundary                                                                                                   |
| -------------------------- | ---------------- | ----------------------------------------------------------- | --------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--config <path>`          | path             | Searches cwd and ancestors for the default config filenames | Limina config module                    | `limina --config ./limina.config.mts check` | Its nearest `package.json` fixes the governance root; explicit query anchors may refer to a missing config |
| `--config-loader <loader>` | `native` / `tsx` | `native`                                                    | Config module loader                    | `limina --config-loader tsx check`          | `tsx` requires `tsx` to be installed in the consuming workspace                                            |
| `--mode <mode>`            | string           | `process.env.NODE_ENV`, otherwise `default`                 | `env.mode` passed to functional configs | `limina --mode ci check`                    | Only passes the mode to the config function; differences are implemented by the config file                |

The config file can export an object, a `Promise`, or a function that receives `{ command, mode }`. `command` indicates the current command family, such as `check`, `graph`, `source`, `package`, or `release`; the type remains open for other current command values such as `build` and `migration`.

## Recommended Workflow

Daily use usually starts with `limina check`. It runs the default check group: `graph:check`, `source:check`, `proof:check`, `checker:build`, and `checker:typecheck`. Together, these tasks check whether the generated graph, source boundaries, coverage relationships, and checker entries remain consistent.

Before those tasks, Limina runs the shared `workspace:validate` preparation. The same validated activated-package index gates standalone source, proof, graph, build, checker, migration, package, and release commands. Workspace issues use config-root-relative lexical paths, including `../` for external activated packages.

When you want to materialize refreshed checker files before later build or checker execution, run:

```sh
pnpm exec limina graph prepare
```

Validation-only commands such as `graph check`, `source check`, and `proof check` calculate the generated graph in memory and do not write its checker configs. Managed `build`, `checker build`, `checker typecheck`, and `check` pipelines that contain checker or `graph:prepare` tasks materialize the required files before execution.

When you only need to locate the reason for the previous failure, you do not need to rerun all checks. Read the latest completed check snapshot instead; this mode locates the workspace but does not load or execute the Limina config:

```sh
pnpm exec limina check --issues
pnpm exec limina check --issues --limit 20
pnpm exec limina check --issues --task workspace:validate
pnpm exec limina check --issues --rule LIMINA_GRAPH_REFERENCE_MISSING --verbose
pnpm exec limina check --issues --verbose --limit all
pnpm exec limina check --issues --format json
pnpm exec limina check --issues --invocation <uuid>
```

The unqualified query is freshness-aware. Once a check attempt has been published, `--issues` returns inventory only when that same attempt completed and its metadata matches the version-8 snapshot. A running, interrupted, aborted, or persistence-failed latest attempt—and any missing, corrupt, or mismatched freshness metadata—makes the query fail closed with exit code `1`; it never falls back to issues from an older completed attempt. Human, JSON, and NDJSON output all report the unavailable state explicitly.

Configuration discovery, validation, and execution-plan failures that happen before an attempt is published do not replace the previous completed inventory. If a process stops between the `last-run.json` and freshness-index writes, a later successful check with a higher sequence rewrites both files and restores query availability automatically.

When you only want to build Limina's internal declaration graph, use `checker build`. When you need to build user-consumable artifacts, use the top-level `build` command:

```sh
pnpm exec limina checker build packages/app/tsconfig.json
pnpm exec limina build packages/app/tsconfig.json
pnpm exec limina build packages/app/tsconfig.json --preset vue-tsc
pnpm exec limina build packages/app/tsconfig.raw.json --raw --preset tsc
```

When preparing packages for release, run the project's own build flow first, then run supplemental checks:

```sh
pnpm exec limina package check --package @scope/pkg
pnpm exec limina release check --package @scope/pkg
```

These two commands read the already-built `outDir`. They do not build artifacts for you and do not perform publishing.

## Decision Table

| Goal                                                               | Recommended command                        | Basis for choosing it                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Initialize Limina files in a supported workspace                   | `limina init` or `limina init --yes`       | First adoption, or generating the base config and `limina:build` script                                                                   |
| Migrate governed source `tsconfig` files                           | `limina-migrate`                           | Normalizes config topology and checks the persisted inputs in a fresh process                                                             |
| Daily repository-structure and type build entry checks             | `limina check`                             | Default group covers graph, source, coverage, and checker entries                                                                         |
| Run a custom ordered check group                                   | `limina check <name>`                      | `<name>` comes from configured `pipelines`                                                                                                |
| Materialize or refresh the `.limina` checker files                 | `limina graph prepare`                     | Before a later workflow needs the generated files on disk                                                                                 |
| Check whether project references and source dependencies agree     | `limina graph check`                       | Focuses on `references`, source imports, package dependencies, and graph rules                                                            |
| Export the package dependency graph as `JSON`                      | `limina graph export`                      | For passing source or artifact dependencies to external tools                                                                             |
| Check only source boundaries and ownership                         | `limina source check`                      | Focuses on source package boundaries, dependency declarations, and `Knip`-backed source usage                                             |
| Check whether source is covered by the generated graph or checkers | `limina proof check`                       | Focuses on omitted source, checker coverage, and allowlist validity                                                                       |
| Run internal declaration graph build entries                       | `limina checker build`                     | Uses build checker entries from the generated graph and emits only internal declaration files under `.limina`                             |
| Run internal declaration graph build for a specific config         | `limina checker build <config>`            | Accepts only Limina-managed source configs or aggregator configs; does not perform `raw build`                                            |
| Build user-consumable artifacts                                    | `limina build <config>`                    | Accepts only Limina-managed source leaves or aggregator configs that declare `liminaOptions.outputs`                                      |
| Build a user-maintained `tsconfig` directly                        | `limina build <config> --raw --preset tsc` | Does not read Limina output config and does not use the generated graph                                                                   |
| Run framework-owned leaf targets                                   | `limina checker typecheck`                 | Runs Astro- and Svelte-owned type configs once per leaf; succeeds as disabled when no target exists                                       |
| Check built package artifacts                                      | `limina package check`                     | Requires `package.entries[].outDir`; checks package manifest, `publint`, `ATTW`, or artifact import boundaries                            |
| Check pre-release artifact consistency                             | `limina release check`                     | Requires built artifacts and checks local dependency declarations, private packages, `tarball` results, or configured release consistency |

## Command Reference

### limina init

`init` generates the base adoption files for Limina in a supported workspace.

```sh
pnpm exec limina init
pnpm exec limina init --yes
```

It finds the nearest `package.json` from cwd, validates it, and places `limina.config.mts` beside it. Only when no manifest exists does it offer to create one at cwd. Invalid nearest manifests stop initialization. It adds no workspace declaration and `--yes` works without manager metadata. Init checks the selected root's packages, writes or updates the config and `.gitignore`, adds the `limina:build` script and missing Limina/TypeScript development dependencies, removes the root's existing generated `.limina` directory, and can install the optional agent skill interactively.

`--yes` accepts the default confirmation and skips the interactive `skill` installation prompt. In non-interactive environments, steps that require confirmation fail unless `--yes` is used.

`init` does not infer graph rules from business structure, and it does not decide which package boundaries should be allowed or denied. Maintain the initialized config according to the real repository structure.

### limina-migrate {#limina-migration}

`limina-migrate` is a separate CLI package paired with the exact same `limina` version. Install it locally to use the command below, or run `pnpm dlx limina-migrate@<version>`. It accepts `--config`, `--config-loader` and `--mode`; configuration functions still receive `command: 'migration'`.

`limina migration` remains as a deprecated forwarding entry. It prefers a matching local package, otherwise npm downloads that exact version. Its help stays local; offline execution requires the matching migration package to be installed. It does not upgrade project dependencies.

`limina-migrate` normalizes existing TypeScript configuration into input that Limina can discover and read again from disk.

```sh
pnpm exec limina-migrate
```

The command reports processing completion separately from input consumption. Architecture rules, package dependencies, checker ownership and type errors still belong to `limina check`. Migration does not promise equivalent native `tsc -b` behavior.

#### Configuration and relationships

Only default `tsconfig.json` files can be checker entries. Named source configs enter through solution references. Migration removes ordinary source `references`, prunes invalid or outside-region solution members, and preserves the remaining source membership. An outside-region reference is recorded without reading or migrating its target.

A pure named solution wrapper can be expanded into every parent when its rewritten references contain only `path` and it has no substantive Limina declarations. Paths are rebased for each parent; the wrapper file remains. Attributed references and named-wrapper cycles require manual conversion. Default solution cycles are pruned with compensating source memberships, preserving each retained solution's reachable sources. Empty solutions retain their solution role and an explicit `references: []`.

Limina compares native in-region source relations with independently inferred source relations. Inferred relations do not need duplicate `implicitRefs`. Remaining native declarations become explicit implicit references; existing user reasons are preserved. An incomplete analysis is reported as unavailable comparison, never as an empty inferred graph.

Unreadable configs are preserved on disk. Where safe, migration writes exact `regions.exclude` entries of kind `tsconfig` and removes incoming memberships or implicit references. This keeps the package activated. `extends` paths are not removed. A single implicit-reference object can be wrapped in an array; a missing or blank reason receives a factual migration explanation. Illegal shapes that cannot be normalized are isolated or reported as incomplete.

Automatic exclusion editing supports direct exported objects, imported `defineConfig` object calls, and uniquely used immutable `const` objects with statically editable regions/exclusion arrays. Functions, promises, spreads and dynamic composition are preserved. If required exclusions cannot be written, adoption remains incomplete. Existing output visibility cycles without a safe input baseline also require correction; migration does not exclude healthy sources to manufacture success.

#### Optional output adoption

Source compiler options, including build fields and inherited paths, remain intact. Existing valid `liminaOptions.outputs`, including `{}`, remain explicit user contracts.

| Existing configuration without explicit outputs                                              | Automatic output adoption                                      |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Effective `noEmit: true`, including inheritance                                              | None                                                           |
| Effective emit enabled and `outDir` present                                                  | Proposed, then checked against the complete candidate topology |
| Only `rootDir`, `target`, declaration flags or `noEmit: false`                               | None                                                           |
| Declaration-only emit, split declaration/JS directories, only `declarationDir`, or `outFile` | None; native options and the unadopted behavior are recorded   |
| Solution config                                                                              | None                                                           |

Each optional proposal must pass output-path and mutation-authority checks, stable descriptor discovery, and preservation of entries and their source closures. Proposals are tried once in stable config-path order. A self-hiding output, or a stable output that hides another healthy source, is rejected without isolating those sources. Rejection leaves other source conversions and independent safe outputs eligible. Migration does not duplicate the inherited source `target` into outputs or delete existing output files.

#### Writing and results

Every write target must belong to a Git worktree. All patches and input snapshots are prepared before writing; a dirty worktree requires one interactive confirmation, defaulting to no. Non-interactive runs stop before writes when confirmation is needed. Approval does not commit, stash or discard user changes.

JSONC edits preserve unrelated text, comments and line endings. Ambiguous governed keys leave that target unchanged and are reported while independent targets continue. Filesystem preflight checks canonical scope, regular files, write access, physical aliases and identity drift. Single-link files use atomic replacement. Hard-linked files require one explicit choice: rewrite through the existing inode, skip the affected consistency group, or cancel. In-place writes preserve aliases but are not atomic; all aliases observe the change.

Edits of a solution cycle and edits sharing a required persisted isolation form consistency groups. A recoverable failure restores its group and independent groups continue. Uncertain filesystem state stops execution and preserves recovery evidence. There is no cross-process writer lease and no semantic replanning after writing begins.

A fresh process loads the actual configuration through normal `check` and `graph` input readers. Only successful rereading, completed necessary writes, preserved source membership and a nonempty governed source set permit a successful adoption result. Necessary write failures, residual structural errors or unavailable verification return nonzero. Rejecting optional outputs alone does not require failure.

The audit report is `.limina/migration/latest.json`. It records targets, isolation, pruned relations, comparison completeness, output decisions, writes and final verification. Report publication failure warns without undoing committed configs. Neither core nor later migration runs use this report as input authority.

Migration does not install framework dependencies, run `astro sync`, or rewrite framework sources. Generated graphs retain manifest version 5; no migration readiness or partial-graph state is persisted there.

### limina check [pipeline]

`check` is the daily entry point.

```sh
pnpm exec limina check
pnpm exec limina check ci
pnpm exec limina check --package @scope/pkg
```

Without `pipeline`, the default check group is:

```txt
graph:check
source:check
proof:check
checker:build
checker:typecheck
```

Tasks in the default group are scheduled independently according to available resources. Named pipelines come from configured `pipelines` and run through `limina check <name>`, with steps executed in configured order. Pipeline steps may be built-in tasks or external commands. External commands support object-form configuration with `command`, `args`, `cwd`, and `env`.

Common options:

| Option                 | Type                      | Default behavior            | Example                                                       | Boundary                                                             |
| ---------------------- | ------------------------- | --------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `-p, --package <name>` | repeatable string         | Do not restrict packages    | `limina check -p @scope/pkg`                                  | Only affects tasks that support package selection                    |
| `--verbose`            | boolean                   | Output compact summaries    | `limina check --verbose`                                      | Expands a live run summary; with `--issues`, renders detailed cards  |
| `--rule <code>`        | repeatable string         | Do not filter by rule       | `limina check --issues --rule LIMINA_GRAPH_REFERENCE_MISSING` | Requires `--issues` for issue queries                                |
| `--file <path>`        | repeatable path           | Do not filter by file       | `limina check --issues --file packages/a/src/index.ts`        | Matches exact file paths                                             |
| `--scope <glob>`       | repeatable path or `glob` | Do not filter by path scope | `limina check --issues --scope 'packages/a/**'`               | Matches path-bearing issue candidates only                           |
| `--task <name>`        | repeatable string         | Do not filter by task       | `limina check --issues --task source:check`                   | Must be used with `--issues`                                         |
| `--checker <name>`     | repeatable string         | Do not filter by checker    | `limina check --issues --checker vue`                         | Only filters issue snapshots here; it is not build checker selection |
| `--issues`             | boolean                   | Read the latest summary     | `limina check --issues`                                       | Reads the last completed check; cannot be used with a pipeline name  |
| `--limit <limit>`      | positive integer or `all` | 20 visible issue cards      | `limina check --issues --limit 50`                            | Human issue inventories only; must be used with `--issues`           |
| `--invocation <uuid>`  | UUID                      | Read the last check         | `limina check --issues --invocation <uuid>`                   | Reads one immutable standalone failure record                        |
| `--format <format>`    | `human`, `json`, `ndjson` | `human`                     | `limina check --issues --format json`                         | Must be used with `--issues`                                         |

`--issues` does not rerun checks. Without `--invocation`, it reads the last terminal `limina check` result and is used to locate failed tasks, rules, packages, files, or checkers. A running or interrupted check does not replace the previous completed result, and standalone commands do not replace it either. Workspace validation failures are recordable too: the trusted `.limina` snapshot namespace is created before validation, so a structural failure can still appear under task `workspace:validate`. Before using the default issue inventory for the first time, let `limina check` finish once.

Issue output is progressive:

| View     | Trigger                                                                                              | Output                                                                                                                                  | Visible issue limit |
| -------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Summary  | `limina check --issues` with no filter, invocation, or explicit limit                                | Full filtered-set counts, primary blockers, and next commands; no issue cards                                                           | No cards            |
| Compact  | Add any task, rule, package, file, scope, or checker filter; select an invocation; or pass `--limit` | One bounded card per selected issue with one location, rule, optional owner/tool metadata, and one-line summary/reason/fix fields       | 20 by default       |
| Detailed | Add `--verbose` to an issue query                                                                    | Selected issue cards with all locations, evidence, external diagnostics, fix steps, verification commands, and deduplicated raw details | 20 by default       |
| Machine  | Use `--format json` or `--format ndjson`                                                             | The complete filtered issue set in the existing machine-readable contract                                                               | Never truncated     |

Human summary counts and primary blockers always use the complete filtered set. Compact and detailed cards are sampled deterministically: Limina gives unrelated root causes visibility before taking another sample from the same root cause, then rotates across packages within that root cause. The report states `Showing X of Y issues`. Use `--limit <positive integer>` for an exact card budget or `--limit all` for every matching card. A zero-match query keeps its summary, filter diagnostics, and help commands without printing an empty card section.

`--limit` is valid only with `check --issues` in human format. JSON and NDJSON reject it and continue to return every filtered issue; `--verbose` has no effect on machine output. `limina check --verbose` has a different scope from `limina check --issues --verbose`: the former expands aggregate run rows, durations, ranked rules, blockers, and package counts, but never prints raw issue diagnostics; the latter selects the detailed issue-card view.

When an issue-producing standalone command fails, it prints an invocation ID and a shell-specific query. Each variant uses the current absolute Node executable and installed Limina `bin/limina.js`, carries the absolute config path, effective loader and mode, and selects `check --issues --invocation <uuid>`. The Windows command also changes to the governance root using PowerShell `Set-Location -LiteralPath`. Queries can be replayed from another directory without requiring a project manager. Invocation records live under the same governance root's `.limina/check/invocations/`.

An explicit query `--config` is a lexical location anchor: the module can have been deleted or renamed. Its nearest manifest must still exist and be a valid object. Queries never import configuration, resolve manager adapters, rebuild packages, or run preflight. Without `--config`, current default config discovery is required. Missing persisted records never fall back to an ancestor workspace.

On POSIX systems the command is labeled `Query:`. On Windows, Limina prints a `PowerShell:` command for Windows PowerShell 5.1 or PowerShell 7; run it in PowerShell, including when Limina was launched from CMD. Limina does not print a CMD variant. You can append query options such as `--format json` or `--file src/index.ts` to the printed command.

An invocation is a selector, not an issue filter, so it promotes the default human view to compact. Its human header shows the invocation ID, kind, result, and completion time. Generated refine, detailed, complete, JSON, and filter-help commands retain the same invocation ID, active filters, and explicit global config context. The recorded original command remains metadata and is not reused to construct a new query.

`--file` performs exact matching, while `--scope` accepts a directory or `glob`. Both accept workspace-relative paths, `./` paths, absolute paths, and either slash style. They match only path-bearing candidates such as issue files and package manifests; diagnostic labels such as config field scopes are not treated as paths. Repeated values within one filter use OR semantics.

Check snapshots use schema version 8, and the reader accepts only version 8.

Helper queries:

```sh
pnpm exec limina check --issues --task --help
pnpm exec limina check --issues --package --help
pnpm exec limina check --issues --checker --help
pnpm exec limina check --issues --rule --help
```

Task help always includes every public static check task and then merges task names found in the snapshot. It therefore remains useful when the snapshot is missing or contains no issues. Package and checker help remain snapshot-derived.

### limina graph \<action\>

The `graph` command generates, checks, and exports the project graph.

```sh
pnpm exec limina graph prepare
pnpm exec limina graph check
pnpm exec limina graph export
pnpm exec limina graph export --view source --output graph.json
```

`graph prepare` generates the project graph and checker entries under `.limina` from checker configuration, source `tsconfig` files, workspace packages, and source import relationships. It is suitable after changes to `tsconfig`, checker include ranges, source structure, or project reference relationships.

`graph check` checks whether the generated graph is consistent with source import relationships. It covers project references, source graph routing, condition domains, reference completeness, graph rules, workspace package dependency declarations, and some resolution boundaries. Typical issues include missing project references for source imports, extra project references, missing dependency declarations for cross-package project references, graph-rule denials, and workspace imports that cannot resolve or whose targets are not in the generated graph.

`graph export` outputs a package-level dependency graph as `JSON`. `--view` can be `all`, `source`, or `artifact`; the default is `all`. Without `--output`, it writes to stdout; with `--output <path>`, it writes to a file. The export is intended for external task tools or analysis tools, and does not mean Limina has built-in task orchestration capability.

### limina source check

`source check` focuses on file ownership and source package boundaries.

```sh
pnpm exec limina source check
pnpm exec limina source check --package @scope/pkg
pnpm exec limina source check --scope 'packages/app/**' --verbose
```

For `limina source check --scope`, a scope may also be relative to the selected source owner. For example, `src/theme` matches `packages/app/src/theme` for the `packages/app` owner. Workspace-relative, absolute, and glob forms continue to work as well.

It checks whether source files belong to workspace packages, whether non-aggregator `tsconfig` files mix multiple workspace package owners, whether ordinary relative imports cross the nearest `package.json` package boundary, whether bare package imports are authorized by the owning workspace package or explicit rules, whether `#...` package imports stay inside the declaring package scope, and source usage backed by `Knip`.

`Knip`-related checks depend on `knip` as a peer dependency and run only when `source.knip` is explicitly set to `true` or an object containing `root` or `workspaces`. Omitting or setting `source.knip` to `false` disables that part of source usage checking; it does not disable graph checks, proof checks, or checker execution. An enabled but missing `knip` peer dependency makes `source check` fail before source analysis.

`source check` does not replace `ESLint`, test frameworks, or runtime checks. It mainly turns file ownership, package boundaries, and dependency declaration relationships into filterable issue reports.

### limina proof check

`proof check` checks source coverage relationships.

```sh
pnpm exec limina proof check
pnpm exec limina proof check --verbose
```

Based on the generated graph, checker entries, project routes, source boundaries, and `proof.allowlist`, it checks whether source files are covered by the generated graph or checkers, and reports issues related to checker coverage targets, default `tsconfig` files, declaration configs, local paired configs, or allowlist entries. It also validates unique config ownership, solution consistency, framework leaf executability, target coverage, declaration-provider projections, and typed dependency-edge integrity.

This command does not mean “complete type-safety proof.” More precisely, it checks whether the source set currently managed by Limina can be explained by the generated project graph or checker entries, so source does not fall outside the managed scope unnoticed.

### limina build \<config\>

`build` builds user-consumable artifacts. Managed mode only accepts Limina-managed configs: source leaves must declare `liminaOptions.outputs`; under an aggregator config, at least one recursively referenced source leaf must declare `liminaOptions.outputs`.

```sh
pnpm exec limina build packages/app/tsconfig.json
pnpm exec limina build packages/app/tsconfig.json --preset tsc
pnpm exec limina build packages/app/tsconfig.json --watch
pnpm exec limina build packages/app/tsconfig.raw.json --raw --preset vue-tsc
```

Managed mode generates and runs output build configs under `.limina/tsconfig/checkers/<checker>/outputs/`. When multiple build-capable checkers match the target, `--preset` is required. `--watch` uses the corresponding checker adapter's watch capability and fails clearly when unsupported.

After a successful non-watch managed build, Limina supplements TypeScript emit by copying local declaration inputs (`.d.ts`, `.d.cts`, `.d.mts`) that are under the configured output `rootDir` into `outDir` with the same relative path. Declaration inputs outside `rootDir` or from dependencies are not copied; move them under `rootDir`, widen `liminaOptions.outputs.rootDir`, or add an explicit copy step when needed.

`--raw` directly runs `tsc`, `tsgo`, or `vue-tsc` against a user-maintained `tsconfig`. Raw mode requires `--preset`, does not prepare the generated graph, does not read `liminaOptions.outputs`, does not use Limina-inferred references, and rejects generated configs under `.limina`.

### limina checker build [config]

`checker build` only builds Limina's internal declaration graph. Supported build checker identities are `tsc`, `tsgo`, and `vue-tsc`; the command-line selector remains named `--preset`.

```sh
pnpm exec limina checker build
pnpm exec limina checker build packages/app/tsconfig.json
pnpm exec limina checker build packages/app/tsconfig.json --preset tsc
pnpm exec limina checker build packages/app/tsconfig.json --preset vue-tsc --watch
```

Without `config`, the command uses all build checker entries in the generated graph. With `config`, Limina only resolves the internal declaration target corresponding to an already managed config; if the config is not managed by Limina, it fails immediately. The command does not read `liminaOptions.outputs`, does not generate user artifacts such as `dist`, and does not perform `raw build` on user-maintained `tsconfig` files.

`--watch` is allowed only with a config path. `--preset` also requires a config path.

This command still depends on the corresponding checker packages. Missing `peer dependency` packages are reported with the package that needs to be installed, such as `typescript`, `vue-tsc`, or `@typescript/native-preview`.

### limina checker typecheck

`checker typecheck` runs the final Astro- and Svelte-owned type configs directly, once per normalized leaf config path.

```sh
pnpm exec limina checker typecheck
pnpm exec limina checker typecheck --verbose
```

The command consumes the ownership plan produced by graph preparation. Solution configs are recursively expanded by Limina; the command does not depend on external framework checkers recursively supporting TypeScript project references.

Auto-detected Astro targets run `astro check --noSync --root <leaf> --tsconfig <source-config>` and require leaf-local `astro`, `@astrojs/check`, `typescript`, and `.astro/types.d.ts`. Auto-detected Svelte targets run `svelte-check --workspace <leaf> --tsconfig <source-config>` and require leaf-local `svelte-check`, `svelte2tsx`, `svelte`, and `typescript`. Limina does not run Astro sync or enable Svelte incremental cache behavior.

`checker typecheck` does not accept a config path, `--preset`, or `--watch`. Watch is explicitly unsupported for these framework targets; rerun the command after source config, parser package, generated type, or framework source changes. If no framework-owned leaf exists, the runner records the task as disabled, skips peer preflight and generated-artifact materialization, and exits successfully.

### limina package check

`package check` checks already-built package output and is a supplemental capability.

```sh
pnpm exec limina package check
pnpm exec limina package check --package @scope/pkg
pnpm exec limina package check --package @scope/pkg --tool publint
pnpm exec limina package check --tool attw --attw-profile strict
```

It reads `package.entries` from configuration, enters each entry's `outDir`, and reads `package.json` from the built artifacts. If `publint` or `attw` is enabled, it first packs the output directory as a temporary `tarball` before passing it to the corresponding tool. If `boundary` is enabled, it scans `JavaScript` files in the output directory and checks whether external package imports, self-reference imports, and `Node` builtin usage comply with the artifact package manifest and configuration.

`--tool` can be `all`, `publint`, `attw`, or `boundary`. `--attw-profile` can be `strict`, `node16`, or `esm-only`; the default comes from configuration or the source default. The source default `profile` is `esm-only`.

`package check` does not run builds, publish packages, or guarantee artifacts work in every consumer environment. It only reports provable issues based on configuration and already-built artifacts.

### limina release check

`release check` checks pre-release package artifact consistency and is also a supplemental capability.

```sh
pnpm exec limina release check
pnpm exec limina release check --package @scope/pkg
pnpm exec limina release check --package @scope/pkg --verbose
```

It also selects artifact directories based on `package.entries`, and requires the checked package to match the current working directory or the `--package` selection. The command reads `package.json` from the output directory and checks local dependency declarations that should not appear in published artifacts, such as `workspace:`, `link:`, `file:`, or `catalog:`. If the output manifest is marked `private: true`, it is also reported as a pre-release issue. Then it packs the artifacts and runs release consistency checks, including `tarball`, package manifest, registry baseline, or content-hash-related checks depending on configuration and current artifact state. When `release.npmPackageJsonLint` is enabled, it also uses the separately installed `npm-package-json-lint` package to check the packed manifest.

`release check` does not run `npm publish`, and it does not replace package-manager or registry-side validation. It is suitable as a local consistency check before a publish command.

Package/release tarball checks retain the existing `pnpm pack --ignore-scripts` backend for the configured output directory. That backend is independent of single-package/workspace classification and of the project's declared manager. It requires pnpm to be available. Passing these checks describes this pnpm-packed output; other managers may produce different publish artifacts. Required names, versions, output files, and optional tools apply to the checked output and capability.

## Troubleshooting

| Symptom or error message                                                                              | Likely cause                                                                                                | Action                                                                                                                        |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `No package.json found`                                                                               | No manifest exists above the selected configuration                                                         | Add a package manifest or select the intended config                                                                          |
| `Unable to find limina config`                                                                        | No supported Limina config file was found                                                                   | Run `limina init`, or pass a config path through `--config`                                                                   |
| `Invalid package.json object` / `Unable to read root package.json`                                    | The nearest manifest is invalid                                                                             | Fix that file; an ancestor manifest cannot replace it                                                                         |
| `checker build --preset requires a config argument`                                                   | `--preset` can only choose the build checker for a specific config                                          | Use `limina checker build <config> --preset tsc`                                                                              |
| `checker build --watch requires a config argument`                                                    | Watch mode only supports a specified config                                                                 | Use `limina checker build <config> --watch`                                                                                   |
| `limina build --raw requires --preset`                                                                | Raw mode did not specify a checker preset                                                                   | Use `limina build <config> --raw --preset tsc`                                                                                |
| `checker typecheck does not accept --preset` or `--watch`                                             | Typecheck runs the complete framework leaf target set; per-target framework watch is unsupported            | Rerun `checker typecheck` after source config, parser package, generated type, or framework source changes                    |
| `No package checks are enabled`                                                                       | The selected package entries do not enable any package checks                                               | Check `package.entries[].checks`, or remove the unneeded package check task                                                   |
| `outDir package.json not found`                                                                       | Package artifacts have not been built, or `outDir` is incorrect                                             | Run the project build first, then check `package.entries[].outDir`                                                            |
| `Missing Limina runtime dependency`                                                                   | A Limina-owned runtime is unavailable or outside its supported range                                        | Install or adjust it in the workspace running Limina                                                                          |
| `Missing external checker`                                                                            | A configured external checker is unavailable in its execution scope                                         | Install the checker in the reported checker scope                                                                             |
| `Unsupported external checker`                                                                        | The selected external checker version is outside Limina's supported range                                   | Upgrade or downgrade the checker in the reported checker scope                                                                |
| `Missing Astro semantic toolchain dependency`                                                         | An eligible Astro source import cannot resolve a dependency declared by its owner scope                     | Install or reinstall the supported Astro/check toolchain in the owning leaf; do not rely on an undeclared workspace-root copy |
| `Unsupported Astro semantic toolchain`                                                                | The owner-scoped Astro/check tuple or internal API shape is outside the supported adapter                   | Align the owning leaf with the documented tuple; physical pnpm store or hoist paths do not need to match                      |
| `Unsupported vue-tsc toolchain`                                                                       | The `vue-tsc` installation has an incomplete or incompatible internal tuple                                 | Upgrade, downgrade, or reinstall `vue-tsc`; do not install its internal packages for Limina                                   |
| `Missing framework checker dependencies`                                                              | A leaf framework target is missing its command or execution runtime                                         | Install the reported Astro or Svelte dependencies in the owning leaf                                                          |
| `Astro generated types are missing`                                                                   | The leaf package has not produced `.astro/types.d.ts`                                                       | Run `pnpm --dir <leaf> exec astro sync`; Limina never runs this command automatically                                         |
| `publint` or `@arethetypeswrong/core` is not installed; skipping check                                | An enabled optional release analyzer is not installed                                                       | Install the analyzer when CI requires that coverage; a skipped release analyzer alone does not make the command exit non-zero |
| `source.knip` is enabled but `knip` is not installed                                                  | The explicit Knip source-usage feature has no Limina runtime dependency                                     | Install `knip` in the workspace running Limina, or set `source.knip` to `false`/omit it to disable the feature                |
| `` `limina check --task`, `--checker`, `--format`, `--invocation`, and `--limit` require --issues. `` | Snapshot query options were used on the rerun-check command                                                 | Add `--issues`, or remove those query options                                                                                 |
| `` `limina check --issues` does not accept a pipeline name. ``                                        | `--issues` reads the latest snapshot and does not run a pipeline                                            | Use `limina check --issues`; do not add a pipeline name                                                                       |
| `Invalid check --issues --limit ...`                                                                  | The limit is zero, negative, fractional, exponential notation, non-numeric, or above the safe integer range | Use a positive decimal integer or `all`                                                                                       |
| `` `limina check --issues --limit` is only available with --format human. ``                          | A human card limit was combined with JSON or NDJSON                                                         | Remove `--limit`, or use human output                                                                                         |
| `Invalid graph export --view`                                                                         | `--view` is outside the supported range                                                                     | Use `all`, `source`, or `artifact`                                                                                            |
