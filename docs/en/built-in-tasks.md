# Built-in Tasks

Limina derives a project graph from source `tsconfig` files, project references, imports, and workspace packages. Its built-in tasks check the graph, source boundaries, and coverage, run type checkers, and inspect configured release artifacts.

This page describes each task's scope. See the configuration docs for fields, rules, and CLI options.

## Default Check {#understand-the-default-check-first}

When `limina check` is run without a pipeline name, it runs the shared `workspace:validate` preparation and five default tasks:

1. `graph:check`
2. `source:check`
3. `proof:check`
4. `checker:build`
5. `checker:typecheck`

This order is the display and recording order for results. It does not mean the default check runs these tasks serially. The default check schedules them as independent tasks; when the concurrency budget and resource locks allow it, they may run concurrently. A failed task fails the current check; other default tasks can continue.

`workspace:validate` is shared by all topology-dependent work. It must pass before source, proof, graph, checker, migration, package, release, or artifact-producing work can begin. It is recorded as a preparation and as a `LiminaCheckTaskName`, so `limina check --issues --task workspace:validate` can query its structured issues. It is injected automatically and is not a user-configurable pipeline step.

Named pipelines are different. `limina check <name>` runs according to the configured pipeline step order and is used to express explicit sequencing, such as building first and then checking artifacts.

Built-in tasks can be written directly as strings:

```js
export default defineConfig({
  pipelines: {
    release: ['graph:prepare', 'checker:build', 'package:check', 'release:check'],
  },
});
```

They can also be written as explicit objects:

```js
{ type: 'task', name: 'graph:check' }
```

Besides built-in tasks, pipeline steps may be external commands. A completed built-in task failure fails the final result but does not itself stop later ordered steps. Required preparations are different: a failed `workspace:validate` or `graph:materialize` blocks its dependent tasks. External command failure stops the remaining steps and records them as `skipped`.

## Task Overview

| Task                | Default check | Main concern                                                                                            | What it does                                                                                                   |
| ------------------- | ------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `graph:prepare`     | No            | Generates the engineering graph, declaration build configs, and related generated files under `.limina` | Materializes the generated graph; not the same as checking whether the graph satisfies rules                   |
| `graph:check`       | Yes           | Project references, workspace imports, export resolution, graph rules, and condition domains            | Checks whether the `TypeScript` project reference graph is consistent with source imports and configured rules |
| `source:check`      | Yes           | Source ownership, package boundaries, dependency declarations, and `Knip`-backed source usage analysis  | Checks whether source dependency relationships can be explained by package ownership and manifests             |
| `proof:check`       | Yes           | Source coverage, `tsconfig` roles, and framework projections                                            | Checks whether source and framework capabilities enter one consistent, executable check scope                  |
| `checker:build`     | Yes           | Build-capable checkers                                                                                  | Calls build mode of underlying checkers, usually emitting declaration files and build info                     |
| `checker:typecheck` | Yes           | Framework-owned type-config leaves                                                                      | Calls `astro` or `svelte-check` once per owned leaf without declaration output                                 |
| `package:check`     | No            | Built package artifacts                                                                                 | Runs package-shape, type-resolution, and artifact import-boundary checks on `outDir` artifacts                 |
| `release:check`     | No            | Release-phase artifact consistency                                                                      | Supplemental pre-release checks; not a publishing system or security guarantee                                 |

Tasks in this table reuse the current generation's validated workspace context. A segment containing `graph:prepare`, `checker:build`, or `checker:typecheck` also receives a shared `graph:materialize` preparation before its built-in tasks. Failed required preparation records dependent tasks as `blocked`. A workspace issue can still be persisted in `.limina/check/last-run.json`; a secondary snapshot-write failure does not replace the original validation error.

`disabled` means the task has no applicable enabled work, while `skipped` means work was not run, for example after an external command failure. Optional package analyzers also report `skipped` when absent. These states do not establish that the corresponding checks executed successfully.

Generated checker configs are protected by a canonical-workspace cross-process reader/writer lease. Managed build and typecheck processes hold a read lease while consuming those files; materialization waits for readers and publishes an in-progress marker before changing artifacts. If a writer stops partway through, readers fail closed instead of consuming a mixed tree. The next materializing writer rebuilds the complete current plan and removes obsolete owned files before readers resume. Lease waits are bounded to 30 seconds.

