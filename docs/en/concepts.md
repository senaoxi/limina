# Core Concepts

Start with a familiar TypeScript configuration. Suppose a package has one `tsconfig.json` and one source file:

```text
my-package/
  package.json
  tsconfig.json
  src/index.ts
```

`tsconfig.json` determines the files in the type-checking scope and the compiler options to use. Limina can discover it, check whether source has the expected coverage, and run the TypeScript checker. You continue to maintain that config. Limina generates its own declaration-build config under `.limina/`. Declaration files such as `.d.ts` describe exported types for TypeScript to use elsewhere.

As the project grows, browser code and Node scripts may need different type environments. Split them into `tsconfig.app.json` and `tsconfig.node.json`, then use a `tsconfig.json` that does not directly contain source to organize them:

`tsconfig.json`:

```jsonc
{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }],
}
```

Here `tsconfig.json` is an **aggregator** that tells Limina where to find the source configs. `tsconfig.app.json` and `tsconfig.node.json` are **source configs** that contain source. An app importing a tool file is different from both configs claiming the same file as their own source. Clear ownership helps identify omissions and duplicate coverage.

When a dependency between source configs requires a declaration build, Limina uses the checker and source ownership to infer the reference, then checks graph rules separately. An `import` does not always require a project reference. For example, importing an existing declaration differs from importing another managed source config.

A source config that directly includes files is also called a **source leaf**. An aggregator organizes configs without directly including source. The roles are:

| Object                   | Maintained by                                                      | Question it answers                                                                             |
| ------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Source leaf config       | User                                                               | Which files share a type-checking scope, and which compiler options apply?                      |
| Aggregator config        | User                                                               | Which leaf configs should a default `tsconfig.json` entry include?                              |
| Declaration build config | Limina                                                             | Where do internal declarations go, and which upstream declaration projects must be built first? |
| User artifact output     | Declared by the user; built by Limina or the project's build tools | Where do the JavaScript, declarations, and other files consumers install go?                    |

The sections below explain these configs, checkers, builds, and dependency graphs. To complete a first check, start with [Getting Started](./getting-started.md) and return here when you need to understand a scope.

## Source Config

A source config is a user-maintained ordinary `tsconfig*.json`, outside `.limina` and without the reserved `.build`, `.dts`, `.base`, or `.check` suffix. It defines the source file set and type-checking semantics, such as `lib`, `types`, `jsx`, `paths`, `customConditions`, and framework-specific settings.

Limina determines source ownership from the files actually included by each config, rather than guessing from a nearby `tsconfig` or package name. If the same implementation file has multiple possible source configs, Limina reports an ownership conflict.

A common structure looks like this:

```text
packages/core/tsconfig.json
packages/core/tsconfig.lib.json
packages/core/tsconfig.test.json
packages/core/tsconfig.tools.json
```

In a typical layout, `tsconfig.json` is the entry or aggregator, and configs such as `tsconfig.lib.json`, `tsconfig.test.json`, and `tsconfig.tools.json` are source leaves. A source leaf config describes the files it owns and must not directly declare native `references`, even as an empty array. Limina derives declaration build references from source imports and managed declarations, supplemented by `liminaOptions.implicitRefs`.

::: details Declaration relationships static analysis cannot see

Literal dynamic imports such as `import("./module.js")` already participate in dependency collection. If a declaration-build relationship comes from generated code, computed runtime imports, or another relationship that dependency analysis cannot observe, declare it in the source leaf config through `liminaOptions.implicitRefs`.

For example, suppose `packages/app` and `packages/contracts` are governed workspace packages, their source configs are reachable from checker entries, and `app` declares a dependency on `contracts`. Add this to `packages/app/tsconfig.lib.json` if its declaration build needs that otherwise unobserved relationship:

```jsonc
{
  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../contracts/tsconfig.lib.json",
        "reason": "This leaf's declaration build needs contracts source referenced by generated schema code.",
      },
    ],
  },
}
```

