# Built-in Tasks

Limina's built-in tasks are organized around one main line: in a TypeScript monorepo, turn source `tsconfig` files, TypeScript project references, real import relationships, and workspace package relationships into a checkable engineering graph, then run type builds, source-boundary checks, and release-phase checks on top of that graph.

This document explains how the built-in tasks are divided and how users should understand their boundaries. It does not expand every configuration field, rule detail, or CLI option.

## Understand the Default Check First

When `limina check` is run without a pipeline name, it runs five default tasks:

1. `graph:check`
2. `source:check`
3. `proof:check`
4. `checker:build`
5. `checker:typecheck`

This order is the display and recording order for results. It does not mean the default check runs these tasks serially. The default check schedules them as independent tasks; when the concurrency budget and resource locks allow it, they may run concurrently. A failed task fails the current check, but it should not be understood as inherently blocking the remaining default tasks from continuing.

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

Besides built-in tasks, pipeline steps may also be external commands. External command failure blocks subsequent steps; whether a built-in task blocks subsequent steps depends on its scheduling mode and pipeline dependency relationships.

## Task Overview

| Task                | Default check | Main concern                                                                                            | How to understand it                                                                                                                |
| ------------------- | ------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `graph:prepare`     | No            | Generates the engineering graph, declaration build configs, and related generated files under `.limina` | Materializes the generated graph; not the same as checking whether the graph satisfies rules                                        |
| `graph:check`       | Yes           | Project references, workspace imports, export resolution, graph rules, and condition domains            | Checks whether the TypeScript project reference graph is consistent with source imports and configured rules                        |
| `source:check`      | Yes           | Source ownership, package boundaries, dependency declarations, and Knip-backed source usage analysis    | Checks whether source dependency relationships can be explained by package ownership and manifests                                  |
| `proof:check`       | Yes           | Source coverage proof and `tsconfig` roles                                                              | Checks whether source enters the type-check scope governed by Limina; concrete diagnostics are defined by the implementation output |
| `checker:build`     | Yes           | Build-capable checkers                                                                                  | Calls build mode of underlying checkers, usually emitting declaration files and build info                                          |
| `checker:typecheck` | Yes           | Typecheck-only checkers                                                                                 | Calls checkers that cannot act as build graph providers, such as some framework checkers                                            |
| `package:check`     | No            | Built package artifacts                                                                                 | Runs package-shape, type-resolution, and artifact import-boundary checks on `outDir` artifacts                                      |
| `release:check`     | No            | Release-phase artifact consistency                                                                      | Supplemental pre-release checks; not a publishing system or security guarantee                                                      |

The core tasks are `graph:check`, `source:check`, `proof:check`, `checker:build`, and `checker:typecheck`. `package:check` and `release:check` are supplemental release-phase tasks. They fit well in release pipelines, but should not be overstated as Limina's core capability.

## The Generated Graph Is the Basis for Later Checks

Limina's governance is built on the generated graph. The graph comes from ordinary source `tsconfig.json` entries, source `tsconfig` files referenced by those entries, source-file import relationships, and a small amount of explicit configuration.

`checker.include` selects ordinary source-level `tsconfig.json` entries. Ordinary leaf configs should not hand-write TypeScript `references`; if a directory needs to aggregate multiple type-check environments, use the default `tsconfig.json` as an aggregator and let it point to leaf configs through `references`. Limina then generates its own declaration build graph from those source configs.

`graph:prepare` writes these relationships under `.limina`, including:

- checker build entries;
- generated declaration build `tsconfig` files;
- solution-style build aggregator configs;
- the generated manifest;
- generated configs used by source usage analysis.

Generated declaration build configs inherit from their corresponding source configs and write options suitable for declaration builds, such as `composite`, `incremental`, `declaration`, `emitDeclarationOnly`, `noEmit: false`, `rootDir`, `outDir`, and `tsBuildInfoFile`.

This is not an extension of TypeScript project references themselves. More precisely, Limina turns the question “which source relationships should enter the `references` graph” from manual judgment and handwritten maintenance into a generated result based on source imports, configuration entries, and explicit exceptions, and then verifies it through check tasks.

### Static Imports and Explicit Reference Exceptions

Most reference edges come from static imports in source. Suppose one package imports another managed source project:

```ts
import { createClient } from '@acme/core';
```

If this import resolves to source owned by another generated declaration project, the generated graph should include the corresponding project reference. That lets the underlying `tsc -b`, `vue-tsc -b`, or `tsgo -b` follow project references for incremental declaration builds.

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

`path` points to another ordinary source `tsconfig`, and `reason` is required. This configuration explains why the edge should enter the generated graph. It does not bypass all checks.

## `graph:check`: Keep the Project Reference Graph Aligned with Source Relationships

