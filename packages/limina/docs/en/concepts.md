# Core Concepts

Limina uses TypeScript concepts, but the model is small. The important idea is to keep "what the source imports", "what TypeScript builds", and "what packages publish" aligned.

## Checker Entry

A [checker entry](./config/checkers.md) selects source `tsconfig.json` entry files for one checker namespace.

```js
export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        include: ['packages/**/tsconfig.json'],
      },
    },
  },
});
```

For TypeScript, this is usually a set of package or workspace entry selectors. Limina expands `include` minus `exclude`, follows solution references from those entries, then writes the executable declaration build graph under `.limina/`.

For framework files, a checker entry can use `vue-tsc`, `vue-tsgo`, or `svelte-check`. These checkers cover files that normal `tsc` does not understand by itself.

Any source family you want Limina to check needs a checker entry in `limina.config.mjs`. Plain TypeScript packages usually use a `typescript` checker with `tsconfig.json` entry globs; Vue or Svelte projects add framework checker entries for the `tsconfig.json` files that need those capabilities. Graph, proof, source, and checker commands all start from these entries.

## Declaration Build Configs

Limina writes generated declaration build configs under `.limina/tsconfig/checkers/<checker>/projects/.../*.dts.json`. These are the project nodes consumed by `tsc -b` or `vue-tsc -b`.

It should emit declarations only, with build-mode options such as:

```jsonc
{
  "compilerOptions": {
    "composite": true,
    "incremental": true,
    "noEmit": false,
    "declaration": true,
    "emitDeclarationOnly": true,
    "rootDir": "src",
    "outDir": "./.tsbuild",
    "tsBuildInfoFile": "./.tsbuild/lib.tsbuildinfo",
  },
}
```

These generated configs own the build graph structure. They extend the source config, force declaration-only emit, record `liminaOptions.sourceConfig`, and reference other generated configs inferred from source imports or declared through `liminaOptions.implicitRefs`.

When a package, or one environment inside a package, belongs in the checker graph, start from its `tsconfig.json` entry. If that entry references `packages/core/tsconfig.lib.json`, Limina can generate the declaration boundary for `@acme/core`. When `@acme/app` imports `@acme/core`, Limina can verify and generate the corresponding declaration reference.

## Source Config

The source config is the canonical user-facing config:

```text
packages/core/tsconfig.lib.json
packages/core/tsconfig.tools.json
packages/core/tsconfig.test.json
```

The source config owns typecheck semantics such as `lib`, `types`, `jsx`, and framework settings. Proof check confirms that source is not missed, while checker build runs Limina's generated build entries through `tsc -b`, `tsgo -b`, or `vue-tsc -b`.

::: warning
Current `vue-tsgo` support is check-only for execution because its build mode does not preserve TypeScript project-reference boundaries or provide incremental build semantics; selected source tsconfigs still participate in Limina graph and coverage checks.
:::

This split keeps generated declaration output settings out of the ordinary source config.

## Aggregator Config

An aggregator is a tsconfig with only `files: []` and `references`. It groups other projects and does not own source files.

Limina still expects default `tsconfig.json` files with `references` to be pure IDE/typecheck aggregators.

If a source config only groups several source projects, keep it as an aggregator. Generated build aggregators live under `.limina/` and are recreated by `limina graph prepare`.

## Source and Artifact Edges

A package can expose some public entries as source and other public entries as built artifacts. The dependency protocol in `package.json` authorizes package access, but it does not decide whether a relationship is source or artifact consumption. The resolved file decides.

Limina pre-resolves every public `exports` subpath for workspace packages that declare `exports`. TypeScript resolution must find a stable type entry: `.d.ts` family declarations, source files such as `.ts` / `.tsx` / `.mts` / `.cts`, `.json`, or checker-supported source extensions such as `.vue`. If TypeScript only reaches runtime JavaScript, or if TypeScript or Oxc cannot resolve an export, graph checking reports the package export.

When `@acme/app` imports a public entry of `@acme/core`, graph references are required only when that resolved entry lands on source managed by Limina. Built declaration artifacts such as `dist/*.d.ts` are already output, so they do not require a project reference. The complementary artifact relationship appears in `limina graph export --view artifact` as a scoped artifact dependency.

## Dependency Graph Export

`limina graph export` emits package nodes and source/artifact edges as JSON:

```sh
pnpm exec limina graph export --view all
```

Use `--view source` when you want only source graph relationships, or `--view artifact` when you want to inspect artifact-consumption facts. Each edge is resolved inside the tsconfig domain Limina governs, including that domain's `compilerOptions.customConditions`. The export is not an authoritative task graph or build-order source.

Artifact outputs are still checked at the package-output layer by `limina package check`, not by pretending their source belongs to the current type graph.

## Labels and Rules

A source tsconfig can opt into one or more [graph rules](./config/graph-rules.md) with `liminaOptions.graphRules`. Limina carries those labels onto the generated build config:

```jsonc
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
}
```

The matching `graph.rules.runtime-client` entry can deny references or dependencies:

```js
export default defineConfig({
  graph: {
    rules: {
      'runtime-client': {
        deny: {
          deps: [
            {
              name: 'node:*',
              reason: 'browser runtime must not import Node builtins',
            },
          ],
        },
      },
    },
  },
});
```

Use labels for boundaries that matter to the architecture: browser vs Node, public API vs internal tools, production vs tests, or package-specific rules.

When a group of source files has a real boundary, put one or more graph rule labels on the matching source tsconfig and define those rules in `limina.config.mjs`. For example, a browser runtime config can declare `"graphRules": ["runtime-client"]` under `liminaOptions` while the rule denies `node:*` and `@acme/internal-node`. The boundary is enforced by config and real source imports; an import of `node:fs` from the browser project fails graph check with the rule's reason.
