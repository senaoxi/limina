# CLI workflows

Use the installed binary's help for the exact version. The examples below use
`pnpm exec`; keep another project's package manager and local binary resolution.
Global config options are `--config <path>`, `--config-loader native|tsx`, and
`--mode <mode>`. The config file contains executable code.

## Select the narrowest command

| Goal                                        | Command                                    | Effects and limits                                                                      |
| ------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| Adopt Limina                                | `limina init [--yes]`                      | Writes config, ignore rules, manifest metadata, and clears root `.limina`               |
| Daily governance and type builds            | `limina check`                             | Runs the default plan; may materialize configs, declarations, caches, and issue records |
| Run an existing named pipeline              | `limina check <name>`                      | Runs its configured steps, including external commands                                  |
| Read stored findings                        | `limina check --issues --format json`      | Does not evaluate config or run checks                                                  |
| Validate project relations                  | `limina graph check`                       | Validates the in-memory model; not proof that files were materialized                   |
| Materialize the internal graph              | `limina graph prepare`                     | Writes managed `.limina` graph files                                                    |
| Export package dependency relations         | `limina graph export --view all`           | Views: `source`, `artifact`, `all`; `--output <path>` writes JSON                       |
| Validate source ownership and authorization | `limina source check`                      | Runs source checks, including applicable Knip policy                                    |
| Validate coverage and config alignment      | `limina proof check`                       | Checks source coverage and proof exceptions                                             |
| Build internal declarations                 | `limina checker build [config]`            | Generated graph targets, not the production bundle                                      |
| Run framework typechecks                    | `limina checker typecheck`                 | Astro/Svelte leaf targets; no watch or config argument                                  |
| Build managed user artifacts                | `limina build <config>`                    | Requires managed output declarations on applicable leaves                               |
| Run an explicit raw checker build           | `limina build <config> --raw --preset tsc` | Bypasses managed output config and runs the chosen checker                              |
| Check existing package outputs              | `limina package check --package <name>`    | Uses configured `package.entries`; does not build them                                  |
| Check release inputs                        | `limina release check --package <name>`    | May pack outputs and consult registry metadata; does not publish                        |
| Rewrite source configuration for adoption   | `limina-migrate`                           | Separate mutating CLI; inspect its help and migration scope first                       |

Validation-only commands can still publish diagnostic records on failure; do not
describe them as filesystem-pure. Read [package-checks.md](package-checks.md)
before interpreting skipped tools or release success.

## Initialization

Init uses the nearest manifest from cwd, or offers to create one at cwd only when
none exists. An invalid nearest manifest stops it. It creates no workspace
declaration; single-package projects are supported. It writes or preserves the
`limina:build` script with `limina checker build`, adds missing Limina/TypeScript
development dependency declarations, and leaves dependency installation to the
project workflow.

Interactive initialization offers optional skill installation.
`--yes` accepts initialization defaults but skips that installation. The separate
installation command is:

```sh
npx --yes skills add senaoxi/limina --skill limina
```

This retrieves the repository skill, not a skill bundled with a specific npm
release. Check the target Limina version before applying examples. Do not rerun
init as a generic repair: it removes that root's generated `.limina` directory.

## Check execution versus stored evidence

The default check includes `graph:check`, `source:check`, `proof:check`,
`checker:build`, and `checker:typecheck`. It does not automatically run package
checks, release checks, tests, or a production bundler. A named pipeline must
exist, be nonempty, and accepts no forwarded runtime arguments.

After a run, query details separately:

```sh
pnpm exec limina check --issues --format json
pnpm exec limina check --issues --task graph:check --format ndjson
pnpm exec limina check --issues --rule <reported-code> --verbose
pnpm exec limina check --issues --invocation <reported-uuid> --format json
```

Use a rule or invocation actually reported by the CLI. Filters include `--task`,
`--checker`, `--package`/`-p`, `--rule`, `--file`, and `--scope`. `--limit` accepts
a positive integer or `all` for human output only. `--format` accepts `human`,
`json`, or `ndjson` for issue queries; it is not a JSON execution mode.

The reader locates the config anchor and governance root without importing the
config. Latest-attempt state matters: pending, aborted, or unavailable inventory
is not a previous successful run. An explicit `--invocation` reads that standalone
failure, not the latest default check. An explicit `--config` query anchor can
refer to a file that no longer exists. Inspect inventory status as well as issue
counts; query exit success alone does not certify the current tree.

A failure before a tracked attempt starts, such as a config import error, can
leave an older completed inventory visible. Match the recorded command and time
to the run being diagnosed, and keep that run's exit code and stderr. Even a
completed inventory can describe a failed run: inspect `run.result` and tasks,
not just query exit status or the number of issues.

During ordinary execution, `--package` selects package-aware tasks; do not assume
it restricts all graph/checker work. Use a configured pipeline for execution
scope. `--force` requests cold analysis and is incompatible with `--issues`.

## Build targets

`checker build` without a config builds selected internal declaration entries.
Its `--preset` and `--watch` require a config argument. The build presets are
`tsc`, `tsgo`, and `vue-tsc`.

`build <config>` accepts a managed source leaf declaring `liminaOptions.outputs`,
or a supported solution reaching output leaves. `--raw` requires `--preset` and
executes against the user config instead. Check which output directory a command
owns before running it; internal declarations are not publishable package output.

`checker typecheck` accepts neither a config argument, `--preset`, nor `--watch`.
It reruns framework leaf checks and succeeds as disabled when no target applies.

## Source migration

Prefer the separately installed `limina-migrate` matching the intended release.
The deprecated `limina migration` entry forwards to a matching local tool or can
download that exact version. Do not use it as an implicitly offline command.

Migration normalizes source topology and output declarations and can rewrite
multiple tsconfig files. Inspect changes in an isolated copy when evaluating an
adoption. Do not invent `--dry-run` or assume the tool runs full governance.
Its fresh-process verification proves that its embedded implementation can read
persisted inputs, not that the project's installed Limina or native `tsc -b`
preserves all prior behavior. Run the target project's checks afterward.

A neutral config can be consumed without the core package, but a config importing
`limina` still needs that package resolvable. Framework peers and generated inputs
remain project prerequisites. The migration audit under `.limina/migration/` is
diagnostic evidence; do not edit it as a configuration source.