`graph:check` checks the generated graph. It does not directly replace the TypeScript compiler. It asks whether project references, source imports, workspace package relationships, and architecture rules in the current engineering graph can explain each other.

It mainly covers the following categories.

### Whether Project References Have Evidence

When managed source uses a static import to access another managed source project, the generated declaration build config should have the corresponding project reference. A missing reference prevents incremental declaration builds from correctly seeing upstream declarations.

Conversely, if a generated config contains an extra reference that has no static-import evidence and is not allowed by a rule, `graph:check` reports it. This avoids keeping stale edges in the generated graph.

If a real edge is invisible to static analysis, use `liminaOptions.implicitRefs` or an allowed graph-rule entry to explain the reason, rather than hand-writing `references` in an ordinary leaf `tsconfig`.

### Whether Workspace Package Exports Are Suitable for Source Imports

When managed source imports a workspace package export by package name, Limina tries to resolve that export. For public entries imported by source, the resolution result needs to reach a stable type entry or a source entry supported by the checker.

This means runtime artifact exports can exist. But if managed source directly imports an export that resolves only to JavaScript artifacts and has no type entry, Limina treats it as a boundary problem that needs correction.

The goal here is not to guarantee that the package can be published successfully. It is to make the source dependency graph explainable by the type graph.

### Whether Cross-Package References Have Dependency Declarations

Cross-workspace-package project references represent source-level dependencies. Both the referencing package and referenced package need clear package identities, and the referencing package must declare the referenced package in its own `package.json` dependency fields.

This rule aligns the TypeScript project reference graph with the package dependency graph. Otherwise, source already depends on another package, but the manifest does not record that relationship, making later build, check, or release impact unclear.

### Whether Graph Rules Are Violated

If a source `tsconfig` enables a graph rule through `liminaOptions.graphRules`, `graph:check` checks prohibited references or dependencies according to that label.

For example, a browser-oriented project should not depend on Node runtime modules. You can express that constraint as a graph rule and enable it from the corresponding `tsconfig`. When the rule matches, diagnostics include the reason from the rule.

Graph rules only cover relationships expressed by source and configuration. They are not a runtime sandbox and not a release security guarantee.

## `source:check`: Ensure Source Imports Can Be Explained by Package Ownership

`source:check` focuses on which workspace package a source file belongs to and whether imports in that source can be explained by that ownership relationship.

This is the same theme as the previous section: Limina wants dependency relationships in the repository to be traceable. `graph:check` views the problem through the TypeScript project reference graph; `source:check` views it through package ownership, manifests, and source imports.

### Relative Imports Must Not Cross Package Boundaries

Relative imports may only move inside the current nearest `package.json` package boundary. If an import crosses into another package directory, it should be rewritten as a package-name import and declared in the referencing package manifest.

Incorrect example:

```ts
import { helper } from '../../core/src/helper';
```

A better form is:

```ts
import { helper } from '@acme/core';
```

Then the dependency relationship appears in both source imports and `package.json`, rather than being hidden in directory-relative paths.

### Bare Package Imports Need Authorization

A bare import such as `import pMap from 'p-map'` needs to be explained by the `package.json` of the current source owner. Limina also supports limited additional authorization through `source.importAuthority.allow`: matching rules can allow imports to read the workspace root manifest, or can provide an explicit reason for a specific specifier.

Such exceptions should stay specific. They should not become a switch that lets every package read dependencies from the root. Otherwise, source ownership becomes ambiguous again.

### `#` Subpath Imports Follow Package Scope

Package imports such as `#utils/*` match `package.json#imports` from the importing file's nearest package scope. If the mapping uses a relative target, the resolved result must stay inside the declaring package scope.

An `imports` target can also be a package name, for example `{ "imports": { "#dep": "p-map" } }`. That form represents an external dependency entry and may resolve to a third-party package or a workspace dependency. Authorization still comes from the pnpm workspace source owner of the importing file, so the dependency must be declared in dependency fields or explained through a matching `source.importAuthority.allow` rule.

No matching entry reports `Unauthorized package import specifier:` and points to the nearest package scope. A match that cannot resolve reports `Unresolved package import specifier:`. A relative target that escapes the declaring package scope reports `Package import relative target escapes package scope:`. If a package target is unauthorized, Limina continues to use the dependency authorization diagnostic.

### Knip-Backed Usage Analysis Is an Auxiliary Signal

`source:check` can use Knip-backed analysis results to report two categories:

- workspace dependencies that are declared but not used by source;
- source modules unreachable from package entries, binary entries, scripts, plugin entries, or explicitly configured extra entries.

These checks are useful for finding obvious stale dependencies and dead modules, but they should not be understood as a complete runtime reachability proof. For entries loaded through generated code, runtime strings, or external tools, declare exceptions with reasons.

