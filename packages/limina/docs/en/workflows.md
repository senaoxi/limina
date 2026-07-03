# Workflows

The day-to-day command sequences, a `CI` example, best practices, FAQ, and the maintainer release checklist are collected here, all invoking the same checks documented in the [CLI Reference](./cli.md). Start with [Getting Started](./getting-started.md) if you are new to Limina.

## Recommended Workflows

### Local Development

```sh
pnpm exec limina checker build
pnpm exec limina checker typecheck
pnpm exec limina graph check
```

Use these while changing `TypeScript` configs or package boundaries to confirm the generated graph, build checker entries, and non-build checker entries are still usable.

When artifact consumption changes, export the dependency graph. Limina derives artifact dependency edges from actual imports that resolve into built output inside the managed tsconfig domains:

```sh
pnpm exec limina graph export --view artifact --output .limina/dependency-graph.json
```

### Pull Requests

```sh
pnpm exec limina check
```

This checks graph relationships, file ownership, coverage, build-mode checkers, and check-only runners together.

### Pre-publish

```sh
pnpm build
pnpm exec limina package check
pnpm exec limina release check --package <name>
pnpm exec limina check publish
```

::: warning
Build first and confirm that `package.entries[].outDir` contains the files consumers will install.
:::

## CI Example

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

::: tip

- Keep source `tsconfig.json` aggregators pure with `files: []` and `references`.
- Keep source tsconfig file sets intentional, and let Limina own the declaration build configs under `.limina/`.
- Keep workspace package exports intentional: source entries need references from real imports or `implicitRefs`, and artifact entries appear in `limina graph export --view artifact` as scoped artifact dependencies.
- Source, package, and release checks cover different layers; release-related checks should run after artifacts are built.
- Keep allowlists small and explain why each exception is safe.

:::

## FAQ

### How do `limina checker build` and `checker typecheck` choose targets?

`checker build` runs presets that support build mode from configured entries: `tsc -b`, `tsgo -b`, and `vue-tsc -b`. `tsgo` is backed by `Microsoft`'s `@typescript/native-preview` package. `checker typecheck` runs check-only presets, currently `vue-tsgo --project <entry>` and `svelte-check --tsconfig <entry>`. Limina intentionally keeps `vue-tsgo` out of `checker build` because current `vue-tsgo --build` does not preserve `TypeScript` project-reference boundaries or provide incremental build semantics; its configured `tsconfig` entry still participates in Limina graph and coverage checks. Prefer `vue-tsc` for `Vue` build checks.

### Why do package checks require a build first?

::: warning
They inspect the package output under `package.entries[].outDir`. That output must already contain the built `package.json`, `exports`, `JavaScript`, and declarations. `release:check` additionally expects the packed output to contain `README.md` and `LICENSE.md`, and no source maps.
:::

### Can workspace exports point to dist?

Yes. Workspace package exports may point to source entries or built artifacts. Limina first requires the active resolver configuration to resolve every public export. Generated graph references are required for imports whose resolved entry is owned by a declaration project, with `liminaOptions.implicitRefs` available for real dynamic or virtual edges that static imports cannot prove. Built declarations such as `dist/*.d.ts` do not require project references. When an import resolves into `dist`, Limina reports an artifact dependency edge in the condition domain of the importing tsconfig. That edge is useful for review and diagnostics, but it is not a task-ordering guarantee.

### Should `Vue` or `Svelte` files be placed in the TypeScript graph?

Framework files should be covered by their framework checker entry. Limina can prove coverage through `vue-tsc`, `vue-tsgo`, or `svelte-check` without pretending those files are ordinary `tsc -b` declaration leaves.

### What is `--mode` for?

Use `--mode` when `limina.config.mjs` exports a function and returns different configuration for local, `CI`, or release workflows.

## Maintainer Release Checklist

Before publishing Limina itself or a package governed by Limina, check that:

- normal tests pass;
- `pnpm exec limina check` passes;
- the package build has run;
- `pnpm exec limina package check --package <name>` passes;
- `pnpm exec limina release check --package <name>` passes.

## See Also

- [CLI Reference](./cli.md) — every command and flag.
- [Pipelines](./config/pipelines.md) — compose named workflows from built-in tasks and external commands.
- [Package Checks](./config/package-checks.md) — built-output entries and `publint` / `attw` / `boundary`.
- [Release Checks](./config/release-checks.md) — `tarball` and publish hygiene.