The default check includes `graph:check`, `source:check`, `proof:check`, `checker:build`, and `checker:typecheck`. Add `package:check` and `release:check` to a release pipeline when built artifacts need inspection.

## The Generated Graph Is the Basis for Later Checks

Limina's governance is built on the generated graph. The graph comes from ordinary source `tsconfig.json` entries, source `tsconfig` files referenced by those entries, source-file import relationships, and a small amount of explicit configuration.

Each named checker `include` selects ordinary source-level `tsconfig.json` entries. Ordinary leaf configs should not hand-write `TypeScript references`; if a directory needs to aggregate multiple type-check environments, use the default `tsconfig.json` as an aggregator and let it point to leaf configs through `references`. Limina then generates its ownership and dependency plans from those source configs.

`graph:prepare` writes these relationships under `.limina`, including:

- checker build entries;
- generated declaration build `tsconfig` files;
- supported `tsconfig.json` solution build aggregator configs;
- the generated manifest;
- generated configs used by source usage analysis.

Generated declaration build configs inherit from their corresponding source configs and write options suitable for declaration builds, such as `composite`, `incremental`, `declaration`, `emitDeclarationOnly`, `noEmit: false`, `rootDir`, `outDir`, `declarationDir`, and `tsBuildInfoFile`. The generated `outDir` and `declarationDir` are always the same Limina-managed root.

Limina derives eligible `references` from source imports, configuration entries, and explicit exceptions, then validates the generated graph through check tasks.

### Static Imports and Explicit Reference Exceptions

Most reference edges come from static imports in source. Suppose one package imports another managed source project:

```ts
import { createClient } from '@acme/core';
```

Limina analyzes each static import; the import alone does not establish that a declaration reference is needed. Limina uses the source config's frozen semantic authority and retained checker evidence to decide whether the occurrence requires a source-semantic or compiler-membership relation, then selects an eligible declaration provider. Existing declaration resolution, ambient evidence, or a runtime-resolved path alone does not automatically create a source reference. Required and allowed relations can then enter the generated declaration graph.

Some relationships cannot be expressed by static imports, such as generated files, virtual modules, or runtime conventions. In those cases, write `liminaOptions.implicitRefs` in the source `tsconfig` that declares the relationship:

```jsonc
{
  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../core/tsconfig.json",
        "reason": "Loaded by generated route manifest.",
      },
    ],
  },
}
```

`path` points to another ordinary source `tsconfig`. The required `reason` explains the relation; the declared edge still undergoes graph checks.

## graph:check: Keep the Project Reference Graph Aligned with Source Relationships

`graph:check` checks whether generated project references agree with source imports, workspace package relationships, and configured architecture rules. Compiler checks run separately.

It mainly covers the following categories.

### Whether Project References Have Evidence

When retained checker evidence requires a relation to another managed project and an eligible provider exists, the generated declaration build config should contain that reference. `graph:check` reports missing required references and checks whether generated references have inferred evidence or an explicit allowance. `liminaOptions.implicitRefs` declares otherwise unobservable relations; `allow.refs` can explain permitted extra references but does not itself create them.

Semantic authority and final checker owner have different roles. Authority fixes how the source config is interpreted; final ownership selects its checker execution lane. Build coloring or solution constraints can assign `vue-tsc` to an ordinary TypeScript config without changing its frozen TypeScript semantics.

If a real edge is invisible to static analysis, use `liminaOptions.implicitRefs` or an allowed graph-rule entry to explain the reason, rather than hand-writing `references` in an ordinary leaf `tsconfig`.

### Whether Workspace Package Exports Are Suitable for Source Imports

When managed source imports a workspace package export by package name, Limina tries to resolve that export. For public entries imported by source, the resolution result needs to reach a stable type entry or a source entry supported by the checker.