`implicitRefs.path` is relative to the source config declaring it and must point to an ordinary, declaration-capable source leaf reachable by the same checker. It cannot point to a generated `.limina` config, a build config, a base config, or itself. These relationships still need to pass graph rules; they do not add module-resolution capabilities.

:::

## Aggregator Config

Limina treats a config as a TypeScript solution when the checker-resolved file set is empty and the config directly declares `references`. The resolved file set is computed with the active checker, so `extends`, framework extensions such as `.vue`, and other TypeScript project rules are included in this decision. `files: []` explicitly declares an empty file list, though other configurations can also satisfy this condition.

```jsonc
{
  "files": [],
  "references": [{ "path": "./tsconfig.lib.json" }, { "path": "./tsconfig.test.json" }],
}
```

Only a solution at a path named exactly `tsconfig.json` is a Limina-managed aggregator. A default `tsconfig.json` that resolves any source file is an ordinary source leaf; if it also declares `references`, Limina reports the source-reference violation instead of treating it as an aggregator. A named config such as `tsconfig.solution.json` can still be a TypeScript solution according to the compiler, but it is not a supported Limina solution entry and must not be used as one.

When `limina graph prepare` runs, Limina starts from checker entries, follows valid `references` from the supported `tsconfig.json` solutions, and generates the build graph consumed by checkers.

Do not treat an aggregator as a source owner. When different runtime environments, test scopes, or build targets need to be separated, let the aggregator reference multiple source leaf configs instead of making one config both aggregate projects and own source files.

## Checker Entry

A [checker entry](./config/checkers.md) specifies which checker handles each selected source `tsconfig.json`.

Auto discovery is always enabled, including when named checker scopes are present. It discovers ordinary `tsconfig.json` entries and assigns each reachable source leaf config exactly one owner from `tsc`, `tsgo`, `vue-tsc`, `astro`, or `svelte-check`. Use `auto.useTsgo: true` to choose `tsgo` as the ordinary TypeScript fallback; named scopes provide direct ownership evidence for selected default entries.

For example, if a default `tsconfig.json` directly contains ordinary TypeScript source, automatic discovery can assign it to `tsc`. If it only references leaf configs, Limina recursively follows those memberships and determines each leaf's checker. Start with the defaults in most cases; see [Checker Configuration](./config/checkers.md) for configuration details.

Entry selection is region-scoped. Named `include` fields only select default source `tsconfig.json` entries, while `auto.exclude` filters automatic root discovery. Do not list `tsconfig.lib.json`, `tsconfig.test.json`, `tsconfig.build.json`, or generated configs under `.limina` directly in a named checker scope. Ordinary named source configs such as `tsconfig.lib.json` and `tsconfig.test.json` enter Limina's managed scope only through `references` from a selected `tsconfig.json` entry. Reserved `tsconfig*.build.json`, `tsconfig*.dts.json`, `tsconfig*.base.json`, and `tsconfig*.check.json` are not managed source entries. Neither `auto.exclude` nor a named scope's `exclude` cuts an established references closure; an existing ordinary source config reached outside the activated regions is reported as a cross-region reference.

Fixed checker identities have different roles:

- `tsc`, `tsgo`, and `vue-tsc` own source configs and execute generated declaration build entries;
- `svelte-check` and `astro` own complete framework type configs and execute them per leaf without declaration output.

This distinction affects later commands. `limina checker build` runs declaration-capable owners, while `limina checker typecheck` runs framework-owned leaves.

## Declaration Build Config

A declaration build config is an internal `tsconfig` generated by Limina for build-capable checkers. These configs are written under:

```text
.limina/tsconfig/checkers/<checker>/projects/.../*.dts.json
.limina/tsconfig/checkers/<checker>/solutions/.../tsconfig.build.json
.limina/tsconfig/checkers/<checker>/tsconfig.build.json
```

