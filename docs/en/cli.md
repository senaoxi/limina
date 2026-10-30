# CLI Reference

Run `limina check` for daily work. The default check includes real checker builds and writes generated configs, internal declarations, and caches under `.limina` when needed. Use standalone graph, source, or proof checks to investigate a specific problem.

See [Getting Started](./getting-started.md) for installation and initialization. Package and release checks consume already-built outputs; the project supplies its production build, tests, and publishing commands.

## Decision Table

| Goal                                                               | Recommended command                        | Basis for choosing it                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Initialize Limina files in the selected project                    | `limina init` or `limina init --yes`       | First adoption, or generating the base config and `limina:build` script                                                                   |
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
| Build user-consumable artifacts                                    | `limina build <config>`                    | Managed source leaves declaring `liminaOptions.outputs`, or aggregators recursively referencing at least one such leaf                    |
| Build a user-maintained `tsconfig` directly                        | `limina build <config> --raw --preset tsc` | Does not read Limina output config and does not use the generated graph                                                                   |
| Run framework-owned leaf targets                                   | `limina checker typecheck`                 | Runs Astro- and Svelte-owned type configs once per leaf; succeeds as disabled when no target exists                                       |
| Check built package artifacts                                      | `limina package check`                     | Requires `package.entries[].outDir`; checks package manifest, `publint`, `ATTW`, or artifact import boundaries                            |
| Check pre-release artifact consistency                             | `limina release check`                     | Requires built artifacts and checks local dependency declarations, private packages, `tarball` results, or configured release consistency |

## Command Entry and Global Options

Basic form:

```sh
limina [--config <path>] [--config-loader <loader>] [--mode <mode>] <command>
```

Global options apply to commands that need to load a Limina config file. `init` operates directly on the selected project and does not depend on an existing config.

