# CLI Reference

This page lists every Limina command and its flags. Commands map to the built-in tasks and configuration described elsewhere in the docs; this page is the invocation surface, not the behavior reference.

```sh
limina [--config limina.config.mjs] [--mode mode] <command>
```

::: tip
For what each task detects, with examples, see [Built-in Tasks](./built-in-tasks.md). For the fields each command reads from `limina.config.mjs`, see the [Config Reference](./config/index.md).
:::

## Setup and Default Pipeline

| Command                   | Description                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `limina init [--yes]`     | Generate declaration leaves, build aggregators, root config, and a `limina:check` script for an uninitialized pnpm workspace. |
| `limina check`            | Run the default pipeline: graph, source, Nx project sync, proof, checker build, and checker typecheck.                        |
| `limina check <pipeline>` | Run a named user pipeline from `pipelines`.                                                                                   |

## Graph and Source

| Command                    | Description                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `limina graph check`       | Validate project references, workspace imports, graph rules, and source/artifact dependency semantics.  |
| `limina graph sync [path]` | Rewrite declaration-leaf references from TypeScript-resolved source imports.                            |
| `limina source check`      | Validate package ownership, relative import boundaries, bare dependency declarations, and `#imports`.   |
| `limina proof check`       | Validate declaration leaves, local companions, checker coverage, pure aggregators, and source coverage. |

## Nx Sync

| Command                       | Description                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limina nx sync [target...]`  | Sync `project.json` target `dependsOn` entries from `link:` artifact dependencies and imported `workspace:*` artifact exports. Defaults to `build`. |
| `limina nx check [target...]` | Fail when synced Nx target `dependsOn` entries are stale. Defaults to `build`.                                                                      |

## Checkers

| Command                    | Description                                                             |
| -------------------------- | ----------------------------------------------------------------------- |
| `limina checker build`     | Run build execution for checker entries that support it.                |
| `limina checker typecheck` | Run second-class checker entries such as `vue-tsgo` and `svelte-check`. |

## Package and Release

| Command                                         | Description                                                                       |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `limina package check`                          | Run configured package output checks.                                             |
| `limina package check --package <name>`         | Run one package entry by configured name.                                         |
| `limina package check --tool <tool>`            | Run only `publint`, `attw`, `boundary`, or `all`.                                 |
| `limina package check --attw-profile <profile>` | Override ATTW profile: `strict`, `node16`, or `esm-only`.                         |
| `limina release check`                          | Check release hygiene and dependency consistency for the cwd package entry.       |
| `limina release check --package <name>`         | Check release hygiene and dependency consistency for one or more package entries. |
