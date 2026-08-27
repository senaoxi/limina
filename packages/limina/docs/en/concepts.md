# Core Concepts

Limina's model can be understood through one path: first decide which `tsconfig` files enter governance, then generate a declaration build graph from source imports and module resolution results, and finally validate source dependencies, artifact dependencies, and package boundaries in the same check flow.

It does not replace `TypeScript`, framework checkers, bundlers, test frameworks, or package managers. Limina makes the configuration relationships that those tools already depend on explicit, and reports inconsistencies between source code, configuration, and package boundaries.

## Checker Entry

A [checker entry](./config/checkers.md) tells Limina which source `tsconfig.json` files should be handled by which checker.

Auto discovery is always enabled, including when named checker scopes are present. It discovers ordinary `tsconfig.json` entries and assigns each reachable type config exactly one owner from `tsc`, `tsgo`, `vue-tsc`, `astro`, or `svelte-check`. Use `auto.useTsgo: true` to choose `tsgo` as the ordinary TypeScript fallback; named scopes provide direct ownership evidence for selected default entries.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      auto: {
        exclude: ['**/docs/**'],
        useTsgo: false,
      },
      tsc: {
        include: ['tsconfig.json', 'packages/**/tsconfig.json'],
      },
      'vue-tsc': {
        include: ['packages/app/tsconfig.json'],
      },
    },
  },
});
```

Entry selection is region-scoped. Named `include` fields only select default source `tsconfig.json` entries, while `auto.exclude` filters automatic root discovery. Do not list `tsconfig.lib.json`, `tsconfig.test.json`, `tsconfig.build.json`, or generated configs under `.limina` directly in a named checker scope. These non-entry source configs enter Limina's managed scope only when reached through `references` from a selected `tsconfig.json` entry. Neither `auto.exclude` nor a named scope's `exclude` cuts an established references closure; an existing ordinary source config reached outside the activated regions is reported as a cross-region reference.

Fixed checker identities have different roles:

- `tsc`, `tsgo`, and `vue-tsc` own source configs and execute generated declaration build entries;
- `svelte-check` and `astro` own complete framework type configs and execute them per leaf without declaration output.

This distinction affects later commands. `limina checker build` runs declaration-capable owners, while `limina checker typecheck` runs framework-owned leaves.

## Source Config

A source config is a user-maintained `tsconfig*.json`. It defines the source file set and type-checking semantics, such as `lib`, `types`, `jsx`, `paths`, `customConditions`, and framework-specific settings.

A common structure looks like this:

```text
packages/core/tsconfig.json
packages/core/tsconfig.lib.json
packages/core/tsconfig.test.json
packages/core/tsconfig.tools.json
```

In Limina's model, `tsconfig.json` usually acts as an entry or aggregator. Configs such as `tsconfig.lib.json`, `tsconfig.test.json`, and `tsconfig.tools.json` are usually source leaf configs. A source leaf config should describe the source files it owns, and should not manually maintain `references`. Limina infers declaration build references from static imports and `liminaOptions.implicitRefs`.

If an edge comes from dynamic imports, generated code, virtual modules, or another relationship that static import analysis cannot see, declare it in the source leaf config through `liminaOptions.implicitRefs`:

```jsonc
{
  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../contracts/tsconfig.lib.json",
        "reason": "runtime schema generation imports this project through generated code",
      },
    ],
  },
}
```

The `path` of an `implicitRefs` entry must point to an ordinary source `tsconfig*.json` reachable by the same checker. It cannot point to a generated `.limina` config, a build config, a base config, or itself.

## Aggregator Config

Limina treats a config as a TypeScript solution when the checker-resolved file set is empty and the config directly declares `references`. The resolved file set is computed with the active checker, so `extends`, framework extensions such as `.vue`, and other TypeScript project rules are included in this decision. `files: []` is the clearest way to make that intent explicit, but it is not the only accepted spelling.

```jsonc
{
  "files": [],
  "references": [{ "path": "./tsconfig.lib.json" }, { "path": "./tsconfig.test.json" }],
}
```

Only a solution at a path named exactly `tsconfig.json` is a Limina-managed aggregator. A default `tsconfig.json` that resolves any source file is an ordinary source leaf; if it also declares `references`, Limina reports the source-reference violation instead of treating it as an aggregator. A named config such as `tsconfig.solution.json` can still be a TypeScript solution according to the compiler, but it is not a supported Limina solution entry and must not be used as one.

When `limina graph prepare` runs, Limina starts from checker entries, follows valid `references` from the supported `tsconfig.json` solutions, and generates the build graph consumed by checkers.

Do not treat an aggregator as a source owner. When different runtime environments, test scopes, or build targets need to be separated, let the aggregator reference multiple source leaf configs instead of making one config both aggregate projects and own source files.

## Declaration Build Config

A declaration build config is an internal `tsconfig` generated by Limina for build-capable checkers. These configs are written under:

```text
.limina/tsconfig/checkers/<checker>/projects/.../*.dts.json
.limina/tsconfig/checkers/<checker>/solutions/.../tsconfig.build.json
.limina/tsconfig/checkers/<checker>/tsconfig.build.json
```

Project-level declaration build configs extend the corresponding source config and write explicit `files`, `compilerOptions`, `references`, and `liminaOptions`. Important options include:

```jsonc
{
  "compilerOptions": {
    "composite": true,
    "incremental": true,
    "noEmit": false,
    "declaration": true,
    "emitDeclarationOnly": true,
    "declarationMap": false,
    "rootDir": "...",
    "outDir": "...",
    "declarationDir": "...",
    "tsBuildInfoFile": "...",
  },
  "liminaOptions": {
    "generated": true,
    "checker": "typescript",
    "sourceConfig": "...",
  },
}
```

Declaration files are written under `.limina/dts/checkers/<checker>/...`, and build cache files are written under `.limina/tsbuildinfo/checkers/<checker>/...`. Generated declaration configs set both `outDir` and `declarationDir` to that same managed root, so an inherited source `declarationDir` cannot redirect the checker output. These paths are Limina internal outputs. Do not edit them by hand, and do not write them into user-maintained source configs.

Generated `references` come from two kinds of facts: a source import resolves through `TypeScript` to a Limina-managed source provider, or a source config explicitly declares `liminaOptions.implicitRefs`. If an import resolves to a `.d.ts`-family declaration file, Limina treats it as declaration consumption, not a source project reference.

## User Artifact Build Config

Declaration build configs are only used for Limina's internal checker build. They are not the same as the artifacts users publish to `dist`.

When you want Limina to execute a user-facing artifact build, declare `liminaOptions.outputs` on the source leaf config, then run:

```sh
pnpm exec limina build packages/core/tsconfig.lib.json
```

`liminaOptions.outputs` supports `target`, `rootDir`, `outDir`, and `declarationMap`. Path fields are resolved relative to the source config that declares them. If not set explicitly, `outDir` defaults to `dist` under the config directory, `target` inherits `compilerOptions.target` from the source config when present, otherwise it uses `ESNext`, and `declarationMap` defaults to `false`.

```jsonc
{
  "liminaOptions": {
    "outputs": {
      "rootDir": "src",
      "outDir": "dist",
      "declarationMap": true,
    },
  },
}
```

Limina generates output build configs under `.limina/tsconfig/checkers/<checker>/outputs/...` and executes them with a build-capable checker. Output build cache files are written under `.limina/tsbuildinfo/build/...` and are managed by Limina. A source config without `liminaOptions.outputs` cannot be used as a managed artifact build target for `limina build <config>`. If you only want to invoke a checker directly on a raw config, use `limina build <config> --raw --preset <tsc|tsgo|vue-tsc>`.

The generated user-output config sets both `outDir` and `declarationDir` to `liminaOptions.outputs.outDir`. Limina currently supports one managed artifact output root; it does not model split JavaScript and declaration directories.

## Source Edges, Declaration Edges, and Artifact Edges

An `import` is not necessarily a `references` edge. Limina first checks where the import resolves under the current source config and checker semantics, then decides which relationship it represents.

If the `TypeScript` resolution result lands on a Limina-managed source file, the import forms a source edge, and the declaration build graph needs to reference the generated declaration config corresponding to the target source config. For workspace package imports, this usually also means the importing package should declare the target package in `package.json` dependency fields.

If the `TypeScript` resolution result lands on `.d.ts`, `.d.mts`, or `.d.cts`, the import is already consuming declarations and does not need another source project reference.

If a cross-package import resolves to the target package's `dist` directory, `limina graph export` classifies it as an artifact edge. An artifact edge means the current source consumes a built artifact rather than the source graph managed by Limina. It should not be disguised as a source `references` edge.

For workspace packages that declare `exports`, Limina checks public entries under the resolution conditions of the relevant source config. When governed source imports those entries through a package import, `TypeScript` should resolve to a stable type entry or to a source entry supported by the checker. If it resolves only to runtime `JavaScript`, or if `TypeScript` / `Oxc` cannot resolve the export, graph check reports the issue.

## Dependency Graph Export

`limina graph export` emits package nodes and cross-package edges as JSON:

```sh
pnpm exec limina graph export --view all
```

Available views are:

- `--view source`: export only source edges;
- `--view artifact`: export only artifact edges;
- `--view all`: export both edge kinds.

The export is for observing package-level dependency facts that Limina can currently prove. It is not a build-system task graph, not a package-manager dependency manifest, and not a source of build ordering. Build order is still determined by the TypeScript project-reference graph and the specific executor. Published package artifacts still need to be maintained by the build, test, package-check, and release flows together.

## Labels and Graph Rules

A source config can bind a set of graph rule labels through `liminaOptions.graphRules`. Limina carries these labels onto the corresponding generated declaration config and uses them during graph checks to decide which references or dependencies are not allowed.

```jsonc
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
}
```

Rules are declared in `limina.config.mts`:

```js
import { defineConfig } from 'limina';

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

`deny.refs` forbids project references to specific source configs. `deny.deps` forbids source imports of specific packages, `#imports`, or Node builtins. `allow.refs` only explains additional existing references. It does not create references and does not override `deny.refs`.

Graph rules are useful for boundaries such as browser vs Node, public API vs internal tools, and production source vs tests. Limina checks rules together with source imports and the generated declaration graph. If source tagged with `runtime-client` imports `node:fs`, graph check fails and reports the rule's `reason`.
