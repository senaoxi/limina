# Checker Configuration

When Limina checks or builds a project, it needs to know which checker handles each TypeScript config. `scope.checkers` selects the project's `tsconfig.json` entries and, when needed, assigns checkers to them.

Most projects **do not need to configure this field**. Limina automatically finds entries in the activated [regions](./regions.md) and selects checkers based on the project's files and frameworks. Configure it when you want to change the default checker, exclude an automatically discovered entry, or explicitly choose a checker for an entry.

Limina supports these fixed names:

| Key            | When to use it                    | Generates internal declarations |
| -------------- | --------------------------------- | ------------------------------- |
| `tsc`          | TypeScript projects               | Yes                             |
| `tsgo`         | Native TypeScript builds          | Yes                             |
| `vue-tsc`      | Vue and TypeScript projects       | Yes                             |
| `svelte-check` | Type checking for Svelte projects | No                              |
| `astro`        | Type checking for Astro projects  | No                              |

The key identifies the checker, its execution tool, and its associated caches. These declaration files are internal build artifacts used by Limina. See [CLI Reference](../cli.md) for the commands.

## Automatic discovery {#auto-mode}

Automatic discovery is always enabled, even when you also configure named checkers. Ordinary TypeScript projects use `tsc` by default when no other checker is required. Limina also identifies Vue, Astro, and Svelte projects from framework configuration, actual files, and dependencies.

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

For a Vue project with custom component extensions, `vueCompilerOptions` alone is not enough. Limina also inspects the files actually resolved by the config. A custom extension prompts `vue-tsc` selection only when a matching Vue file exists.

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

Limina determines analysis semantics from explicit selection, configuration, actual files, and confirmed framework dependencies. Once determined, changing the build checker to share a declaration cache does not change how imports are interpreted.

For a project whose framework is not yet determined, Limina starts with TypeScript analysis. Only when TypeScript explicitly finds missing type evidence may Oxc help identify a physical framework source file for checker selection. Ordinary files, resources, excluded files, and files with ambiguous ownership cannot select a framework this way. Conflicting framework requirements produce an error rather than a choice based on import order.

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

The generated manifest records source-config checker ownership, source configs referenced by aggregators, dependencies, and execution targets. The current manifest is version 6; malformed or unsupported manifests cause an error. Configs and diagnostics use the paths of the project's source configs.

Generated declaration and output configs preserve the source's selected `compilerOptions.types`, including relative paths and inherited `typeRoots`. Source and output can use different `target` values, including for `vue-tsc` projects, and default libraries may differ. Governed dependencies actually needed by the output must still be covered by output relationships. Incomplete analysis or uncovered dependencies produce a limitation and source chain instead of automatically expanding the source graph or adding source references.

An expected declaration file required by an explicit project reference can be absent before an ordered build and generated later in reference order, for example by `tsc -b`. This does not apply to arbitrary missing declarations and does not use stale output in place of source discovery. Limina does not infer a producer project, build tool, or task solely from a `.d.ts`; declare additional artifact dependencies explicitly.
