# Workflows

This page covers daily checks, focused feedback, and pre-publish checks after adoption. See [Getting Started](./getting-started.md) for initialization and [CLI Reference](./cli.md) for all options.

## Recommended Workflows

### Local Development

For a complete default check, run:

```sh
pnpm exec limina check
```

It combines graph, source, and coverage checks with type-checker execution. To shorten feedback for a particular kind of change, use the corresponding standalone command:

| Current task                                    | Command                              |
| ----------------------------------------------- | ------------------------------------ |
| Check declaration references and graph rules    | `pnpm exec limina graph check`       |
| Check source ownership and import authorization | `pnpm exec limina source check`      |
| Check source coverage                           | `pnpm exec limina proof check`       |
| Run the internal declaration build              | `pnpm exec limina checker build`     |
| Run Astro / Svelte type checks                  | `pnpm exec limina checker typecheck` |

Each focused command covers only its own relationships. After changing TypeScript configs, package boundaries, or checking rules, run the complete default check again to cover other affected relationships.

To inspect artifact consumption, export the dependency graph:

```sh
pnpm exec limina graph export --view artifact --output .limina/dependency-graph.json
```

Artifact edges come from actual imports and configured, validated output directories. A directory named `dist` alone is not evidence of an artifact. The export supports consumption review; it is not a task execution plan. See [Dependency Graph Export](./concepts.md#dependency-graph-export).

### Pull Requests

```sh
pnpm exec limina check
```

Inspect task results and coverage in the report. `disabled`, `blocked`, and `skipped` do not mean the corresponding check passed. A missing optional analyzer can also cause a check to be skipped while the process exits successfully. Run business tests and project builds according to the repository's own requirements.

Package and release checks are outside the default pipeline and need standalone commands or a custom pipeline. See [Troubleshooting](./troubleshooting.md#identify-the-failing-task) to locate failures.

### Pre-publish

Configure [package output entries](./config/package-checks.md) first, and generate the outputs consumers will actually install. Here, `pnpm build` is the project's own production build script; replace `<name>` with the entry name:

```sh
pnpm build
pnpm exec limina package check --package <name>
pnpm exec limina release check --package <name>
```

Package and release checks do not build or publish on your behalf. Output directories need a readable `package.json` and the corresponding files; packing checks also require pnpm. Check that enabled analyzers actually ran, and retain real consumer tests.

If these steps are configured in `pipelines.publish`, run:

```sh
pnpm exec limina check publish
```

`publish` is a custom pipeline name, not a built-in pipeline. It runs the commands you configure. See [Pipelines](./config/pipelines.md) for examples and failure behavior.

## Migrate Existing Configs

Configuration migration uses the separate `limina-migrate` package at the same version as `limina`. After installing the matching version, run:

```sh
pnpm exec limina-migrate
pnpm exec limina check
```

After migration, inspect `.limina/migration/latest.json` before continuing with fixes from the check report. Migration reads the written input configs in a fresh process, but it does not run full governance or checkers and does not promise equivalence to native `tsc -b`.

When dependency comparison is incomplete, migration preserves explicit relationships within scope that still need protection; an unobserved relationship is not treated as absent. See [Migration](./cli.md#limina-migration) for write scope, recovery, and dynamic-config restrictions.

## CI Example

This example runs the default check. It assumes the repository pins pnpm and has committed its lockfile and Limina config. Complete prerequisites such as framework-generated types before checking, as required by the project.

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22.18.0
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec limina check
```

## Best Practices

- Users maintain source scopes, package manifests, public entries, and boundary rules. Limina maintains generated configs.
- Use a `tsconfig.json` with an empty file set to aggregate multiple source configs. Do not handwrite native build `references` in source configs; use `implicitRefs` for real declaration relationships that static analysis cannot observe.
- Build production artifacts before package and release checks. Internal declaration builds cannot replace that step.
- Keep specific reasons for allowlist and ignore entries. Changing an exception changes the accepted scope and should be reviewed separately from fixing an ordinary violation.

## FAQ

### How does Limina recognize a solution config?

The checker's effective file set is empty, the config directly declares `references`, and its filename is exactly `tsconfig.json`. `files: []` is the most direct expression; inherited options and framework files still affect the final file set. See [Aggregator Config](./concepts.md#aggregator-config).

### How do `limina checker build` and `checker typecheck` choose targets?

The former runs declaration builds with `tsc`, `tsgo`, and `vue-tsc`; the latter runs Astro and Svelte type checking per source config. Entry selection and dependency relationships jointly determine targets. See [Checker Configuration](./config/checkers.md) for details.

### Why do package checks require a build first?

They inspect the selected entry's `outDir` and need the manifest and files that consumers will install. They do not fill in missing outputs from source. See [Package Checks](./config/package-checks.md) for tools and skipped statuses.

### Can workspace exports point to dist?

Yes. Consuming existing declarations does not infer references back to source projects or automatically refresh the declarations. The consumer's build workflow must still prepare artifacts. See [Source Edges, Declaration Edges, and Artifact Edges](./concepts.md#source-edges-declaration-edges-and-artifact-edges).

### Should `Vue` or `Svelte` files be placed in the TypeScript graph?

Assign the corresponding source configs to a checker that supports the framework. Astro and Svelte type checks do not generate declarations; TypeScript source that needs declaration output should live in a separate build-capable config. See [Framework Prerequisites](./config/checkers.md#framework-prerequisites) for dependencies and generation requirements.

### What is `--mode` for?

A function config can read `mode` when it needs to distinguish local, CI, or release environments. It does not automatically add tasks. See [Config File](./config/config-file.md#mode).

## Maintainer Release Checklist

Before publishing, complete project tests, applicable Limina checks, the production build, artifact checks, and real consumer tests, and review disabled and skipped work. The Limina repository itself must also follow its same-version paired-artifact and CI gates. The commands above do not perform publication.

## See Also

- [CLI Reference](./cli.md): command selection, options, and write scope.
- [Pipelines](./config/pipelines.md): combine built-in tasks and external commands.
- [Release Checks](./config/release-checks.md): packed files and workspace publish dependencies.