This is checked for actual imports using retained checker resolution and type evidence. A runtime-only export without usable type or supported source evidence can cause a diagnostic. Limina does not eagerly prove every public export, and the presence of a JavaScript or ambient target alone does not imply a declaration reference. An incomplete dependency collection is reported as incomplete or failed, rather than treated as an empty, successfully verified graph.

These findings concern type evidence for source dependencies; they do not establish that a package is ready to publish.

### Whether Cross-Package References Have Dependency Declarations

Cross-workspace-package project references represent source-level dependencies. Both the referencing package and referenced package need clear package identities, and the referencing package must declare the referenced package in its own `package.json` dependency fields.

This keeps the same cross-package dependency recorded in source references and the package manifest.

### Whether Graph Rules Are Violated

If a source `tsconfig` enables a graph rule through `liminaOptions.graphRules`, `graph:check` checks prohibited references or dependencies according to that label.

For example, a browser-oriented project should not depend on `Node` runtime modules. You can express that constraint as a graph rule and enable it from the corresponding `tsconfig`. When the rule matches, diagnostics include the reason from the rule.

Graph rules only cover relationships expressed by source and configuration. They are not a runtime sandbox and not a release security guarantee.

## source:check: Ensure Source Imports Can Be Explained by Package Ownership

`source:check` focuses on which workspace package a source file belongs to and whether imports in that source can be explained by that ownership relationship.

`graph:check` examines project references. `source:check` examines package ownership, manifests, and source imports.

### Relative Imports Must Not Cross Package Boundaries

Relative imports may only move inside the current nearest `package.json` package boundary. If an import crosses into another package directory, it should be rewritten as a package-name import and declared in the referencing package manifest.

Incorrect example:

```ts
import { helper } from '../../core/src/helper';
```

Use a package-name import:

```ts
import { helper } from '@acme/core';
```

Then the dependency relationship appears in both source imports and `package.json`, rather than being hidden in directory-relative paths.

### Bare Package Imports Need Authorization

A bare import such as `import pMap from 'p-map'` needs to be explained by the `package.json` of the current source owner. Limina also supports limited additional authorization through `source.importAuthority.allow`: owner-keyed grants can allow matching imports to read selected dependency declarations from the workspace root manifest.

Limit these grants to the source owners and imports that need them.

### # Subpath Imports Follow Package Scope

`package imports` such as `#utils/*` match `package.json#imports` from the importing file's nearest package scope. If the mapping uses a relative target, the resolved result must stay inside the declaring package scope.

An `imports target` can also be a package name, for example `{ "imports": { "#dep": "p-map" } }`. That form represents an external dependency entry and may resolve to a third-party package or a workspace dependency. Authorization still comes from the importing file's activated source owner, so the dependency must be declared in dependency fields or covered by a matching workspace root dependency grant.

No matching entry reports `Unauthorized package import specifier:` and points to the nearest package scope. A match that cannot resolve reports `Unresolved package import specifier:`. A relative `target` that escapes the declaring package scope reports `Package import relative target escapes package scope:`. If a `package target` is unauthorized, Limina continues to use the dependency authorization diagnostic.

### Knip-Backed Usage Analysis Is an Auxiliary Signal

When `source.knip` is explicitly enabled with `true` or an object containing `root` or `workspaces`, `source:check` can use `Knip`-backed analysis results to report two categories:

- workspace dependencies that are declared but not used by source;
- source modules unreachable from package entries, binary entries, scripts, plugin entries, or explicitly configured extra entries.

Knip findings depend on the analyzed entrypoints and do not prove complete runtime reachability. Declare exceptions with reasons for entries loaded through generated code, runtime strings, or external tools.

## proof:check: Confirm Source Enters Managed Check Scope

`proof:check` checks whether governed source files are covered by a checker entry, generated graph project, or allowlist.

It differs from `source:check` as follows:

- `source:check` cares whether source imports and package ownership are clear;
- `proof:check` cares whether source enters the managed type-check scope and whether `tsconfig` roles are clear.

In a monorepo using `TypeScript` project references, a missing source file may not immediately appear as a project-reference error. It may simply be unreachable from any checker entry. `proof:check` exposes these “unchecked” files.

For a file that should remain outside the regular check scope, add an allowlist entry with a reason.