| Option                     | Type             | Default behavior                                            | Related configuration                   | Example                                     | Boundary                                                                                                   |
| -------------------------- | ---------------- | ----------------------------------------------------------- | --------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--config <path>`          | path             | Searches cwd and ancestors for the default config filenames | Limina config module                    | `limina --config ./limina.config.mts check` | Its nearest `package.json` fixes the governance root; explicit query anchors may refer to a missing config |
| `--config-loader <loader>` | `native` / `tsx` | `native`                                                    | Config module loader                    | `limina --config-loader tsx check`          | `tsx` requires `tsx` to be installed in the consuming workspace                                            |
| `--mode <mode>`            | string           | `process.env.NODE_ENV`, otherwise `default`                 | `env.mode` passed to functional configs | `limina --mode ci check`                    | Only passes the mode to the config function; differences are implemented by the config file                |

The config file can export an object, a `Promise`, or a function that receives `{ command, mode }`. `command` indicates the current command family, such as `check`, `graph`, `source`, `package`, or `release`; the type remains open for other current command values such as `build` and `migration`.

## Command Reference

### limina check [pipeline]

`check` is the daily entry point. It checks structure and runs type checkers; `checker:build` writes internal declarations and does not produce the production bundle.

`limina check [pipeline] --force` skips existing persistent analysis results for this run, analyzes the project again, and saves an eligible new result. Use it after installation repairs or operations that may preserve or roll back file timestamps. Checker build caches such as `.tsbuildinfo` retain their own behavior. This option cannot be combined with `--issues`, which only queries an existing result.

Persistent analysis caching defaults to enabled. Set [`cache: false`](./config/config-file.md#cache) to prevent both restoration and publication, including with `--force`; this leaves existing snapshots, configuration drift protection, issue records and checker caches intact. `--force` can read old snapshot bytes for safe concurrent publication, but does not restore the old analysis model or delete this configuration's, other configurations' or other worktrees' snapshots.

The `ci` examples below require a configured `pipelines.ci`:

```sh
pnpm exec limina check
pnpm exec limina check ci
pnpm exec limina check --force
pnpm exec limina check ci --force
pnpm exec limina check --package @scope/pkg
```

The default `limina check` schedules five tasks: `graph:check`, `source:check`, `proof:check`, `checker:build`, and `checker:typecheck`. `scope` selects inputs and Checkers; top-level `graph`, `source`, and `proof` configure rules, exceptions, and optional capabilities. Omitting a domain does not disable its task. `package.entries` and `release` do not add default tasks.

Set `source.knip: true` to add Knip analysis. `false` retains source ownership, tsconfig governance, import boundaries, and package dependency authorization.

Every default governance task appears in the current plan. Failed required preparation marks dependent tasks as `blocked`; a planned framework check without targets remains `disabled`. Named pipelines record only their declared tasks and required preparation. `check --issues` reads the saved invocation without rerunning checks; a configuration error before a new attempt leaves the previous record historical. Standalone `graph check`, `source check`, and `proof check` also run without their top-level domain.

Tasks in the default group are scheduled independently according to available resources. Named pipelines come from configured `pipelines` and run through `limina check <name>`, with steps executed in configured order. Pipeline steps may be built-in tasks or external commands. External commands support object-form configuration with `command`, `args`, `cwd`, and `env`.

`limina graph check` dispatches a built-in command; `limina check graph` selects only `pipelines.graph`. A named workflow accepts the declared Limina options below, but rejects extra positional arguments, unknown options, and `--` passthrough. All options belong to Limina; downstream command inputs are defined in [pipeline configuration](./config/pipelines.md).

Common options:

| Option                 | Type                      | Default behavior            | Example                                                       | Boundary                                                             |
| ---------------------- | ------------------------- | --------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `-p, --package <name>` | repeatable string         | Do not restrict packages    | `limina check -p @scope/pkg`                                  | Package output selection and source-report filtering; see below      |
| `--verbose`            | boolean                   | Output compact summaries    | `limina check --verbose`                                      | Expands a live run summary; with `--issues`, renders detailed cards  |
| `--rule <code>`        | repeatable string         | Do not filter by rule       | `limina check --issues --rule LIMINA_GRAPH_REFERENCE_MISSING` | Requires `--issues` for issue queries                                |
| `--file <path>`        | repeatable path           | Do not filter by file       | `limina check --issues --file packages/a/src/index.ts`        | Matches exact file paths                                             |
| `--scope <glob>`       | repeatable path or `glob` | Do not filter by path scope | `limina check --issues --scope 'packages/a/**'`               | Matches path-bearing issue candidates only                           |
| `--task <name>`        | repeatable string         | Do not filter by task       | `limina check --issues --task source:check`                   | Must be used with `--issues`                                         |
| `--checker <name>`     | repeatable string         | Do not filter by checker    | `limina check --issues --checker vue-tsc`                     | Only filters issue snapshots here; it is not build checker selection |
| `--issues`             | boolean                   | Run configured checks       | `limina check --issues`                                       | Queries saved issues; cannot be used with a pipeline name            |
| `--limit <limit>`      | positive integer or `all` | 20 visible issue cards      | `limina check --issues --limit 50`                            | Human issue inventories only; must be used with `--issues`           |
| `--invocation <uuid>`  | UUID                      | Read the last check         | `limina check --issues --invocation <uuid>`                   | Reads one immutable standalone failure record                        |
| `--format <format>`    | `human`, `json`, `ndjson` | `human`                     | `limina check --issues --format json`                         | Must be used with `--issues`                                         |

Runtime `--package` selects output entries for `package:check` and `release:check` and filters the issue report from `source:check`. It does not restrict graph checks, proof checks, or checker builds to one package. With `--issues`, `--package` only filters saved issues. `--task` also only applies to issue queries; it cannot select tasks for the current run.

Inspect [task and analyzer states](./built-in-tasks.md#task-status) after a command completes. For example, `checker:typecheck` is `disabled` when there are no framework targets. Missing optional package analyzers may be `skipped` while the process exits successfully. Neither means that check actually passed.

#### Query Saved Issues

```sh
pnpm exec limina check --issues
pnpm exec limina check --issues --task workspace:validate
pnpm exec limina check --issues --verbose --limit all
pnpm exec limina check --issues --format json
```

`--issues` does not rerun checks. Without `--invocation`, it authenticates the issue inventory against the latest published `limina check` attempt. A previous completed `last-run.json` may remain on disk while a newer attempt is running or interrupted, but the query refuses to return it as current. Standalone commands use separate invocation records. Workspace validation failures are recordable too: the trusted `.limina` snapshot namespace is created before validation, so a structural failure can appear under task `workspace:validate`. Let `limina check` finish once before using its issue inventory.

A query can exit successfully even when the saved check failed and contains issues, or when it reports that no snapshot exists. Its exit status describes the query, not the result of the recorded check. In CI, run `limina check` and review its task statuses to determine the check result.

If the current error occurred during config discovery, loading, or execution-plan setup, the attempt may not have been registered yet and the query may still return the previous completed record. Compare its timestamp with the current terminal error. An unavailable current result does not mean zero issues.

::: details Latest Attempts, Snapshot Versions, and Recovery

The unqualified query checks freshness. Once an attempt has been published, `--issues` returns its inventory only when the same attempt completed and its metadata matches the current-format snapshot. A running, interrupted, aborted, or persistence-failed latest attempt, or corrupt or mismatched freshness metadata, makes the query exit with code `1`; it never falls back to older completed issues. Missing required metadata also causes failure. When both freshness metadata records are absent, the reader attempts compatible reading. Human, JSON, and NDJSON output report unavailable explicitly; a machine response with unavailable `status` and zero issues is not a successful zero-issue check.

Configuration discovery, validation, and execution-plan failures that happen before an attempt is published do not replace the previous completed inventory. If a process stops between the `last-run.json` and freshness-index writes, a later successful check with a higher sequence rewrites both files and restores query availability automatically.

:::

Issue output is progressive:

| View     | Trigger                                                                                              | Output                                                                                                                               | Visible issue limit |
| -------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Summary  | `limina check --issues` with no filter, invocation, or explicit limit                                | Full filtered-set counts, primary blockers, and next commands; no issue cards                                                        | No cards            |
| Compact  | Add any task, rule, package, file, scope, or checker filter; select an invocation; or pass `--limit` | One bounded card per selected issue with one location, rule, optional owner/tool metadata, and one-line summary/reason/fix fields    | 20 by default       |
| Detailed | Add `--verbose` to an issue query                                                                    | Selected issue cards with available locations, evidence, diagnostics, fix steps, verification commands, and deduplicated raw details | 20 by default       |
| Machine  | Use `--format json` or `--format ndjson`                                                             | The complete filtered issue set in the existing machine-readable contract                                                            | Never truncated     |

Human summary counts and primary blockers always use the complete filtered set. Compact and detailed cards are sampled deterministically: Limina gives unrelated root causes visibility before taking another sample from the same root cause, then rotates across packages within that root cause. The report states `Showing X of Y issues`. Use `--limit <positive integer>` for an exact card budget or `--limit all` for every matching card. A zero-match query keeps its summary, filter diagnostics, and help commands without printing an empty card section.

`--limit` is valid only with `check --issues` in human format. JSON and NDJSON reject it and continue to return every filtered issue; `--verbose` has no effect on machine output. `limina check --verbose` has a different scope from `limina check --issues --verbose`: the former expands aggregate run rows, durations, ranked rules, blockers, and package counts, but never prints raw issue diagnostics; the latter selects the detailed issue-card view.

After configuration has loaded and a standalone session has been registered, an issue-producing failure prints an invocation ID and a shell-specific query if the failure record can be published. Failures before session setup, or failed persistence, do not guarantee such a record. Each query uses the current absolute Node executable and installed Limina `bin/limina.js`, carries the absolute config path, effective loader and mode, and selects `check --issues --invocation <uuid>`. The Windows command also changes to the governance root using PowerShell `Set-Location -LiteralPath`. Queries can be replayed from another directory without requiring a project manager. Invocation records live under that root's `.limina/check/invocations/`.

An explicit query `--config` is a lexical location anchor: the module can have been deleted or renamed. Its nearest manifest must still exist and be a valid object. Queries never import configuration, resolve manager adapters, rebuild packages, or run preflight. Without `--config`, current default config discovery is required. Missing persisted records never fall back to an ancestor workspace.

On POSIX systems the command is labeled `Query:`. On Windows, Limina prints a `PowerShell:` command for Windows PowerShell 5.1 or PowerShell 7; run it in PowerShell, including when Limina was launched from CMD. Limina does not print a CMD variant. You can append query options such as `--format json` or `--file src/index.ts` to the printed command.

An invocation is a selector, not an issue filter, so it promotes the default human view to compact. Its human header shows the invocation ID, kind, result, and completion time. Generated refine, detailed, complete, JSON, and filter-help commands retain the same invocation ID, active filters, and explicit global config context. The recorded original command remains metadata and is not reused to construct a new query.

`--file` performs exact matching, while `--scope` accepts a directory or `glob`. Both accept workspace-relative paths, `./` paths, absolute paths, and either slash style. They match only path-bearing candidates such as issue files and package manifests; diagnostic labels such as config field scopes are not treated as paths. Repeated values within one filter use OR semantics.

If a saved check record uses an incompatible format, the query reports it as unavailable. A successfully completed check writes a record in the current format.

Helper queries:

```sh
pnpm exec limina check --issues --task --help
pnpm exec limina check --issues --package --help
pnpm exec limina check --issues --checker --help
pnpm exec limina check --issues --rule --help
```

Task help can list supported task names even before the first check. A count of zero in that list does not mean the task ran. When the selected record is readable, the list also includes tasks from that record and their issue counts. Package and checker help use values from the selected record; rule help lists the supported rules. If the latest attempt's metadata is unavailable, task, package, and checker help do not present values from an older record.

### limina graph \<action\>

The `graph` command generates, checks, and exports the project graph.

```sh
pnpm exec limina graph prepare
pnpm exec limina graph check
pnpm exec limina graph export
pnpm exec limina graph export --view source --output graph.json
```

`graph prepare` validates inputs and generates the project graph and checker entries under `.limina`. It does not run the full `graph check` or invoke the compiler. Managed builds and typechecks automatically materialize the files they need; run it separately to inspect or refresh files on disk. `graph check`, `source check`, and `proof check` calculate the graph in memory without materializing checker configs.

`graph check` checks whether the generated graph is consistent with source import relationships. It covers project references, source graph routing, reference completeness, graph rules, workspace package dependency declarations, and some resolution boundaries. Typical issues include missing project references for source imports, extra project references, missing dependency declarations for cross-package project references, graph-rule denials, and workspace imports that cannot resolve or whose targets are not in the generated graph.

`graph export` outputs a package-level dependency graph as `JSON`. `--view` can be `all`, `source`, or `artifact`; the default is `all`. Without `--output`, it writes to stdout. With `--output <path>`, it writes to a file, resolving a relative path from the current working directory. It creates missing parent directories and overwrites an existing file at that path.

The exported graph is available for external analysis. It records package-level dependency facts and does not define task order; in particular, artifact edges do not establish a production build plan.

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

`source check` reports filterable issues about file ownership, package boundaries, and dependency declarations. Run `ESLint`, tests, and runtime checks separately.

### limina proof check

`proof check` checks source coverage relationships.

```sh
pnpm exec limina proof check
pnpm exec limina proof check --verbose
```

Based on the generated graph, checker entries, project routes, source boundaries, and `proof.allowlist`, it checks whether source files are covered by the generated graph or checkers, and reports issues related to checker coverage targets, default `tsconfig` files, declaration configs, local paired configs, or allowlist entries. It also validates unique config ownership, solution consistency, framework leaf executability, target coverage, declaration-provider projections, and typed dependency-edge integrity.

Coverage findings concern Limina's managed source set and its graph or checker entries. They are not a proof of complete type safety.

### limina build \<config\>

`build` builds user-consumable artifacts. Managed mode only accepts Limina-managed configs: source leaves must declare `liminaOptions.outputs`; under an aggregator config, at least one recursively referenced source leaf must declare `liminaOptions.outputs`.

```sh
pnpm exec limina build packages/app/tsconfig.json
pnpm exec limina build packages/app/tsconfig.json --preset tsc
pnpm exec limina build packages/app/tsconfig.json --watch
pnpm exec limina build packages/app/tsconfig.raw.json --raw --preset vue-tsc
```

Managed mode generates and runs output build configs under `.limina/tsconfig/checkers/<checker>/outputs/`. A selected target can also add build-capable output providers reachable through the generated dependency edges, including providers owned by another checker. This closure depends on available output-build mappings; it does not build every workspace dependency. When multiple build-capable checkers match the selected target, pass `--preset`. `--watch` uses the selected checker adapter's watch support and fails explicitly when unsupported.

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

`checker typecheck` does not accept a config path, `--preset`, or `--watch`. Framework targets do not support watch; rerun after source config, resolver packages, generated framework types, or framework source changes. Workspace validation and generated-artifact materialization, including the revision read lease, still run before the runner returns a disabled no-target result. If no framework-owned leaf exists, the runner records the task as disabled and exits successfully without checker peer preflight or checker execution.

### limina package check

`package check` inspects already-built package output.

```sh
pnpm exec limina package check
pnpm exec limina package check --package @scope/pkg
pnpm exec limina package check --package @scope/pkg --tool publint
pnpm exec limina package check --tool attw --attw-profile strict
```

It reads `package.entries` from configuration, enters each entry's `outDir`, and reads `package.json` from the built artifacts. If `publint` or `attw` is enabled, it first packs the output directory as a temporary `tarball` before passing it to the corresponding tool. If `boundary` is enabled, it scans `JavaScript` files in the output directory and checks whether external package imports, self-reference imports, and `Node` builtin usage comply with the artifact package manifest and configuration.

`--tool` accepts `all`, `publint`, `attw`, or `boundary` and filters the tools enabled by each entry's configuration; it cannot re-enable a disabled tool. If no selected entry has enabled checks after filtering, the command fails. `--attw-profile` accepts `strict`, `node16`, or `esm-only` and overrides the configured profile for the invocation; the default is `esm-only`.

`package check` does not run builds, publish packages, or guarantee artifacts work in every consumer environment. It only reports provable issues based on configuration and already-built artifacts.

### limina release check

`release check` checks package artifact consistency before release.

```sh
pnpm exec limina release check
pnpm exec limina release check --package @scope/pkg
pnpm exec limina release check --package @scope/pkg --verbose
```

It also selects artifact directories based on `package.entries`, and requires the checked package to match the current working directory or the `--package` selection. The command reads `package.json` from the output directory and checks local dependency declarations that should not appear in published artifacts, such as `workspace:`, `link:`, `file:`, or `catalog:`. If the output manifest is marked `private: true`, it is also reported as a pre-release issue. Then it packs the artifacts and runs release consistency checks, including `tarball`, package manifest, registry baseline, or content-hash-related checks depending on configuration and current artifact state. When `release.npmPackageJsonLint` is enabled, it also uses the separately installed `npm-package-json-lint` package to check the packed manifest.

`release check` does not run `npm publish`, and it does not replace package-manager or registry-side validation. It is suitable as a local consistency check before a publish command.

Package and release tarball checks use `pnpm pack --ignore-scripts` on the configured output directory. This requires pnpm regardless of the project's declared manager or single-package/workspace classification. The results describe that pnpm-packed output; other managers may produce different artifacts. Name, version, output-file, and optional-tool requirements apply to the artifact and checks selected.

### limina init

`init` generates the base adoption files for Limina in the selected project. It can modify the config, `.gitignore`, manifest, and dependencies, and removes the root `.limina/`, including saved check and migration records. `--yes` accepts overwrite confirmations. Save anything you need before running it.

```sh
pnpm exec limina init
pnpm exec limina init --yes
```

It finds the nearest `package.json` from cwd, validates it, and places `limina.config.mts` beside it. Only when no manifest exists does it offer to create one at cwd. Invalid nearest manifests stop initialization. It adds no workspace declaration and `--yes` works without manager metadata. Init checks the selected root's packages, writes or updates the config and `.gitignore`, adds the `limina:build` script and missing Limina/TypeScript development dependencies, removes the root's existing generated `.limina` directory, and can install the optional agent skill interactively.

`--yes` accepts the default confirmation and skips the interactive `skill` installation prompt. In non-interactive environments, steps that require confirmation fail unless `--yes` is used.

Configure graph rules and permitted package boundaries for your repository after initialization; `init` does not infer them from business structure.

To install the optional agent skill offered by initialization separately, use the same command:

```sh
npx --yes skills add senaoxi/limina --skill limina
```

This installs the skill without rewriting source `tsconfig` files. For existing source project references, use the next section to decide whether migration is needed.

### limina-migrate {#limina-migration}

`limina-migrate` helps organize existing TypeScript configs so Limina can read and manage their source relationships. It is a separate CLI package with no runtime dependency on the main package. For the development version described here, use the migration tool built from the same source as `limina`; see [Getting Started](./getting-started.md#migrate-existing-project-references-first) for installation. For a published release, use that release's documentation. The tool accepts `--config`, `--config-loader`, `--mode`, `--yes` and `--dry-run`; configuration functions receive `command: 'migration'`.

A neutral config such as `export default {}` can be migrated with only this tool and its required TypeScript peer. If the config imports public `limina`, install Limina where that config resolves dependencies; the tool does not supply or rewrite those imports. Optional loaders/checkers still require their supported peers. The CLI reports the embedded version and observes project package versions from config/governance-root anchors. Different or unavailable project versions are non-blocking metadata notices, not target-runtime verification. Tool build/self version mismatches fail before writes. Persisted `$schema` paths continue to refer to `node_modules/limina/schemas/tsconfig-schema.json`; editor resolution may be unavailable until the main package is installed.

`limina-migrate` normalizes existing TypeScript configuration into input that Limina can discover and read again from disk. First preview the scope and write plan in the target project:

```sh
pnpm exec limina-migrate --dry-run --yes
```

Review the plan, then run `pnpm exec limina-migrate` when ready. The preview does not write project files through the migration tool, but it still executes the config module.

The command reports processing completion separately from input consumption. Architecture rules, package dependencies, checker ownership and type errors still belong to `limina check`. Migration does not promise equivalent native `tsc -b` behavior.

#### Scope and write-plan preview

Discovery has fixed priority: explicit `--config` resolved against the original cwd; default-named Limina configs searched from cwd through every ancestor using the existing same-directory filename order; and, only when no config exists, the nearest `package.json` from cwd. Selecting a config uses its nearest manifest and the normal single-package/workspace classifier. It does not chase a higher workspace when using defaults. Missing manifests and invalid/unreadable nearest manifests stop execution; explicit config errors never fall back.

Flow shows the original cwd, final rootDir, root kind, manifest, config path (or `none (using defaults)`) and input source before loading executable configuration. `Continue with this migration scope?` defaults to Yes. No or cancellation stops before evaluation, planning and migration writes. Non-TTY execution requires `--yes`, including previews. `--yes` accepts this scope only; it does not approve dirty-worktree or hardlink writes. A change to config selection or root binding while waiting stops execution rather than silently choosing another input.

```sh
pnpm exec limina-migrate --dry-run --yes
```

After planning, the complete **Write Plan Summary (planned)** lists actual frozen create/update patches with stable paths, schema, native reference deletion/conversion, implicitRefs additions/reuse, outputs and exact isolation exclusions. It lists unchanged/blocked targets and preserved isolated configs separately. Checker entries and discovered candidates are not the write set: `scope.checkers.auto.exclude` does not exclude activated sources from migration. Outside-scope reference removal is identified separately. The auxiliary audit location is distinct from business patches. Write checks and specialized decisions can shrink the displayed plan; the Applied summary reports actual modifications.

Without a config, migration constructs validated defaults in memory. It does not run init, add dependencies/scripts or create an empty config. If safe isolation requires persisted `scope.regions.exclude`, the plan creates `${rootDir}/limina.config.mjs` containing only those static fields, without importing `limina`. The bad tsconfig stays unchanged. Creation cannot replace an existing entry; a competing writer, failed create or skipped consistency group prevents successful adoption. The configuration and rewrites that depend on it share the existing consistency group. Rollback preserves a created target if its identity or content has drifted.

`--dry-run` ends after showing this same frozen plan. It performs no migration-controlled project writes, transaction directories/backups, graph outputs, cache publication, audit success/failure publication or post-write disk verification. It needs no clean Git worktree or Git membership and requests no dirty-worktree/hardlink authorization. A complete readable plan with governed sources returns zero; planning failure, unavailable necessary patches, residual structural incompleteness or no governed sources returns nonzero with available diagnostics. Incomplete dependency comparison alone retains conservative reference preservation. Preview output cannot establish Applied success or disk consumption.

User configuration and existing third-party entrypoints remain executable code; dry-run is not a JavaScript side-effect sandbox. Each later CLI invocation independently replans; a preview grants no future write authorization.

#### Configuration and relationships

Only default `tsconfig.json` files can be checker entries. Named source configs enter checker ownership through solution references. Independent readable source candidates are also normalized without creating checker entries. Migration removes ordinary source `references`, prunes invalid or outside-region solution members, and preserves the remaining source membership. An outside-region reference is recorded without reading or migrating its target.

A pure named solution wrapper can be expanded into every parent when its rewritten references contain only `path` and it has no substantive Limina declarations. Paths are rebased for each parent; the wrapper file remains. Attributed references require manual conversion. Named-wrapper back edges are cut during expansion. Default solution cycles are pruned with compensating source memberships; both rewrites preserve each retained solution's reachable sources. Empty solutions retain their solution role and an explicit `references: []`.

Limina compares native in-region source relations with independently inferred source relations. Inferred relations do not need duplicate `implicitRefs`. Source declarations to solutions expand to their retained source members, with the original target and expansion recorded. Checker mapping and declaration-project legality are left to core analysis. Remaining native declarations become explicit implicit references; existing user reasons are preserved. An incomplete or failed semantic analysis is reported as unavailable comparison, never as an empty inferred graph. Missing or not-yet-generated source files do not make their readable configuration an isolation target.

Unreadable configs, including empty or malformed JSONC inputs, are preserved on disk. Where safe, migration writes exact `scope.regions.exclude` entries of kind `tsconfig` and removes incoming memberships or implicit references. This keeps the package activated. `extends` paths are not removed. A single implicit-reference object can be wrapped in an array; a missing or blank reason receives a factual migration explanation. Illegal shapes that cannot be normalized are isolated or reported as incomplete.

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

For Applied verification, separate fresh workers use the confirmed real config, rebuild defaults from the locked manifest/workspace when no config was created, or load the actually created minimal config. Defaults results identify input validation under a default context; ordinary `limina check` still requires a config. The workers use the normal `check` and `graph` input readers embedded from the same-release Limina source. Success means that embedded implementation consumed the disk inputs; it does not mean full typechecking, graph governance or the project’s installed Limina runtime ran. Only successful rereading, completed necessary writes, preserved source membership and a nonempty governed source set permit a successful adoption result. Necessary write failures, residual structural errors or unavailable verification return nonzero. Rejecting optional outputs alone does not require failure.

The terminal summary includes isolation, outside-reference removal, comparison completeness, diagnostic and failed/skipped-group counts, and the audit path. Planning phases and output-candidate counts expose progress. The audit report is `.limina/migration/latest.json`. It records targets, isolation, pruned relations, comparison completeness, output decisions, writes and final verification, phase timings and fatal attempts when the report location remains writable. Report publication failure warns without undoing committed configs. Neither core nor later migration runs use this report as input authority.

Migration does not install framework dependencies, run `astro sync`, or rewrite framework sources. Generated graphs use manifest version 6; no migration readiness or partial-graph state is persisted there.

## Troubleshooting

Start with [Troubleshooting](./troubleshooting.md#identify-the-failing-task) if you are unsure where to look. The first column below preserves actual English diagnostic fragments so you can search for the reported message.

| Symptom or error message                                                                | Likely cause                                                                                                | Action                                                                                                                        |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `No package.json found`                                                                 | No manifest exists above the selected configuration                                                         | Add a package manifest or select the intended config                                                                          |
| `Unable to find limina config`                                                          | No supported Limina config file was found                                                                   | Run `limina init`, or pass a config path through `--config`                                                                   |
| `Invalid package.json object` / `Unable to read root package.json`                      | The nearest manifest is invalid                                                                             | Fix that file; an ancestor manifest cannot replace it                                                                         |
| `checker build --preset requires a config argument`                                     | `--preset` can only choose the build checker for a specific config                                          | Use `limina checker build <config> --preset tsc`                                                                              |
| `checker build --watch requires a config argument`                                      | Watch mode only supports a specified config                                                                 | Use `limina checker build <config> --watch`                                                                                   |
| `limina build --raw requires --preset`                                                  | Raw mode did not specify a checker preset                                                                   | Use `limina build <config> --raw --preset tsc`                                                                                |
| `checker typecheck does not accept --preset` or `--watch`                               | Typecheck runs the complete framework leaf target set; per-target framework watch is unsupported            | Rerun `checker typecheck` after source config, parser package, generated type, or framework source changes                    |
| `No package checks are enabled`                                                         | The selected package entries do not enable any package checks                                               | Check `package.entries[].checks`, or remove the unneeded package check task                                                   |
| `outDir package.json not found`                                                         | Package artifacts have not been built, or `outDir` is incorrect                                             | Run the project build first, then check `package.entries[].outDir`                                                            |
| `Missing Limina runtime dependency`                                                     | A Limina-owned runtime is unavailable or outside its supported range                                        | Install or adjust it in the workspace running Limina                                                                          |
| `Missing external checker`                                                              | A configured external checker is unavailable in its execution scope                                         | Install the checker in the reported checker scope                                                                             |
| `Unsupported external checker`                                                          | The selected external checker version is outside Limina's supported range                                   | Upgrade or downgrade the checker in the reported checker scope                                                                |
| `Missing Astro semantic toolchain dependency`                                           | An eligible Astro source import cannot resolve a dependency declared by its owner scope                     | Install or reinstall the supported Astro/check toolchain in the owning leaf; do not rely on an undeclared workspace-root copy |
| `Unsupported Astro semantic toolchain`                                                  | The owner-scoped Astro/check tuple or internal API shape is outside the supported adapter                   | Align the owning leaf with the documented tuple; physical pnpm store or hoist paths do not need to match                      |
| `Unsupported vue-tsc toolchain`                                                         | The `vue-tsc` installation has an incomplete or incompatible internal tuple                                 | Upgrade, downgrade, or reinstall `vue-tsc`; do not install its internal packages for Limina                                   |
| `Missing framework checker dependencies`                                                | A leaf framework target is missing its command or execution runtime                                         | Install the reported Astro or Svelte dependencies in the owning leaf                                                          |
| `Astro generated types are missing`                                                     | The leaf package has not produced `.astro/types.d.ts`                                                       | Run `pnpm --dir <leaf> exec astro sync`; Limina never runs this command automatically                                         |
| `publint is not installed; skipping check` or `attw is not installed; skipping check`   | Enabled optional package analyzer is missing                                                                | Install the analyzer when CI requires that coverage; a skipped package analyzer alone does not make the command exit non-zero |
| `Missing Limina runtime dependency:` (`package: knip`)                                  | The explicit Knip source-usage feature has no Limina runtime dependency                                     | Install `knip` in the workspace running Limina, or set `source.knip` to `false`/omit it to disable the feature                |
| `limina check --task, --checker, --format, --invocation, and --limit require --issues.` | Snapshot query options were used on the rerun-check command                                                 | Add `--issues`, or remove those query options                                                                                 |
| `limina check --issues does not accept a pipeline name.`                                | `--issues` reads the latest snapshot and does not run a pipeline                                            | Use `limina check --issues`; do not add a pipeline name                                                                       |
| `Invalid check --issues --limit ...`                                                    | The limit is zero, negative, fractional, exponential notation, non-numeric, or above the safe integer range | Use a positive decimal integer or `all`                                                                                       |
| `limina check --issues --limit is only available with --format human.`                  | A human card limit was combined with JSON or NDJSON                                                         | Remove `--limit`, or use human output                                                                                         |
| `Invalid graph export --view`                                                           | `--view` is outside the supported range                                                                     | Use `all`, `source`, or `artifact`                                                                                            |
