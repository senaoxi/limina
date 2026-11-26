# Checker Configuration

When Limina checks or builds a project, it needs to know which checker handles each TypeScript config. `scope.checkers` selects the project's `tsconfig.json` entries and, when needed, assigns checkers to them.

Limina automatically finds entries in the activated [regions](./regions.md). If each source config directly declares its intended framework, you can omit `scope.checkers`. Use this field to select a checker explicitly, set the default TypeScript build checker, or exclude an automatic entry.

Limina supports these fixed names:

| Key            | When to use it                    | Generates internal declarations |
| -------------- | --------------------------------- | ------------------------------- |
| `tsc`          | TypeScript projects               | Yes                             |
| `tsgo`         | Native TypeScript builds          | Yes                             |
| `vue-tsc`      | Vue and TypeScript projects       | Yes                             |
| `svelte-check` | Type checking for Svelte projects | No                              |
| `astro`        | Type checking for Astro projects  | No                              |

The key identifies the checker, its execution tool, and its associated caches. These declaration files are internal build artifacts used by Limina. See [CLI Reference](../cli.md) for the commands.

## Automatic discovery {#automatic-discovery}

Automatic entry discovery continues when you configure named checkers. For source configs without an explicit selection, Limina reads the direct configuration triggers below. Ordinary TypeScript projects default to `tsc` for execution unless a declaration-build relationship or `auto.useTsgo` selects another build checker.

| Project                           | Typical checker |
| --------------------------------- | --------------- |
| Ordinary TypeScript               | `tsc`           |
| Project requiring Vue checking    | `vue-tsc`       |
| Project requiring Astro checking  | `astro`         |
| Project requiring Svelte checking | `svelte-check`  |

To use `tsgo` as the default for ordinary TypeScript projects, set:

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  scope: { checkers: { auto: { useTsgo: true } } },
});
```

`useTsgo` defaults to `false`. When enabled, ordinary TypeScript projects whose checker has not already been determined by a framework or declaration-build relationship default to `tsgo`. It does not change Astro or Svelte projects to `tsgo`. Install a supported `@typescript/native-preview` in the checker's execution scope first.

Limina derives the TypeScript Reference Graph using the supported host `typescript` Compiler API (5.4–6.0). `tsgo` is an independent build executor. Limina guarantees compilation relationships under that host semantic authority within its supported scope; this does not guarantee a successful type check or equivalent resolution, input membership and emit behavior in a different compiler version. If your project depends on v7-specific resolution, Limina currently cannot provide that strict semantic guarantee. Choose `tsc` when you need execution under the current host TypeScript authority.

The observed TypeScript 6.0.3 / `@typescript/native-preview` 7.0.0-dev.20260707.2 combination illustrates two boundaries:

| Trigger                                                   | Possible effect                                                                                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A relative path such as `../node_modules/../shared/index` | The compilers can select the same implementation but treat external inputs differently; tsgo may report composite file-list/root-directory errors or emit differently. |
| Versioned `typesVersions` or `types@>=6.1` branches       | Each compiler can select its own version's types, changing diagnostics or inputs. This is normal versioned type selection.                                             |

These are bounded observations, not a claim about every v7 version or an official compiler bug. Limina does not reject a build solely to prove those versions equivalent, and does not rewrite the host graph to fit tsgo. Ordinary reference governance, Checker identity and declaration constraints still apply; the selected Checker reports its actual build result. External source type changes still trigger the existing managed incremental recheck protection.

To exclude `packages/playground/tsconfig.json` only from automatic discovery, use `exclude`:

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  scope: {
    checkers: {
      auto: { exclude: ['packages/playground/tsconfig.json'] },
    },
  },
});
```

Paths and patterns are relative to `config.rootDir`. This excludes only the **automatically discovered entry**: a named checker can still select it, and another selected entry can still reach it through project references. This is different from excluding files from the expected source scope. See [Source Boundary](./source-boundary.md) to exclude source files.

If no selected entry covers the playground's source, `proof:check` may report those files as uncovered. Select an appropriate checker entry for them, or adjust the source scope if they should not be governed in this run. When changing the source scope, also check whether another selected config still includes those files.

### Framework inference

A named checker fixes the source analysis semantics for its selected config. Otherwise, Limina reads the terminal source config and counts the distinct checkers selected by its own JSONC fields.