For framework source, proof also checks that each type config has exactly one checker owner, every governed framework source belongs to that owner's effective file set, every framework target is executable from its leaf package, every solution has a consistent leaf owner, and generated declaration configs contain no `.astro` or `.svelte` inputs.

Other proof diagnostics concern source and `tsconfig` roles, including duplicate or conflicting file ownership within the same check domain.

## checker:build: Call Build-Capable Checkers

`checker:build` calls the configured build checker identities:

- `tsc`
- `tsgo`
- `vue-tsc`

These checkers run in build mode, for example `tsc -b`, `tsgo -b`, or `vue-tsc -b`. The target is the checker build entry generated by Limina, not an arbitrary user-authored command.

Because generated declaration build configs enable `emitDeclarationOnly` and disable `noEmit`, `checker:build` is not a side-effect-free check. It runs the real underlying checker and may write `.d.ts`, `.tsbuildinfo`, and related outputs.

Limina prepares and checks the graph, then delegates the type build to the selected checker.

Before running, Limina checks whether `peer dependency` packages required by configured checkers are resolvable. Missing dependencies fail before checker execution and include installation guidance.

## checker:typecheck: Run Framework-Owned Leaves

`checker:typecheck` runs each type config whose final owner is `astro` or `svelte-check`, deduplicated by normalized config path. A leaf executes exactly one of `astro check --noSync --root <leaf> --tsconfig <config>` or `svelte-check --workspace <leaf> --tsconfig <config>`; it cannot be targeted by both checkers. Solution configs are expanded by Limina and are not passed to framework checkers as recursive execution targets. These tasks do not emit declaration files.

Framework targets resolve their dependencies from the leaf package. Astro requires `astro`, `@astrojs/check`, `typescript`, and an existing `.astro/types.d.ts`; Svelte requires `svelte-check`, `svelte2tsx`, `svelte`, and `typescript`. Limina never runs `astro sync`, never enables a Svelte checker cache, and does not accept `--watch` for this command. Rerun the whole command after source config, parser dependency, generated type, or framework source changes.

Workspace validation and generated-artifact materialization, including the revision read lease, happen before the no-target result. If no managed type config belongs to `astro` or `svelte-check`, `checker:typecheck` is recorded as disabled and exits successfully without checker peer preflight or execution; build-capable owners remain the responsibility of `checker:build`.

## graph:prepare and graph export

`graph:prepare` validates workspace and graph inputs, computes the plan, and materializes its files. It does not run `graph:check` governance rules or invoke the compiler. Tasks that consume generated files prepare them automatically; run it separately when you need to inspect or refresh files on disk.

`graph export` exports the dependency graph collected by Limina within managed `tsconfig` scopes. It supports different views, such as source edges only, artifact edges only, or both. This graph is suitable for architecture diagnostics and external analysis, but should not be treated as the authoritative build-order source.

## package:check: Check Built Package Artifacts

`package:check` is not part of the default check. It targets built package output directories, not source directories.

Available checks are:

- `publint`
- `attw`
- `boundary`

Run it after the project build to inspect package structure, type resolution, and artifact import boundaries. It does not build packages or establish release safety.

If a project does not yet have an artifact directory or artifact manifest, run that project's own build flow first, then run `package:check`.

## release:check: Supplemental Release-Phase Checks

`release:check` is also not part of the default check. It targets pre-release artifact consistency and fits at the end of a release pipeline.

`release:check` compares dependency artifact content using a baseline tag, built-in ignore sets, and custom ignore rules. These findings describe artifact differences; publishing, version management, and release review remain separate steps.

If you need to put `release:check` in `CI`, put it in the same named pipeline as the project's own build, tests, and package artifact checks, so execution order is explicit.

## Task Groups {#recommended-mental-model}

The tasks fall into three groups:

`graph:prepare` and `graph:check` generate project references and check them against source imports.

`source:check` and `proof:check` check source ownership, import authorization, and file coverage.

`checker:build` and `checker:typecheck` run type checkers. `package:check` and `release:check` inspect built artifacts for package and release issues.

Limina supplies these checks and delegates type checking to the selected compiler or framework checker. The project's own commands handle bundling, tests, and publishing.
