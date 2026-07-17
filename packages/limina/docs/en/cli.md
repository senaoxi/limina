# CLI Reference

If you have already adopted Limina in a `TypeScript` monorepo, or you are preparing to bring `TypeScript` project references into your regular check flow, the core concern is not memorizing every command. It is understanding which commands generate the project graph, which commands check whether that graph agrees with source import relationships, and which commands only add checks for already-built artifacts.

Limina's `CLI` is centered on `TypeScript` project references. It generates a project graph under `.limina` from configuration and source, then checks file ownership, package dependencies, project references, checker entries, and source coverage based on that graph. Without automated checks, developers have to manually decide and maintain which source relationships should enter the `references` graph. Limina turns those decisions into repeatable commands and reports.

Limina does not replace `TypeScript`, `Vue`, `Svelte`, bundlers, test frameworks, package managers, or publishing tools. It calls or coordinates part of those tools' capabilities, and adds checks on top of `TypeScript` project references, the generated project graph, and built artifacts. Package checks and release checks are supplemental capabilities and should not be understood as release security guarantees.

## Quick Start

Limina must run inside a `pnpm` workspace. The current package configuration requires `Node.js ^22.18.0 || >=24.11.0`. For manual installation, use:

```sh
pnpm add -D limina@^0.1.1 typescript@^5.9.0
```

Initialize it in an existing `pnpm` workspace:

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
      mode: 'auto',
      exclude: [],
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

Global options apply to commands that need to load a Limina config file. `init` operates directly on the current `pnpm` workspace and does not depend on an existing config.

| Option                     | Type             | Default behavior                                                                                                                                                   | Related configuration                   | Example                                     | Boundary                                                                                    |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `--config <path>`          | path             | Searches upward from the current directory for `limina.config.mts`, `limina.config.mjs`, `limina.config.ts`, or `limina.config.js` until the `pnpm` workspace root | Limina config file                      | `limina --config ./limina.config.mts check` | The config file must be inside the current `pnpm` workspace                                 |
| `--config-loader <loader>` | `native` / `tsx` | `native`                                                                                                                                                           | Config module loader                    | `limina --config-loader tsx check`          | `tsx` requires `tsx` to be installed in the consuming workspace                             |
| `--mode <mode>`            | string           | `process.env.NODE_ENV`, otherwise `default`                                                                                                                        | `env.mode` passed to functional configs | `limina --mode ci check`                    | Only passes the mode to the config function; differences are implemented by the config file |

The config file can export an object, a `Promise`, or a function that receives `{ command, mode }`. `command` indicates the current command family, such as `check`, `graph`, `source`, `package`, or `release`.

## Recommended Workflow

Daily use usually starts with `limina check`. It runs the default check group: `graph:check`, `source:check`, `proof:check`, `checker:build`, and `checker:typecheck`. Together, these tasks check whether the generated graph, source boundaries, coverage relationships, and checker entries remain consistent.

Before those tasks, Limina runs the shared `workspace:validate` preparation. The same validated activated-package index gates standalone source, proof, graph, build, checker, migration, package, and release commands. Workspace issues use config-root-relative lexical paths, including `../` for external activated packages.

When you change `tsconfig`, `references`, checker include ranges, or source structure that affects the generated graph, run:

```sh
pnpm exec limina graph prepare
pnpm exec limina check
```

When you only need to locate the reason for the previous failure, you do not need to rerun all checks. Read the latest check snapshot instead:

```sh
pnpm exec limina check --issues
pnpm exec limina check --issues --limit 20
pnpm exec limina check --issues --task workspace:validate
pnpm exec limina check --issues --rule LIMINA_GRAPH_REFERENCE_MISSING --verbose
pnpm exec limina check --issues --verbose --limit all
pnpm exec limina check --issues --format json
```

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
| Initialize Limina files in a `pnpm` workspace                      | `limina init` or `limina init --yes`       | First adoption, or generating the base config and `limina:build` script                                                                   |
| Migrate governed source `tsconfig` files                           | `limina migration`                         | Moves compiler output settings into `liminaOptions` after workspace validation                                                            |
| Daily repository-structure and type build entry checks             | `limina check`                             | Default group covers graph, source, coverage, and checker entries                                                                         |
| Run a custom ordered check group                                   | `limina check <name>`                      | `<name>` comes from configured `pipelines`                                                                                                |
| Generate or refresh the `.limina` project graph                    | `limina graph prepare`                     | After changing `tsconfig`, checker ranges, or source structure                                                                            |
| Check whether project references and source dependencies agree     | `limina graph check`                       | Focuses on `references`, source imports, package dependencies, and graph rules                                                            |
| Export the package dependency graph as `JSON`                      | `limina graph export`                      | For passing source or artifact dependencies to external tools                                                                             |
| Check only source boundaries and ownership                         | `limina source check`                      | Focuses on source package boundaries, dependency declarations, and `Knip`-backed source usage                                             |
| Check whether source is covered by the generated graph or checkers | `limina proof check`                       | Focuses on omitted source, checker coverage, and allowlist validity                                                                       |
| Run internal declaration graph build entries                       | `limina checker build`                     | Uses build checker entries from the generated graph and emits only internal declaration files under `.limina`                             |
| Run internal declaration graph build for a specific config         | `limina checker build <config>`            | Accepts only Limina-managed source configs or aggregator configs; does not perform `raw build`                                            |
| Build user-consumable artifacts                                    | `limina build <config>`                    | Accepts only Limina-managed source leaves or aggregator configs that declare `liminaOptions.outputs`                                      |
| Build a user-maintained `tsconfig` directly                        | `limina build <config> --raw --preset tsc` | Does not read Limina output config and does not use the generated graph                                                                   |
| Run non-build checker entries                                      | `limina checker typecheck`                 | For entries such as `vue-tsgo` or `svelte-check` that only type-check                                                                     |
| Check built package artifacts                                      | `limina package check`                     | Requires `package.entries[].outDir`; checks package manifest, `publint`, `ATTW`, or artifact import boundaries                            |
| Check pre-release artifact consistency                             | `limina release check`                     | Requires built artifacts and checks local dependency declarations, private packages, `tarball` results, or configured release consistency |

## Command Reference

### limina init

`init` generates the base adoption files for Limina in a `pnpm` workspace.

```sh
pnpm exec limina init
pnpm exec limina init --yes
```

It searches upward from the current directory for `pnpm-workspace.yaml`, confirms the workspace root, checks workspace packages, and then performs the following actions: writes or updates `limina.config.mts`; ensures `.gitignore` contains `.limina/`; creates or updates the `limina:build` script in the root `package.json`; adds development dependencies if `limina` or `typescript` is missing; removes the existing generated `.limina` directory at the root; and, in interactive mode, asks whether to install the Limina `agent skill`.

`--yes` accepts the default confirmation and skips the interactive `skill` installation prompt. In non-interactive environments, steps that require confirmation fail unless `--yes` is used.

`init` does not infer graph rules from business structure, and it does not decide which package boundaries should be allowed or denied. Maintain the initialized config according to the real repository structure.

### limina migration

`migration` rewrites the source `tsconfig` entries selected from the validated activated package islands.

```sh
pnpm exec limina migration
```

External activated packages are supported, including a migration whose targets belong to several Git worktrees. Before writing anything, Limina resolves every target's canonical Git worktree root and requires every involved worktree to be clean. It then executes one transaction with those canonical roots as the complete write allowlist. A dirty external worktree blocks all writes; every target must belong to a Git worktree.

Migration selection follows the same package-island visibility and checker selectors as graph preparation. It never reads or edits a config behind an owner-local boundary merely because an ancestor pattern could match it.

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

When an issue-producing standalone command fails, it prints a standalone invocation ID and a ready-to-run `limina check --issues --invocation <uuid>` query. Each invocation is stored independently under `.limina/check/invocations/`. If the original command used an explicit `--config`, the printed query carries its canonical absolute path, so the same record can be queried from another working directory. Issue queries locate the workspace without importing or validating the Limina config.

An invocation is a selector, not an issue filter, so it promotes the default human view to compact. Its human header shows the invocation ID, kind, result, and completion time. Generated refine, detailed, complete, JSON, and filter-help commands retain the same invocation ID, active filters, and explicit global config context. The recorded original command remains metadata and is not reused to construct a new query.

`--file` performs exact matching, while `--scope` accepts a directory or `glob`. Both accept workspace-relative paths, `./` paths, absolute paths, and either slash style. They match only path-bearing candidates such as issue files and package manifests; diagnostic labels such as config field scopes are not treated as paths. Repeated values within one filter use OR semantics.

Check snapshots use schema version 7, and the reader accepts only version 7.

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

It checks whether source files belong to `pnpm` workspace packages, whether non-aggregator `tsconfig` files mix multiple workspace package owners, whether ordinary relative imports cross the nearest `package.json` package boundary, whether bare package imports are authorized by the owning workspace package or explicit rules, whether `#...` package imports stay inside the declaring package scope, and source usage backed by `Knip`.

`Knip`-related checks depend on `knip` as a peer dependency and are affected by `source.knip` configuration. Disabling or adjusting `Knip` config only affects that part of source usage checking; it does not disable graph checks, proof checks, or checker execution.