Project-level declaration build configs extend the corresponding source config and write explicit `files`, `compilerOptions`, `references`, and `liminaOptions`. Generated options include:

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
    "checker": "tsc",
    "sourceConfig": "...",
  },
}
```

Declaration files are written under `.limina/dts/checkers/<checker>/...`, and build cache files are written under `.limina/tsbuildinfo/checkers/<checker>/...`. Generated declaration configs set both `outDir` and `declarationDir` to that same managed root, so an inherited source `declarationDir` cannot redirect the checker output. These paths are Limina internal outputs. Do not edit them by hand, and do not write them into user-maintained source configs.

Declaration directories and cache scopes retain the full source config filename so sibling leaves do not share output. Limina maintains the generated files; run `graph prepare` or the corresponding checker command when they need refreshing.

Generated `references` can come from validated source compiler relationships, a selected context for a managed declaration, or explicit `liminaOptions.implicitRefs`. For a relationship between implementation sources, the target alone is insufficient: the relation needs a non-null requirement, valid provider ownership and declaration capability, and the same final checker identity. Graph rules separately check whether the relationship is allowed; a denied relationship is not hidden by deleting it from the analysis. A declaration file is consumed as a declaration, and its path alone does not identify the project that produced it. A managed declaration can still require a reference to the config selected to check it.

## User Artifact Build Config

Declaration build configs are only used for Limina's internal checker build. They are not the same as the artifacts users publish to `dist`.

When you want Limina to execute a user-facing artifact build, declare `liminaOptions.outputs` on the source config. For example, suppose the workspace includes `packages/core`, its `tsconfig.json` aggregator references `tsconfig.lib.json`, and the source inputs of that config are all under `src`. Merge these fields into `tsconfig.lib.json` while retaining its existing `compilerOptions` and `include`:

`packages/core/tsconfig.lib.json`:

```jsonc
{
  "liminaOptions": {
    "outputs": {
      "rootDir": "src",
      "outDir": "dist",
    },
  },
}
```

Then run at the workspace root:

```sh
pnpm exec limina build packages/core/tsconfig.lib.json
```

With TypeScript settings suitable for JavaScript and declaration output, `src/index.ts` can produce `dist/index.js` and `dist/index.d.ts`. The project must still prepare package manifests and other release files before running [package checks](./config/package-checks.md).

`liminaOptions.outputs` supports `target`, `rootDir`, `outDir`, and `declarationMap`. Path fields are resolved relative to the source config that declares them. If not set explicitly, `rootDir` defaults to the source config directory, `outDir` defaults to `dist` under that directory, `target` inherits `compilerOptions.target` from the source config when present, otherwise it uses `ESNext`, and `declarationMap` defaults to `false`. Enabling `declarationMap` can generate `.d.ts.map` files, but [release checks](./config/release-checks.md) reject `.map` files in the packed content. Decide whether to exclude them from the package before release.

With the same directory layout, `outputs: {}` uses the package directory as `rootDir`, so `src/index.ts` produces files under `dist/src/`. Setting `rootDir: 'src'` as above puts them directly under `dist/`.

Limina generates output build configs under `.limina/tsconfig/checkers/<checker>/outputs/...` and executes them with a build-capable checker. Output build cache files are written under `.limina/tsbuildinfo/build/...` and are managed by Limina. A source config without `liminaOptions.outputs` cannot be used as a managed artifact build target for `limina build <config>`. If you only want to invoke a checker directly on a raw config, use `limina build <config> --raw --preset <tsc|tsgo|vue-tsc>`.

The generated user-output config sets both `outDir` and `declarationDir` to `liminaOptions.outputs.outDir`. Limina currently supports one managed artifact output root; it does not model split JavaScript and declaration directories. Astro/Svelte framework leaves do not support this managed artifact projection; use their application build flow.

## Source Edges, Declaration Edges, and Artifact Edges

An `import` does not necessarily correspond to a project reference. Limina resolves it under the current checker and source config before classifying the relationship:

| Observed relationship                                                  | Consequence                                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Imports source owned by the current leaf                               | Stays within the current project; no cross-project reference is needed                                                    |
| Imports source owned by another managed leaf                           | A candidate source relationship; a reference may be inferred when declaration requirements and checker conditions are met |
| Resolves to an existing `.d.ts`-family file                            | Consumes the declaration; a managed declaration may also need a reference to its checking context                         |
| A supported relationship involving frameworks such as Astro / Svelte   | May form a scheduling edge, distinct from a declaration project reference                                                 |
| A target without source ownership falls within a validated output root | Package graph export may record artifact consumption; this does not schedule a production build                           |

For example, if `app` imports `core/src/index.ts` through a package name, both sides have unique source owners and the same build checker, and a declaration-build requirement exists, Limina can make the generated config for `app` reference the generated config for `core`. Graph rules check separately whether this relationship is allowed. If the same import resolves to a built `core/dist/index.d.ts` outside managed source coverage, Limina does not infer its producer from that path. The project's build workflow is responsible for updating the artifact.

A checker-resolved managed source target is a candidate source relationship. A reference inferred from an implementation-source relationship also requires a non-null compiler relation requirement, valid source ownership and target, and declaration-capable endpoints with the same final checker identity. Concrete declaration evidence can stop a new source relation even when the original resolution records source. Astro/Svelte source relationships can instead produce `framework-schedule` edges, which never become declaration references. Package dependency authorization is checked separately against the source owner manifest.

If TypeScript resolves to `.d.ts`, `.d.mts`, or `.d.cts`, the import consumes a declaration file. Limina does not infer its producing source project from the path alone; a managed declaration may still lead to a reference under the [declaration-context rules](./monorepo-constraints.md#choose-a-declaration-configuration-context).

For a cross-package dependency that has no managed source owner, `limina graph export` classifies the checker-resolved target as an artifact edge only when it falls inside a validated output root. The directory name `dist` alone is not sufficient. An artifact edge records consumption of a built artifact. It does not represent a source `references` edge in Limina's managed graph.

For workspace packages that declare `exports`, Limina checks public entries under the resolution conditions of the relevant source config. When governed source imports those entries through a package import, `TypeScript` should resolve to a stable type entry or to a source entry supported by the checker. If the actual governed consumer occurrence resolves only to runtime `JavaScript` through that package's exports, or its checker target is missing, graph check reports the consumption issue. It does not scan unconsumed export branches or use Oxc to repair a locked checker miss.

## Dependency Graph Export

`limina graph export` emits package nodes and cross-package edges as JSON:

```sh
pnpm exec limina graph export --view all
```

Available views are:

- `--view source`: export only source edges;
- `--view artifact`: export only artifact edges;
- `--view all`: export both edge kinds.

The export is for observing package-level dependency facts that Limina can currently prove. Exported cross-package edges require non-empty names on both package manifests. Nameless packages can still be source owners, but cannot supply named export nodes; a qualifying edge involving one reports an identity error. The exported nodes and edges do not define build tasks, package-manager dependencies, or build order. Build order is still determined by the TypeScript project-reference graph and the specific executor. Published package artifacts still need to be maintained by the build, test, package-check, and release flows together.

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

## Input Topology and Dependency Graphs

The read-only input topology expands selected default entries and solution references with TypeScript config readers. It does not lock framework semantic authority or establish an executable checker graph. A complete input topology therefore proves only that this config/entry topology was consumed without input diagnostics.

Several relations must stay distinct:

| Graph view                    | Facts and limits                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native references             | User-authored TypeScript `references`; solutions establish membership. Native leaf build references must be migrated out of managed source leaves.                                   |
| Supplementary declarations    | `liminaOptions.implicitRefs`; explicit declaration relationships, subject to target, checker, and rule validation.                                                                   |
| Observed source relationships | Dependency analysis from the locked checker context. Its `complete` flag can be false while some relationships have been observed.                                                   |
| Effective generated graph     | Validated generated declaration references and typed `declaration-provider` / `framework-schedule` edges used by execution. It does not turn every observed target into a reference. |

An incomplete comparison cannot prove that an unobserved native relationship is unnecessary. Migration preserves retained explicit relationships as `implicitRefs` when comparison is unavailable, and reports the incomplete analysis; it does not treat missing evidence as an empty dependency graph. Package graph export is a separate source/artifact view.
