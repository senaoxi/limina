# Workflows

This page lists local command sequences, a CI example, configuration practices, FAQ, and a release checklist. See [CLI Reference](./cli.md) for command details, or [Getting Started](./getting-started.md) for initial setup.

## Recommended Workflows

Run configuration migration with the separate `limina-migrate` package matching your Limina version; see the [migration contract](./cli.md#limina-migration). The distributed tool embeds that release's core input implementation; configs importing public `limina` still need it installed where the config resolves dependencies. `limina migration` is a deprecated forwarder that uses a matching local tool or invokes npm to obtain the exact core version. Workspace-only `limina/internal/*` entries are removed from the published core exports.

After migration, inspect `.limina/migration/latest.json` and run `limina check`. Migration verifies that a fresh process can read the written input topology for the `check` and `graph` command configurations and that protected membership remains reachable. This does not run full graph governance or checker execution, or promise equivalent native `tsc -b` behavior. Incomplete dependency comparison preserves retained explicit source relations instead of treating missing facts as an empty inferred graph.

### Local Development

```sh
pnpm exec limina checker build
pnpm exec limina checker typecheck
pnpm exec limina graph check
```

Run these commands after changing TypeScript configs or package boundaries to check the graph and execute the selected build and check-only targets.

When artifact consumption changes, export the dependency graph. Limina derives artifact dependency edges from actual imports that resolve into built output inside the managed tsconfig domains. The category follows source ownership first, then validated output roots declared by `liminaOptions.outputs` or package output entries. A custom output such as `lib/` is eligible; a directory named `dist/` alone is not proof of an artifact, and owned source inside it remains source.

```sh
pnpm exec limina graph export --view artifact --output .limina/dependency-graph.json
```

### Pull Requests

```sh
pnpm exec limina check
```

The default pipeline checks graph relationships, file ownership, coverage, build-mode checkers, and check-only runners together. Review task and check-item outcomes: `disabled`, `blocked`, or `skipped` work has not passed a check. Package and release checks require their own commands or configured pipeline tasks.

### Pre-publish

```sh
pnpm build
pnpm exec limina package check
pnpm exec limina release check --package <name>
pnpm exec limina check publish
```

Here `pnpm build` is your project's build script, `<name>` is a configured package entry name, and the final command requires a user-defined `pipelines.publish`. There is no built-in `publish` pipeline. The package and release check commands do not publish; project scripts and pipelines run the commands you configure.

::: warning
Build first and confirm that the selected `package.entries[].outDir` contains the files consumers will install. Configure and enable the intended package/release checks; an optional analyzer that is unavailable may be skipped, so a successful command alone does not prove it ran.
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
- Configure source tsconfig file sets explicitly, and let Limina generate declaration build configs under `.limina/`.
- Review workspace exports against actual consumption: consumed source entries may require declaration-provider references or `implicitRefs`; consumed artifacts under validated output roots can appear in `limina graph export --view artifact`. Unused exports do not create these edges.
- Source, package, and release checks cover different layers; release-related checks should run after artifacts are built.
- Limit allowlists to the needed exceptions and explain why each is safe.

:::

## FAQ

### How does Limina recognize a solution config?

Limina parses each reachable config with its active checker. A config has TypeScript solution semantics when its effective file list is empty and it directly declares `references`; `extends` and supported framework files still affect that file list. Limina expands solutions only at the exact `tsconfig.json` basename. Migration can expand pure named membership wrappers into retained solution parents, rebase paths, protect source membership, and prune path-only wrapper or solution-cycle edges while compensating retained reachability. Wrappers with substantive Limina declarations, or reference attributes that cannot be propagated or safely removed, need manual conversion; see [migration](./cli.md#limina-migration).

### How do `limina checker build` and `checker typecheck` choose targets?

`checker build` runs final build owners: `tsc -b`, `tsgo -b`, and `vue-tsc -b`. `tsgo` is backed by Microsoft's `@typescript/native-preview` package. `checker typecheck` runs final Astro and Svelte owners once per leaf config. Limina expands solution closures itself and deduplicates shared leaves.

Named checker entries lock their complete terminal-leaf closure. Automatic evidence is evaluated only for still-pending configs. Before targets are created, solution leaves and accepted declaration relations are colored as components, so every internal declaration-provider relationship uses one identical build-checker identity.

Module semantics are selected earlier and frozen separately from target ownership. Only explicit selection, checker-specific config, effective root files, or a confirmed pending framework dependency can lock semantic authority. Vue promotion, component coloring, fallback, and the final build owner cannot change it. For example, a TypeScript-semantic config may be colored into a `vue-tsc` build component without having its imports reinterpreted as Vue source.

### Why do package checks require a build first?

::: warning
They inspect selected package outputs under `package.entries[].outDir`. Each output needs a readable `package.json` and the files its published manifest declares; JavaScript, declarations, and `exports` depend on that package's public surface. When release tarball checks are enabled, the packed output must also contain `README.md` and `LICENSE.md`, and must not contain source map files or JavaScript `sourceMappingURL` directives.
:::

### Can workspace exports point to dist?

Yes. Workspace package exports may point to source entries or built artifacts. Graph checks follow entries actually consumed by imports under the importing checker's resolver configuration; an unused broken export does not fail graph checking. Generated graph references are required when a consumed source relation has a declaration-provider requirement and a valid managed provider, with `liminaOptions.implicitRefs` available for real dynamic or virtual edges that static imports cannot prove. Built declarations such as `dist/*.d.ts` are artifact boundaries: they do not create manifest `declaration-provider` edges, generated project references, or output-build references. Limina may reverse-attribute a managed declaration to source for type evidence or diagnostics, but that attribution is not a build dependency or task-ordering guarantee.

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

Check the reported coverage and skipped items as well as the exit code. Publishing Limina itself also follows the repository's release tooling for the same-version `limina` and `limina-migrate` pair and its CI gates; this checklist does not authorize or perform publication.

## See Also

- [CLI Reference](./cli.md) — every command and flag.
- [Pipelines](./config/pipelines.md) — compose named workflows from built-in tasks and external commands.
- [Package Checks](./config/package-checks.md) — built-output entries and `publint` / `attw` / `boundary`.
- [Release Checks](./config/release-checks.md) — `tarball` and publish hygiene.
