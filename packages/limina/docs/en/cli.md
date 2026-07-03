# CLI Reference

If you have already adopted Limina in a `TypeScript` monorepo, or you are preparing to bring `TypeScript` project references into your regular check flow, the core concern is not memorizing every command. It is understanding which commands generate the project graph, which commands check whether that graph agrees with source import relationships, and which commands only add checks for already-built artifacts.

Limina's `CLI` is centered on `TypeScript` project references. It generates a project graph under `.limina` from configuration and source, then checks file ownership, package dependencies, project references, checker entries, and source coverage based on that graph. Without automated checks, developers have to manually decide and maintain which source relationships should enter the `references` graph. Limina turns those decisions into repeatable commands and reports.

Limina does not replace `TypeScript`, `Vue`, `Svelte`, bundlers, test frameworks, package managers, or publishing tools. It calls or coordinates part of those tools' capabilities, and adds checks on top of `TypeScript` project references, the generated project graph, and built artifacts. Package checks and release checks are supplemental capabilities and should not be understood as release security guarantees.

## Quick Start

Limina must run inside a `pnpm` workspace. The current package configuration requires `Node.js ^22.18.0 || >=24.0.0`. For manual installation, use:

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

`limina init --yes` uses the default confirmation flow and is suitable for non-interactive environments. It writes or updates `limina.config.mjs`, the `limina:build` script in the root `package.json`, and required dependencies, and ensures `.gitignore` ignores `.limina/`. If dependencies already exist, `pnpm i` may not change anything; if initialization added dependencies, install them before running the build.

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

This is only a starting point. If the repository needs custom checker entries, graph rules, source exceptions, package artifact checks, or release consistency checks, continue configuring them in `limina.config.mjs`.

## Command Entry and Global Options

Basic form:

```sh
limina [--config <path>] [--mode <mode>] <command>
```

Global options apply to commands that need to load `limina.config.mjs`. `init` operates directly on the current `pnpm` workspace and does not depend on an existing config.

| Option            | Type   | Default behavior                                                                                               | Related configuration                   | Example                                     | Boundary                                                                                    |
| ----------------- | ------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `--config <path>` | path   | Searches upward from the current directory for the nearest `limina.config.mjs` until the `pnpm` workspace root | `limina.config.mjs`                     | `limina --config ./limina.config.mjs check` | The config file must be inside the current `pnpm` workspace                                 |
| `--mode <mode>`   | string | `process.env.NODE_ENV`, otherwise `default`                                                                    | `env.mode` passed to functional configs | `limina --mode ci check`                    | Only passes the mode to the config function; differences are implemented by the config file |

The config file can export an object, a `Promise`, or a function that receives `{ command, mode }`. `command` indicates the current command family, such as `check`, `graph`, `source`, `package`, or `release`.

## Recommended Workflow

Daily use usually starts with `limina check`. It runs the default check group: `graph:check`, `source:check`, `proof:check`, `checker:build`, and `checker:typecheck`. Together, these tasks check whether the generated graph, source boundaries, coverage relationships, and checker entries remain consistent.

When you change `tsconfig`, `references`, checker include ranges, or source structure that affects the generated graph, run:

```sh
pnpm exec limina graph prepare
pnpm exec limina check
```

When you only need to locate the reason for the previous failure, you do not need to rerun all checks. Read the latest check snapshot instead:

```sh
pnpm exec limina check --issues
pnpm exec limina check --issues --rule LIMINA_GRAPH_REFERENCE_MISSING --verbose
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

It searches upward from the current directory for `pnpm-workspace.yaml`, confirms the workspace root, checks workspace packages, and then performs the following actions: writes or updates `limina.config.mjs`; ensures `.gitignore` contains `.limina/`; creates or updates the `limina:build` script in the root `package.json`; adds development dependencies if `limina` or `typescript` is missing; removes the existing generated `.limina` directory at the root; and, in interactive mode, asks whether to install the Limina `agent skill`.

`--yes` accepts the default confirmation and skips the interactive `skill` installation prompt. In non-interactive environments, steps that require confirmation fail unless `--yes` is used.

`init` does not infer graph rules from business structure, and it does not decide which package boundaries should be allowed or denied. Maintain the initialized config according to the real repository structure.

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
| `--verbose`            | boolean                   | Output summary              | `limina check --verbose`                                      | Only affects report detail                                           |
| `--rule <code>`        | repeatable string         | Do not filter by rule       | `limina check --issues --rule LIMINA_GRAPH_REFERENCE_MISSING` | Requires `--issues` for issue queries                                |
| `--file <path>`        | repeatable path           | Do not filter by file       | `limina check --issues --file packages/a/src/index.ts`        | Matches exact file paths                                             |
| `--scope <glob>`       | repeatable `glob`         | Do not filter by path scope | `limina check --issues --scope 'packages/a/**'`               | Used for issue snapshot filtering                                    |
| `--task <name>`        | repeatable string         | Do not filter by task       | `limina check --issues --task source:check`                   | Must be used with `--issues`                                         |
| `--checker <name>`     | repeatable string         | Do not filter by checker    | `limina check --issues --checker vue`                         | Only filters issue snapshots here; it is not build checker selection |
| `--issues`             | boolean                   | Rerun checks                | `limina check --issues`                                       | Reads the latest check snapshot; cannot be used with a pipeline name |
| `--format <format>`    | `human`, `json`, `ndjson` | `human`                     | `limina check --issues --format json`                         | Must be used with `--issues`                                         |

`--issues` does not rerun checks. It reads the snapshot written by the previous check and is used to locate failed tasks, rules, packages, files, or checkers. Before using it the first time, run `limina check` and let the check reach a recordable state.

Helper queries:

```sh
pnpm exec limina check --issues --task --help
pnpm exec limina check --issues --package --help
pnpm exec limina check --issues --checker --help
pnpm exec limina check --issues --rule --help
```

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

`--watch` is allowed only with a config path. `--preset` also requires a config path. The old `--checker` form is no longer supported; use `--preset`. The old `--project` form is no longer supported; pass the config path as a positional argument.

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

| Symptom or error message                                                   | Likely cause                                                       | Action                                                                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `no pnpm-workspace.yaml was found`                                         | Current directory is not inside a `pnpm` workspace                 | Run the command inside a workspace, or create `pnpm-workspace.yaml` first                                             |
| `Unable to find limina config`                                             | `limina.config.mjs` was not found                                  | Run `limina init`, or pass a config path through `--config`                                                           |
| `config file must be inside the governed pnpm workspace`                   | `--config` points outside the workspace                            | Put the config file inside the current `pnpm` workspace                                                               |
| `checker build --preset requires a config argument`                        | `--preset` can only choose the build checker for a specific config | Use `limina checker build <config> --preset tsc`                                                                      |
| `checker build --watch requires a config argument`                         | Watch mode only supports a specified config                        | Use `limina checker build <config> --watch`                                                                           |
| `limina build --raw requires --preset`                                     | Raw mode did not specify a checker preset                          | Use `limina build <config> --raw --preset tsc`                                                                        |
| `Unknown option: --checker. Use --preset instead.`                         | Old option was used                                                | Use `--preset`                                                                                                        |
| `Unknown option: --project. Pass the config as a positional argument.`     | Old option was used                                                | Put the config path after `checker build`                                                                             |
| `checker typecheck does not accept --preset` or `--watch`                  | `checker typecheck` only runs non-build checker entries            | Use `checker build <config>` for a single config                                                                      |
| `No package checks are enabled`                                            | The selected package entries do not enable any package checks      | Check `package.entries[].checks`, or remove the unneeded package check task                                           |
| `outDir package.json not found`                                            | Package artifacts have not been built, or `outDir` is incorrect    | Run the project build first, then check `package.entries[].outDir`                                                    |
| `Missing peer dependency ...`                                              | A checker or package check tool is not installed                   | Install the reported peer dependency, such as `typescript`, `vue-tsc`, `knip`, `publint`, or `@arethetypeswrong/core` |
| `` `limina check --task`, `--checker`, and `--format` require --issues. `` | Snapshot query options were used on the rerun-check command        | Add `--issues`, or remove those filter options                                                                        |
| `` `limina check --issues` does not accept a pipeline name. ``             | `--issues` reads the latest snapshot and does not run a pipeline   | Use `limina check --issues`; do not add a pipeline name                                                               |
| `Invalid graph export --view`                                              | `--view` is outside the supported range                            | Use `all`, `source`, or `artifact`                                                                                    |