| Distinct framework checkers in the config | Source analysis semantics | Execution checker                                                              |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| None                                      | TypeScript                | Selected later from declaration-build relationships or the TypeScript default. |
| One                                       | The selected framework    | The selected framework checker.                                                |
| More than one                             | TypeScript                | Selected later as above. The final report includes an ambiguity warning.       |

Multiple Vue settings count as one `vue-tsc` choice. Vue and Astro settings count as two. When execution is still undecided, a declaration-build relationship may require sharing `vue-tsc` with another project. Without such a requirement, `auto.useTsgo` determines whether the build uses `tsc` or `tsgo`.

The following settings express framework ownership when declared directly in the source config.

| Checker        | Direct configuration triggers                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `astro`        | An `extends` entry of `astro/tsconfigs/base`, `astro/tsconfigs/strict` or `astro/tsconfigs/strictest` (optionally `.json`), an exact `compilerOptions.types` entry of `astro/client` or `astro/env`, a `compilerOptions.plugins` entry named exactly `@astrojs/ts-plugin`, or a `files` or `include` entry ending in `.astro`. |
| `vue-tsc`      | A `vueCompilerOptions` object, including `{}`, or a `files` or `include` entry ending in `.vue`.                                                                                                                                                                                                                               |
| `svelte-check` | An `extends` entry whose final path components are `.svelte-kit/tsconfig` or `.svelte-kit/tsconfig.json`, or a `files` or `include` entry ending in `.svelte`.                                                                                                                                                                 |

If you previously relied on a component file or import to select the framework, choose a named checker or add the relevant selector to the source config. For example, keep `src/**/*` and add `src/**/*.vue` to express Vue ownership without dropping the project's other inputs. Install the [framework prerequisites](#framework-prerequisites). To include components in coverage checks, also set [the expected source scope](../getting-started.md#using-vue-astro-or-svelte).

A directly named Astro preset can select `astro` in a TypeScript-only project. An unfilled `**/*.vue` selector can select `vue-tsc`. The whole selector must end in the framework suffix. Adding a component under `**/*` or `**/*.{ts,vue}`, importing a component, or installing a framework package leaves the checker choice unchanged.

Each source config makes its own choice. A framework setting in a shared base or a solution does not select a checker for a leaf. If a leaf previously relied on an inherited trigger, declare a trigger in that leaf or select a named checker. After the choice, the selected toolchain resolves inheritance, effective options, and actual roots as usual.

Vue custom-extension inputs keep their normal discovery path even when Native TypeScript finds no roots. Their discovery does not add them to Native roots.

To choose the checker yourself, use a named selection:

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  scope: {
    checkers: {
      'vue-tsc': { include: ['apps/site/tsconfig.json'] },
    },
  },
});
```

Named selections and their terminal solution constraints take precedence. To remove an implicit choice, change the direct setting that selects it. Automatic inference has no separate global switch.

The `LIMINA_GRAPH_FRAMEWORK_INFERENCE_AMBIGUOUS` warning identifies the source config and sorted checker names, states that TypeScript semantics were retained, and explains that the local owner was pending before build coloring. Each affected source config produces one warning in the final report, including when another independent problem fails the workflow. `limina check` lists these in its final Warnings section; standalone commands print them to stderr after completion, preserving machine-readable graph JSON on stdout. The warning itself does not change admission, governance results or the command's exit status.

The warning supplies no missing compilation capability. Independently established framework input requirements, missing inputs, declaration obligations and real checker failures retain their existing diagnostics and admission rules. A uniquely inferred checker that is unavailable does not silently fall back to TypeScript. Framework discovery never adds `.vue`, `.astro`, `.svelte` or custom extensions to Native TypeScript roots.

A complete Reference Graph does not guarantee a successful type check. An explicitly selected `tsc` can finish resolving a `.vue` import without selecting a file input, so no project reference is required for that request, while the actual type check can still report `TS2307`. A physical file or another project's `vue-tsc` owner alone does not justify adding an edge. Separately established necessary framework inputs that the selected semantics cannot handle still follow admission rules.

## Choose a checker for an entry {#named-entry-constraints-and-solution-closures}

To explicitly choose an entry, use the checker name as a key. This example assumes `apps/web` is a governed workspace package and a supported `vue-tsc` is installed in the checker's execution scope. It assigns the entry to `vue-tsc`:

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  scope: {
    source: {
      include: ['...', 'apps/web/**/*.vue'],
    },
    checkers: {
      'vue-tsc': {
        include: ['apps/web/tsconfig.json'],
      },
    },
  },
});
```