## `proof:check`: Confirm Source Enters Managed Check Scope

`proof:check` answers a basic question: are source files that should be governed by Limina actually covered by a checker entry, generated graph project, or allowlist?

It differs from `source:check` as follows:

- `source:check` cares whether source imports and package ownership are clear;
- `proof:check` cares whether source enters the managed type-check scope and whether `tsconfig` roles are clear.

In a monorepo using TypeScript project references, a missing source file may not immediately appear as a project-reference error. It may simply be unreachable from any checker entry. `proof:check` exposes these “unchecked” files.

If a file truly should not enter the regular check scope, use an allowlist entry with a reason rather than letting it float naturally outside the engineering graph.

This document does not list every diagnostic branch of `proof:check`. When reading diagnostics, understand it under one principle: every source file and every `tsconfig` should have a clear role; the same file should not produce duplicate or conflicting ownership inside the same check domain.

## `checker:build`: Call Build-Capable Checkers

`checker:build` calls build-capable checkers. Built-in build-capable presets in the source include:

- `tsc`
- `tsgo`
- `vue-tsc`

These checkers run in build mode, for example `tsc -b`, `tsgo -b`, or `vue-tsc -b`. The target is the checker build entry generated by Limina, not an arbitrary user-authored command.

Because generated declaration build configs enable `emitDeclarationOnly` and disable `noEmit`, `checker:build` is not a side-effect-free check. It runs the real underlying checker and may write `.d.ts`, `.tsbuildinfo`, and related outputs.

This is important: Limina does not replace TypeScript, Vue checkers, or native TypeScript build logic. It prepares and checks the engineering graph, then delegates the type build to the corresponding checker.

Before running, Limina checks whether peer dependencies required by configured checkers are resolvable. Missing dependencies fail before checker execution and include installation guidance.

## `checker:typecheck`: Call Check-Only Checkers

`checker:typecheck` targets presets whose execution kind is check-only. Built-in presets of this kind in the source include:

- `vue-tsgo`
- `svelte-check`

They run through their own commands, such as `vue-tsgo --project` or `svelte-check --tsconfig`. These tasks supplement diagnostics for framework files or secondary checkers, but do not emit declaration files.

If a project configures only build-capable checkers, `checker:typecheck` may have no real target. That should not be interpreted as missing TypeScript checking; type builds are handled by `checker:build`.

## `graph:prepare` and `graph export`

`graph:prepare` only generates or refreshes Limina engineering graph files. Tasks that consume the generated graph obtain it through a preflight mechanism before running. You usually need to call it directly only when you want to materialize generated files explicitly, verify that generated files are writable, or prepare a later named pipeline.

`graph export` exports the dependency graph collected by Limina within managed `tsconfig` scopes. It supports different views, such as source edges only, artifact edges only, or both. This graph is suitable for architecture diagnostics and external analysis, but should not be treated as the authoritative build-order source.

## `package:check`: Check Built Package Artifacts

`package:check` is not part of the default check. It targets built package output directories, not source directories.

Check tool choices that can be confirmed from source include:

- `publint`
- `attw`
- `boundary`

Therefore, it is suitable after a build as a supplemental check for package shape, type-resolution results, and artifact import boundaries. It does not run package builds and should not be described as a release security guarantee.

If a project does not yet have an artifact directory or artifact manifest, run that project's own build flow first, then run `package:check`.

## `release:check`: Supplemental Release-Phase Checks

`release:check` is also not part of the default check. It targets pre-release artifact consistency and fits at the end of a release pipeline.

The configuration boundaries visible from source show that `release:check` includes settings related to dependency artifact content-hash comparison, such as baseline tag, built-in ignore sets, and custom ignore rules. In other words, it focuses on reportable drift between release artifacts, not on replacing npm publish flow, version management, or human release review.

If you need to put `release:check` in CI, put it in the same named pipeline as the project's own build, tests, and package artifact checks, so execution order is explicit.

## Recommended Mental Model

These tasks can be grouped into three layers:

The first layer is the engineering graph layer: `graph:prepare` and `graph:check`. They answer where the current TypeScript project reference graph comes from and whether it is consistent with source import relationships.

The second layer is the source governance layer: `source:check` and `proof:check`. They answer who owns source, who authorizes imports, and which files enter the check scope.

The third layer is the execution and artifact layer: `checker:build`, `checker:typecheck`, `package:check`, and `release:check`. They answer whether underlying checkers pass, whether built artifacts expose detectable problems, and whether there are reportable inconsistencies before release.

Under this model, Limina's boundary is clearer: it is not a control plane that replaces TypeScript, framework checkers, bundlers, test frameworks, or publishing tools. It provides a set of check tasks on top of TypeScript project references and the generated engineering graph, making repository structure, dependency relationships, check scope, and release impact more predictable.
