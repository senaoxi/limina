# Core Concepts

Limina uses TypeScript concepts, but the model is small. The important idea is to keep "what the source imports", "what TypeScript builds", and "what packages publish" aligned.

## Checker Entry

A checker entry is the root config Limina starts from.

```js
export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: 'tsconfig.build.json',
      },
    },
  },
});
```

For TypeScript, this is usually a build graph aggregator. It points to declaration projects through `references`. Limina walks that graph to discover what should be checked.

For framework files, a checker entry can use `vue-tsc`, `vue-tsgo`, or `svelte-check`. These checkers cover files that normal `tsc` does not understand by itself.

Any source family you want Limina to govern needs a checker entry in `limina.config.mjs`. Plain TypeScript packages usually point at the root `tsconfig.build.json`; Vue or Svelte projects add their framework checker entries. Graph, proof, source, and checker commands all start from these entries, so they define which projects are inside the governed surface.

## Declaration Leaf

A declaration leaf is a `tsconfig*.dts.json` project. It is the part of the graph that can be consumed by `tsc -b`.

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

The declaration leaf owns graph structure. It says which other declaration leaves this project references.

When a package, or one environment inside a package, belongs in the `tsc -b` graph, give it a declaration leaf. For example, `packages/core/tsconfig.lib.dts.json` can represent the library source boundary for `@acme/core`. That turns "which project depends on which" into a TypeScript-checkable reference graph. When `@acme/app` imports `@acme/core`, Limina can verify that app's leaf references core's leaf.

## Local Companion

Every declaration leaf should have a local companion for normal typechecking:

```text
tsconfig.lib.dts.json    <->    tsconfig.lib.json
tsconfig.tools.dts.json  <->    tsconfig.tools.json
tsconfig.test.dts.json   <->    tsconfig.test.json
```

The companion owns strict typecheck semantics such as `strict`, `lib`, `types`, `jsx`, and framework settings. Proof check verifies that declaration leaves and companions keep the same file set and typecheck-relevant compiler options, while checker build runs first-class entries through `tsc -b`, `tsgo -b`, or `vue-tsc -b`. Current `vue-tsgo` support is second-class for execution because its build mode does not preserve TypeScript project-reference boundaries or provide incremental build semantics; its configured tsconfig entry still participates in Limina graph/proof coverage.

This split keeps build output settings out of the ordinary typecheck config.

In practice, let the declaration leaf handle buildable declaration output and let the local companion describe normal strict typechecking. For example, `tsconfig.lib.dts.json` can focus on declaration emit, while `tsconfig.lib.json` carries `strict`, DOM libs, test types, or JSX settings. Limina proves their semantic parity instead of running a separate companion no-emit pass, so the `tsc -b` graph stays clean without weakening everyday source checks.

## Aggregator Config

An aggregator is a tsconfig with only `files: []` and `references`. It groups other projects and does not own source files.

Limina expects build graph configs such as `tsconfig.build.json` to be pure aggregators. If a default `tsconfig.json` has `references`, Limina expects it to be a pure IDE/typecheck aggregator too.

If a config only groups several leaves, keep it as an aggregator. A root `tsconfig.build.json`, for example, can reference every package's `tsconfig*.dts.json` without owning files itself. That keeps graph entrypoints and leaf boundaries easier to review, and Proof check can catch configs that try to aggregate projects and include source at the same time.

## Source Dependency

A dependency declared with `workspace:*` is a source dependency. It means this workspace package should be represented by project references and source-facing resolution.

If TypeScript resolves a `workspace:*` import to `dist`, Limina reports it. You can fix that by exposing source entries in the source manifest or by removing the source graph edge.

When `@acme/app` declares `"@acme/core": "workspace:*"`, the edge says app should consume core as source, so it should also have the matching project reference and source-resolvable entry. Limina prevents this source dependency from quietly going through `dist`. Source manifests should expose `src` entries; built or published manifests should be rewritten to expose artifact entries.

## Artifact Dependency

A dependency declared with `link:`, `file:`, `catalog:`, or normal semver is treated as an artifact dependency. It usually should not be modeled as a source project reference.

Artifact dependencies are checked at the package-output layer, not by pretending their source belongs to the current graph.

If a package only wants to consume another package the way an outside user would, treat it as an artifact dependency. For example, a tooling package might use the published output of `@acme/core` through normal semver instead of joining core's source build graph. The source graph stays smaller, and output problems are handled by `limina package check`.

## Labels and Rules

A declaration leaf can opt into one or more graph rules with `liminaOptions.graphRules`:

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

When a group of source files has a real boundary, put one or more graph rule labels on the matching `tsconfig*.dts.json` and define those rules in `limina.config.mjs`. For example, a browser runtime leaf can declare `"graphRules": ["runtime-client"]` under `liminaOptions` while the rule denies `node:*` and `@acme/internal-node`. The boundary no longer depends on convention alone; an import of `node:fs` from the browser project fails Graph check with the rule's reason.