`apps/web/tsconfig.json` is handled by `vue-tsc`. Entries not selected by a named rule remain subject to automatic discovery. If the web entry is an aggregator, the selection also applies to every terminal source config it references.

The example also adds Vue components under `apps/web` to `scope.source` and retains the default TypeScript scope. It does not change the `tsconfig` file list: the source config responsible for Vue must still include the components. If the checker includes them but the source scope does not, the coverage check may report a mismatch. Merge both fields into an existing config and adjust the patterns to your project.

Each named checker uses the same fields:

| Field     | Purpose                                                               |
| --------- | --------------------------------------------------------------------- |
| `include` | Required non-empty string array selecting entries for this checker.   |
| `exclude` | Optional string array removing entries from this checker's `include`. |

For example, `include: ['apps/*/tsconfig.json']` can select several app entries, and `exclude: ['apps/playground/tsconfig.json']` removes one from that checker's selection. It may still be selected by automatic discovery or another named rule. This differs from `auto.exclude`. Neither exclusion cuts valid references from an already selected entry.

Selector paths are relative to `config.rootDir`. They directly select only default-named `tsconfig.json` entries, not `tsconfig.lib.json` or `tsconfig.test.json`. Include those named configs through project references from a selected entry. Paths for external activated packages may use `../`. Selectors cannot activate a region or cross a workspace boundary.

The same direct entry cannot be selected by two different named checkers. Even when entries differ, they cannot assign different checkers to the same reachable source config. Conflicts fail graph preparation. A config that names only framework checkers is valid; there is no need to add `tsc` just to fill out the configuration.

### How an aggregator affects selection

Some `tsconfig.json` files do not directly check source. They organize other configs using `references`. This guide calls them **aggregators**; the terminal configs that contain source are **source configs**. For example:

```text
apps/web/tsconfig.json          aggregator entry
├── tsconfig.app.json           Vue source config
└── tsconfig.node.json          ordinary TypeScript source config
```

If automatic discovery selects the entry, Limina determines the checker for each source config. Assuming they do not need to share a declaration-build cache, the first can use `vue-tsc` and the second can use `tsc`. Belonging to the same aggregator does not itself require a shared checker.

If you explicitly select the aggregator through `vue-tsc.include`, as in the earlier example, both source configs must use `vue-tsc`. Explicit selection constrains the entire reference chain and is not overridden by framework config, actual files, or automatic discovery.

Limina recursively expands nested aggregators and deduplicates source configs reached more than once. A default `tsconfig.json` can directly reference a source config such as `tsconfig.node.json`. If the chain includes another aggregator, that intermediate config must also be named `tsconfig.json`, for example `tsconfig.json → packages/lib/tsconfig.json → packages/lib/tsconfig.lib.json`. A named config that declares references cannot serve as an intermediate aggregator.

A valid empty aggregator can remain in the project, but has no checker owner or build target. Running `limina checker build <config>` for it does not start a checker.

## Framework Prerequisites

Besides Limina, framework checkers and their dependencies must be available in the appropriate execution scope. This is the package scope where Limina looks for checker dependencies. If a dependency is missing, use the scope identified in the error. Versions must be within Limina's supported ranges. Installing Limina does not install these dependencies for every framework project.