`source check` does not replace `ESLint`, test frameworks, or runtime checks. It mainly turns file ownership, package boundaries, and dependency declaration relationships into filterable issue reports.

### limina proof check

`proof check` checks source coverage relationships.

```sh
pnpm exec limina proof check
pnpm exec limina proof check --verbose
```

Based on the generated graph, checker entries, project routes, source boundaries, and `proof.allowlist`, it checks whether source files are covered by the generated graph or checkers, and reports issues related to checker coverage targets, default `tsconfig` files, declaration configs, local paired configs, or allowlist entries.

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

`checker build` only builds Limina's internal declaration graph. Supported presets are `tsc`, `tsgo`, and `vue-tsc`.

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

`checker typecheck` runs non-build checker entries.

```sh
pnpm exec limina checker typecheck
pnpm exec limina checker typecheck --verbose
```

Built-in non-build checkers in the source include `vue-tsgo` and `svelte-check`. `vue-tsgo` entries can still participate in the source graph and coverage proof. `svelte-check` participates in coverage proof and typecheck execution, but it is not currently a source graph provider. Neither is a build-mode execution entry for `checker build`.

`checker typecheck` does not accept a config path, `--preset`, or `--watch`. If no non-build checker entries are configured, the command succeeds with no runnable entries.

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

It also selects artifact directories based on `package.entries`, and requires the checked package to match the current working directory or the `--package` selection. The command reads `package.json` from the output directory and checks local dependency declarations that should not appear in published artifacts, such as `workspace:`, `link:`, `file:`, or `catalog:`. If the output manifest is marked `private: true`, it is also reported as a pre-release issue. Then it packs the artifacts and runs release consistency checks, including `tarball`, package manifest, registry baseline, or content-hash-related checks depending on configuration and current artifact state.

`release check` does not run `npm publish`, and it does not replace package-manager or registry-side validation. It is suitable as a local consistency check before a publish command.

## Troubleshooting

| Symptom or error message                                                                              | Likely cause                                                                                                | Action                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `no pnpm-workspace.yaml was found`                                                                    | Current directory is not inside a `pnpm` workspace                                                          | Run the command inside a workspace, or create `pnpm-workspace.yaml` first                                             |
| `Unable to find limina config`                                                                        | No supported Limina config file was found                                                                   | Run `limina init`, or pass a config path through `--config`                                                           |
| `config file must be inside the governed pnpm workspace`                                              | `--config` points outside the workspace                                                                     | Put the config file inside the current `pnpm` workspace                                                               |
| `checker build --preset requires a config argument`                                                   | `--preset` can only choose the build checker for a specific config                                          | Use `limina checker build <config> --preset tsc`                                                                      |
| `checker build --watch requires a config argument`                                                    | Watch mode only supports a specified config                                                                 | Use `limina checker build <config> --watch`                                                                           |
| `limina build --raw requires --preset`                                                                | Raw mode did not specify a checker preset                                                                   | Use `limina build <config> --raw --preset tsc`                                                                        |
| `checker typecheck does not accept --preset` or `--watch`                                             | `checker typecheck` only runs non-build checker entries                                                     | Use `checker build <config>` for a single config                                                                      |
| `No package checks are enabled`                                                                       | The selected package entries do not enable any package checks                                               | Check `package.entries[].checks`, or remove the unneeded package check task                                           |
| `outDir package.json not found`                                                                       | Package artifacts have not been built, or `outDir` is incorrect                                             | Run the project build first, then check `package.entries[].outDir`                                                    |
| `Missing peer dependency ...`                                                                         | A checker or package check tool is not installed                                                            | Install the reported peer dependency, such as `typescript`, `vue-tsc`, `knip`, `publint`, or `@arethetypeswrong/core` |
| `` `limina check --task`, `--checker`, `--format`, `--invocation`, and `--limit` require --issues. `` | Snapshot query options were used on the rerun-check command                                                 | Add `--issues`, or remove those query options                                                                         |
| `` `limina check --issues` does not accept a pipeline name. ``                                        | `--issues` reads the latest snapshot and does not run a pipeline                                            | Use `limina check --issues`; do not add a pipeline name                                                               |
| `Invalid check --issues --limit ...`                                                                  | The limit is zero, negative, fractional, exponential notation, non-numeric, or above the safe integer range | Use a positive decimal integer or `all`                                                                               |
| `` `limina check --issues --limit` is only available with --format human. ``                          | A human card limit was combined with JSON or NDJSON                                                         | Remove `--limit`, or use human output                                                                                 |
| `Invalid graph export --view`                                                                         | `--view` is outside the supported range                                                                     | Use `all`, `source`, or `artifact`                                                                                    |
