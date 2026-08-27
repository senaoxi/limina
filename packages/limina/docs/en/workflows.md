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

- Keep a source `tsconfig.json` aggregator's checker-resolved file set empty and declare its `references` directly; `files: []` is the clearest spelling.
- Keep solution configs at the exact `tsconfig.json` entry path. A named `tsconfig.*.json` that resolves no files and declares `references` is a TypeScript solution, but it is an unsupported Limina solution name.
- Keep source tsconfig file sets intentional, and let Limina own the declaration build configs under `.limina/`.
- Keep workspace package exports intentional: source entries need references from real imports or `implicitRefs`, and artifact entries appear in `limina graph export --view artifact` as scoped artifact dependencies.
- Source, package, and release checks cover different layers; release-related checks should run after artifacts are built.
- Keep allowlists small and explain why each exception is safe.

:::

## FAQ

### How does Limina recognize a solution config?

Limina uses the active checker to parse each reachable config. A config is a TypeScript solution when its effective file list is empty and it directly declares `references`; this can include configs that use `extends` or checker-supported framework files. Limina expands that role only when the path basename is exactly `tsconfig.json`. During migration, every reachable named solution is reported together before any worktree or file changes are made. Rename it to `tsconfig.json`, merge its references into the directory's existing default entry, or turn it into a source leaf with an explicit source boundary.

### How do `limina checker build` and `checker typecheck` choose targets?

`checker build` runs final build owners: `tsc -b`, `tsgo -b`, and `vue-tsc -b`. `tsgo` is backed by Microsoft's `@typescript/native-preview` package. `checker typecheck` runs final Astro and Svelte owners once per leaf config. Limina expands solution closures itself and deduplicates shared leaves.

Named checker entries lock their complete terminal-leaf closure. Automatic evidence is evaluated only for still-pending configs. Before targets are created, solution leaves and accepted declaration relations are colored as components, so every internal declaration-provider relationship uses one identical build-checker identity.

Module semantics are selected earlier and frozen separately from target ownership. Only explicit selection, checker-specific config, effective root files, or a confirmed pending framework dependency can lock semantic authority. Vue promotion, component coloring, fallback, and the final build owner cannot change it. For example, a TypeScript-semantic config may be colored into a `vue-tsc` build component without having its imports reinterpreted as Vue source.

### Why do package checks require a build first?

::: warning
They inspect the package output under `package.entries[].outDir`. That output must already contain the built `package.json`, `exports`, `JavaScript`, and declarations. `release:check` additionally expects the packed output to contain `README.md` and `LICENSE.md`, and no source maps.
:::

### Can workspace exports point to dist?

Yes. Workspace package exports may point to source entries or built artifacts. Limina first requires the active resolver configuration to resolve every public export. Generated graph references are required for imports whose resolved entry is owned source in a declaration project, with `liminaOptions.implicitRefs` available for real dynamic or virtual edges that static imports cannot prove. Built declarations such as `dist/*.d.ts` are artifact boundaries: they do not create manifest `declaration-provider` edges, generated project references, or output-build references. Limina may reverse-attribute a managed declaration to source for type evidence or diagnostics, but that attribution is not a build dependency or task-ordering guarantee.

### Should `Vue` or `Svelte` files be placed in the TypeScript graph?

In automatic scope, a type config containing Vue roots is owned by `vue-tsc`; a config containing Astro or Svelte roots is owned by its corresponding framework checker. An explicit owner is authoritative instead: Astro adds only `.astro` observation and Svelte adds only `.svelte` observation to TypeScript. Other configured source extensions remain proof coverage gaps. Astro- and Svelte-owned configs do not generate declarations, so TypeScript that must emit declarations needs a separate `tsc`, `tsgo`, or `vue-tsc` boundary.

For project dependencies, the locked semantic authority is the boundary. Vue and Astro dependencies come from their generated service scripts; Svelte dependencies come from the owning leaf's public `svelte2tsx` peer output. Limina enumerates generated TypeScript with the checker toolchain, requires strict reverse provenance to source, and treats synthetic generated imports as observation-only. A checker-semantic miss or mapping failure is not rescued by Oxc. Oxc can identify a governed framework candidate only while an automatic config is still pending and TypeScript type evidence is `missing`.

### What is `--mode` for?

Use `--mode` when `limina.config.mts` exports a function and returns different configuration for local, `CI`, or release workflows.

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