- **Vue:** Install a supported `vue-tsc` in its build execution scope. For toolchain compatibility problems, see [Vue semantic import analysis](#vue-semantic-import-analysis).
- **Astro:** Each package owned by the Astro checker needs `astro`, `@astrojs/check`, `typescript`, and a previously generated `.astro/types.d.ts`. Limina runs `astro check --noSync --root <leaf> --tsconfig <source-config>`; it does not run `astro sync`. If the generated file is missing, run the project's sync step first.
- **Svelte:** Each package owned by the Svelte checker needs `svelte-check`, `svelte2tsx`, `svelte`, and `typescript`. Limina runs `svelte-check --workspace <leaf> --tsconfig <source-config>` without running SvelteKit sync, enabling incremental mode, writing a `.svelte-check` cache, or overriding the output format.

`@astrojs/check`, `vue-tsc`, `svelte-check`, `svelte2tsx`, and `@typescript/native-preview` are optional Limina peers. `typescript` is a required runtime peer. Missing framework dependencies cause an error before the corresponding checker process starts. Astro and Svelte commands and runtimes resolve from the package owning the source config; other external checkers resolve from their target's execution scope.

Astro and Svelte checkers perform type checking and do not generate declaration projects. TypeScript that also needs declaration output belongs in a separate config handled by `tsc`, `tsgo`, or `vue-tsc`. See [Workflows](../workflows.md) for execution options.

When `limina checker typecheck` has applicable targets and preparation succeeds, it reruns Astro and Svelte checks; it is not watch mode. With no such target, it records `disabled` and exits successfully. That means no applicable work, not that framework checking ran. The command still validates the workspace and prepares the graph before deciding whether targets exist, so those steps can fail first.

## Framework ownership and dependency boundaries

Keep two questions separate:

1. **How are source imports interpreted?** Limina analyzes dependencies using the project's TypeScript or framework semantics.
2. **Which checker ultimately builds or typechecks the project?** Declaration-build relationships can also affect this choice.

For example, an ordinary TypeScript project and a Vue project that need to share declaration caches can both be built by `vue-tsc`. Imports in the ordinary project still use its established TypeScript semantics.

An explicitly selected `astro` checker covers TypeScript and `.astro` files; `svelte-check` covers TypeScript and `.svelte`; `vue-tsc` covers TypeScript and Vue extensions actually recognized by the checker. Selecting one framework checker does not make it cover other frameworks' files. If a file is in the proof source scope but the responsible checker cannot handle it, `limina proof check` reports `LIMINA_PROOF_UNCOVERED_SOURCE_FILE`. The file's presence alone does not make `graph prepare` fail.

::: details When dependency analysis is uncertain

The configuration rules above determine the semantics for dependency analysis. An unrelated change such as toggling `strict` can change diagnostics while leaving the semantic checker unchanged.

Declaration dependencies can change which checker executes a build. A project's imports, the resolved targets and their execution checkers cannot change its frozen source semantics. Conflicting named selections remain errors.

Once the framework is determined, dependency resolution uses that framework's toolchain. If Limina cannot reliably resolve a dependency, identify its source location, or use the toolchain, it reports failure rather than inventing an approximate project dependency. Framework-generated imports that cannot be uniquely mapped to user source do not create source dependency relationships.

:::

For more on imports, declaration builds, and execution order, see [Import Resolution to Declaration Build Graph](../import-resolution-to-declaration-build-graph.md).

## Astro semantic import resolution

Limina uses the Astro toolchain to understand imports in `.astro` files and schedules other projects' checks or builds from actual source dependencies. For example, when `A.astro` imports `B.vue`, Astro analyzes the import in `A.astro`. The Vue toolchain is used only when analyzing `B.vue` itself.

The Astro checker does not emit declarations, but cross-project imports can still affect execution order. Imports in generated files must map reliably to user source before they can establish source dependencies. Mapping errors, ambiguity, or incompatible toolchains stop analysis with a diagnostic.

The Astro adapter supports these versions:

| Component                             | Supported versions                    |
| ------------------------------------- | ------------------------------------- |
| Astro                                 | `>=7.0.0 <8.0.0`                      |
| `@astrojs/check`                      | `>=0.9.6 <0.10.0`                     |
| `@astrojs/language-server`            | `2.16.13`                             |
| Language server's `@astrojs/compiler` | `2.13.1`                              |
| `@volar/language-core`                | `2.4.28`                              |
| `@volar/kit`                          | `2.4.28`                              |
| `@volar/typescript`                   | `2.4.28`                              |
| Project- and check-visible TypeScript | `>=5.4.0 <5.10.0` or `>=6.0.0 <6.1.0` |

Astro `7.0.0` is the supported floor, not the only supported version. Limina also checks the actual toolchain API; incompatible exports fail even when version numbers match. The runtime version check for `@astrojs/check` permits prereleases satisfying the range, such as `0.9.7-beta.1` and `0.10.0-beta.1`. The installation must also satisfy each dependency's own peer requirements.

The Astro compiler comes from the language server used by `@astrojs/check`. Limina does not depend on it directly or substitute another copy from the workspace root or project. Dependencies resolve from their owning package scopes and do not need identical physical paths. Different TypeScript installations can use different supported versions.

## Vue semantic import analysis

Limina uses the project's `vue-tsc` toolchain to analyze dependencies in `.vue` files. Because the toolchain transforms component code, an import in a report can differ from the source spelling. For example, source `<script src="./entry.ts">` may be reported as `./entry.js`, while the file and line still point to the original `.vue` file.

The Vue adapter supports these toolchain combinations:

| `vue-tsc` family | Matching `@vue/language-core` | `@volar/typescript` | TypeScript           |
| ---------------- | ----------------------------- | ------------------- | -------------------- |
| 2.2.0–2.2.12     | Same version as `vue-tsc`     | 2.4.11–2.4.28       | 5.4.x–5.9.x or 6.0.x |
| 3.2.0–3.2.4      | Same version as `vue-tsc`     | 2.4.27              | 5.4.x–5.9.x or 6.0.x |

`@vue/language-core` and `@volar/typescript` are internal `vue-tsc` dependencies; you do not need to install them separately for Limina. Limina checks the complete installed combination:

- For `Missing external checker` or `Unsupported external checker`, check that `vue-tsc` is present and supported in the execution scope.
- For `Unsupported vue-tsc toolchain`, upgrade, downgrade, or reinstall a supported `vue-tsc` in that scope to repair an incomplete or incompatible internal combination.

The Vue toolchain resolves TypeScript through `vue-tsc`; it need not be the same physical installation used by Limina itself. An unsupported toolchain causes Vue dependency analysis to fail rather than switching to approximate resolution. Standalone import APIs cannot process `.vue` files without project context.

Vue checkers and editor tools handle single-file component structure issues such as duplicate script blocks or `<script setup src>`. Limina reports source-location, resolution, and graph issues within its own dependency analysis.

## Svelte semantic dependency analysis

Limina resolves `svelte/compiler`, `svelte2tsx`, and TypeScript from the Svelte project's package and analyzes component dependencies through the transformed TypeScript representation. Only dependencies that can be reliably mapped to original component source establish project relationships. Incomplete or ambiguous source mappings cause an error.

This analysis does not load `svelte.config.js` or run preprocessors or default-language hooks. It recognizes only explicit `lang="ts"` or `lang="typescript"` as transformation input. Do not assume other preprocessing runs here. The Svelte typecheck command still runs as described above.

## Declaration dependencies and checker identity

When Limina establishes a declaration-build relationship that requires two managed projects to share a cache, the declaration provider must run before the consumer. Both must use the same build checker: `tsc`, `tsgo`, or `vue-tsc`. Consuming an existing declaration artifact does not necessarily create such a relationship; use the relationship Limina identifies.

For example, if a library already uses `vue-tsc` and a dependent project needs to share its declaration cache, Limina can use `vue-tsc` for both. If two projects that must share a cache are explicitly assigned different checkers, `limina graph prepare` fails. Review the named rules and declaration relationship instead of assigning a checker to every project mechanically.

Qualified declaration dependencies, selected declaration contexts, and valid `liminaOptions.implicitRefs` can impose this requirement. In a connected group that must share a cache, one established build checker is used for the group; with none, the `tsc` or `auto.useTsgo` default is used; conflicting established checkers cause an error. Aggregation alone does not impose this requirement.

Framework checks or builds may also require an order. These **framework scheduling relationships** can cross checker identities and do not become TypeScript project references. A cycle consisting only of framework scheduling can be scheduled as a group. A declaration dependency cycle still fails.

## Generated graph and manifest

You normally do not need to generate checker configs by hand. Limina-managed builds, typechecks, and pipelines prepare them when needed. To refresh files on disk separately, run `limina graph prepare`. It generates `.limina/manifest.json` and checker configs. Graph, source, and proof checks calculate the graph in memory.

The generated manifest records source-config checker ownership, source configs referenced by aggregators, dependencies, and execution targets. Malformed or unsupported manifests cause an error. Configs and diagnostics use the paths of the project's source configs.

Generated declaration and output configs preserve the source's selected `compilerOptions.types`, including relative paths and inherited `typeRoots`. Source and output can use different `target` values, including for `vue-tsc` projects, and default libraries may differ. Governed dependencies actually needed by the output must still be covered by output relationships. Incomplete analysis or uncovered dependencies produce a limitation and source chain instead of automatically expanding the source graph or adding source references.

An expected declaration file required by an explicit project reference can be absent before an ordered build and generated later in reference order, for example by `tsc -b`. This does not apply to arbitrary missing declarations and does not use stale output in place of source discovery. Limina does not infer a producer project, build tool, or task solely from a `.d.ts`; declare additional artifact dependencies explicitly.
