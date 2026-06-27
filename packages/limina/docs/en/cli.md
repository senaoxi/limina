# CLI Reference

This page lists every Limina command and its flags. Commands map to the built-in tasks and configuration described elsewhere in the docs; this page is the invocation surface, not the behavior reference.

```sh
limina [--config limina.config.mjs] [--mode mode] <command>
```

::: tip
For what each task detects, with examples, see [Built-in Tasks](./built-in-tasks.md). For the fields each command reads from `limina.config.mjs`, see the [Config Reference](./config/index.md).
:::

## Setup and Default Check

| Command                   | Description                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `limina init [--yes]`     | Generate `limina.config.mjs`, ensure `.limina/` is ignored, and add a `limina:build` script for a pnpm workspace. |
| `limina check`            | Run the default check: schedule graph, source, proof, checker build, and checker typecheck.                       |
| `limina check --issues`   | Print filter values available from the last recorded check issues.                                                |
| `limina check <pipeline>` | Run a named ordered pipeline from `pipelines`.                                                                    |

`limina check --issues` reads the last recorded check result and lists filter
values by task, package, rule, scope, and checker. Combine it
with `--task <name>`, `--package <name>`, `--rule <code>`, `--file <path>`,
`--scope <path>`, or `--checker <name>` to narrow the inventory before
choosing a focused rerun.

Failed check tasks print a summary first, then grouped details. Groups share a
stable rule code such as `LIMINA_GRAPH_REFERENCE_MISSING` or
`LIMINA_PACKAGE_PUBLINT`, so the same code can be used with `--rule <code>` in
`limina check --issues`. Default output shows only the first few files or
targets in each group; pass `--verbose` to `limina check` or to a standalone
check command to show the full list.

## Graph and Source

| Command                | Description                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `limina graph prepare` | Generate `.limina/manifest.json` and checker-scoped declaration/build tsconfig graphs.                                       |
| `limina graph check`   | Prepare and validate generated project references, workspace imports, graph rules, and source/artifact dependency semantics. |
| `limina graph export`  | Export the neutral package dependency graph as JSON. Use `--view source\|artifact\|all` and optional `--output <file>`.      |
| `limina source check`  | Validate source ownership, relative import boundaries, bare dependency declarations, and `#imports`.                         |
| `limina proof check`   | Validate declaration leaves, local companions, checker coverage, pure aggregators, and source coverage.                      |

`limina graph check`, `limina source check`, and `limina proof check` accept
`--verbose` for full grouped issue details.

## Build

| Command                                    | Description                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `limina build <config>`                    | Build user-facing artifacts from Limina-managed output build configs.      |
| `limina build <config> --preset <p>`       | Select the output build preset when multiple build-capable checkers match. |
| `limina build <config> --watch`            | Watch input files and rebuild the managed output target.                   |
| `limina build <config> --raw --preset <p>` | Directly run `tsc`, `tsgo`, or `vue-tsc` against a user-authored tsconfig. |

Managed `limina build <config>` accepts only configs managed by Limina. The
target source leaf must declare `liminaOptions.outputs`; a solution config can
be used when at least one recursive referenced source leaf declares outputs.
Managed builds generate and run output configs under
`.limina/tsconfig/checkers/<checker>/outputs/`.

Raw mode bypasses Limina's generated graph and inferred references. It requires
`--preset`, supports only `tsc`, `tsgo`, and `vue-tsc`, and rejects generated
configs under `.limina`.

## Checkers

| Command                                      | Description                                                        |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `limina checker build`                       | Build all generated internal declaration entries that support it.  |
| `limina checker build <config>`              | Build the Limina-managed internal declaration target for a config. |
| `limina checker build <config> --preset <p>` | Select the internal declaration build preset.                      |
| `limina checker build <config> --watch`      | Watch input files and rebuild one internal declaration target.     |
| `limina checker typecheck`                   | Run typecheck-only entries such as `vue-tsgo` and `svelte-check`.  |

`limina checker build` and `limina checker typecheck` accept `--verbose` when
they report checker failures.

`limina checker build <config>` never raw-builds unmanaged configs and never
reads `liminaOptions.outputs`. User-facing artifact output belongs to
`limina build <config>`.

## Package and Release

| Command                                         | Description                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `limina package check`                          | Run configured package output checks.                                             |
| `limina package check --package <name>`         | Run one package entry by configured name.                                         |
| `limina package check --tool <tool>`            | Run only `publint`, `attw`, `boundary`, or `all`.                                 |
| `limina package check --attw-profile <profile>` | Override ATTW profile: `strict`, `node16`, or `esm-only`.                         |
| `limina release check`                          | Check release hygiene and dependency consistency for the cwd package entry.       |
| `limina release check --package <name>`         | Check release hygiene and dependency consistency for one or more package entries. |

`limina package check` and `limina release check` accept `--verbose` for full
grouped issue details.
