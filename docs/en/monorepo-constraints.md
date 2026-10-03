# Monorepo Constraints

![Limina monorepo layered boundary model](/layered-boundaries.png)

The diagram uses pnpm as a layered workspace example; package boundaries and checker scopes depend on the selected governance root and configuration.

Within Limina's configured scope, a checked source module should belong to exactly one ordinary type-checking module. For build-capable owners (`tsc`, `tsgo`, and `vue-tsc`), Limina generates and maintains declaration-output modules under `.limina/`; Astro and Svelte owners execute per leaf without declaration projection. The repository can use its own directory layout.

Generated declaration-output modules derive from user-maintained type-checking modules: each `extends` the original config, materializes the effective importer roots in `files`, clears `include`, and sets declaration output, incremental build, output directory, build cache, and project-reference options. Projection also handles relative `types` inputs and automatic `typeRoots`, and disables `rewriteRelativeImportExtensions` when necessary for declaration-only emit. The generated config inherits the source type environment through these adjustments, without promising byte-for-byte config equality or equivalent native `tsc -b` behavior.

User-authored type-checking modules need clear source ownership boundaries to determine the following relationships:

```text
Which type-checking module owns this source module?
If its owner supports declarations, which .limina declaration-output module corresponds to this type-checking module?
Which upstream declaration output does this import need to consume?
```

Other configured checks cover cross-package access, public entries, type relationships, artifact edges, and pre-publish outputs.

Source ownership, checker selection, and declaration output relate as follows:

```text
source module
  -> belongs to exactly one type-checking module
  -> has a final checker owner and separate semantic authority
  -> derives declaration output and provider references when build-capable
  -> participates in the configured source, graph, artifact, and pre-publish check scopes
```

These relationships can be checked against source code, configuration, and build output.

## Type-Checking Modules Define Source Ownership Boundaries

In Limina’s model, users maintain source-level type-checking modules, while Limina manages declaration-output modules for build-capable owners under `.limina/`.

| Module                    | Location                             | Maintainer | Purpose                                                                                                                              |
| ------------------------- | ------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Type-checking module      | User-authored `tsconfig*.json` files | User       | Describes which source files belong to the current type-checking scope and which `TypeScript` semantics should be used to check them |
| Declaration-output module | `.limina/tsconfig/.../*.dts.json`    | Limina     | Generates declaration output, incremental build settings, and generated project references based on the type-checking module         |

A declaration-output module inherits from its corresponding type-checking module. User-defined options such as `moduleResolution`, `paths`, `baseUrl`, `customConditions`, `types`, `lib`, `jsx`, and `strict` still affect how the checker understands source. The generated config makes the input and compiler-option adjustments described above. Semantic authority is locked before final checker ownership: a TypeScript-semantic config can have a `vue-tsc` build owner without having its imports reinterpreted with Vue semantics.

An ordinary type-checking module must follow this ownership rule:

```text
A source module checked by Limina may belong to only one ordinary type-checking module.
```

This unique-leaf requirement concerns implementation source. Declaration inputs (`.d.ts`, `.d.mts`, and `.d.cts`) have separate ambient-sharing and coverage rules.

Limina reports an ownership conflict when multiple ordinary type-checking modules cover the same implementation file. Declaration-provider selection and generated references depend on unique ownership.

This layout is not recommended:

```text
packages/core/tsconfig.lib.json       includes src/index.ts
packages/core/tsconfig.browser.json   also includes src/index.ts
```

Keep each implementation file in one leaf type-checking module. If several environments need aggregation, use a `tsconfig.json` that references separate leaf configs rather than overlapping their implementation file sets.

## Files Must Have a Governed Region and Clear Package Ownership First

Limina selects the config module first. Its nearest `package.json` fixes the governance root, whose own workspace declaration selects packages; without that declaration, the root package is the sole candidate. Each final activated package is an independent package island, and its root `package.json` is the owner manifest. A checked source file must first belong to one of these units. If it does not, Limina reports it as outside the activated region; if an ordinary source `tsconfig*.json` covers files owned by multiple workspace packages, Limina reports that the boundary is too broad.

Actual source ownership, effective importer roots, and the compiler Program's file set are distinct. For example, a local relative `compilerOptions.types` file can be an effective input without becoming owned source. Local effective inputs inside the governance root must still stay inside activated regions; `extends` configuration files are a separate config closure and need not become source owners.

Governance does not automatically continue through every directory below a workspace package. A nested `package.json` stops the current island by default, and a nested workspace root (`pnpm-workspace.yaml` or `package.json` with its own `workspaces`) always stops that owner's traversal. An activated child root also stops its parent's traversal, but the child still starts an independent island even when an ancestor workspace boundary exists.

`regions.extendNestedPackageScopes` can keep an eligible nested package scope inside the current region. The nested manifest must have no `name` field, no discovered workspace may identify its directory as a workspace package, and it must not be inside a nested workspace boundary. The source keeps the surrounding workspace package owner and dependency authority, while the nested manifest remains its package scope for relative imports and `#imports`.

`regions.exclude` requires every rule to name a kind. For `workspace-package` or `package-scope`, config-root-relative path globs match candidate root directories of that kind, never package names or descriptor paths. Excluding an activated parent does not cascade to unmatched activated descendants. Nested workspace roots are automatic owner-local boundaries and are not configurable exclusion candidates. Source imports into a stopped region are treated as cross-boundary access.

The third kind, `tsconfig`, takes exact `tsconfig.json` or `tsconfig.*.json` file paths, not globs or directories. It removes those config descriptors before output reading without deactivating the package. Incoming solution membership and `implicitRefs` must be updated so they do not point to a removed descriptor. See [Regions](./config/regions.md) for the complete matching and validation rules.

For example:

```text
packages/
  app/
    package.json
    tsconfig.lib.json
    src/main.ts
  ui/
    package.json
    src/Button.ts
```

If `packages/app/tsconfig.lib.json` also includes `packages/ui/src/Button.ts`, its type-checking scope crosses a workspace package boundary. Let `ui`'s config own that source, and make `app` depend on `ui` through its package name.

Limina treats the default `tsconfig.json` as a solution aggregator only when the checker-resolved file list is empty and it directly declares `references`. An explicit `files: []` expresses the empty list, while `extends` and checker-supported extensions still affect resolution. Concrete source inputs belong in leaf configs. A named config such as `tsconfig.solution.json` may satisfy TypeScript's solution semantics, but is not a supported Limina solution entry. Ordinary source leaf configs cannot declare native `references`, including an empty array: static source edges are inferred from semantic declaration-provider requirements, while real edges that static analysis cannot observe use `liminaOptions.implicitRefs`.

Import analysis, type graphs, and artifact checks use the activated package scopes and source owners selected for this run.

## Type-Checking Modules Should Not Patch Declaration Build Edges

Ordinary type-checking modules describe source-checking scopes. They should not also be responsible for patching declaration build edges.

The source config describes:

```text
Which files do I own?
Under which TypeScript / checker semantics should these files be checked?
```

It should not answer this question inside a leaf config:

```text
Which upstream declaration outputs should my declaration build reference?
```

That responsibility belongs to declaration-output modules under `.limina/`. Limina infers generated project references from TypeScript declaration providers. For real edges that static analysis cannot observe, it reads `liminaOptions.implicitRefs`.

Therefore, hand-written `references` in ordinary source leaf configs can easily mix three separate concepts:

```text
`TypeScript` native aggregate reference graph
Limina-generated project references
User-declared edge patches for dynamic or virtual relationships
```

Use the configs for these separate roles:

```text
aggregate tsconfig.json
  -> aggregates multiple type-checking modules

ordinary source tsconfig*.json
  -> describes source file sets and type-checking semantics

.limina/**/*.dts.json
  -> describes declaration output and generated project references
```

To fix source scopes, edit the user-authored `tsconfig`. For declaration-output or reference problems, inspect source options, valid `implicitRefs`, and the reported provider relationship. Regenerate `.limina` files instead of hand-editing them; report a generation defect if valid inputs cannot be projected.

## Cross-Package Access Should Go Through Public Entry Points

Cross-package relative imports bypass package names and public entries:

```ts
import { Button } from '../../ui/src/Button';
```

This import bypasses `ui`'s public entry and `app`'s dependency declaration. Declare the dependency and import through the package name:

```json [packages/app/package.json]
{
  "dependencies": {
    "@acme/ui": "workspace:*"
  }
}
```

```ts
import { Button } from '@acme/ui';
```

Limina checks whether relative imports cross the nearest `package.json` package scope. For bare package imports, it also checks whether the current workspace package scope acknowledges the dependency through `dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies`. Matching `source.importAuthority.allow` grants can make selected workspace root dependency declarations available to a specific source owner.

This distinction matters for an extended nested package scope: it inherits dependency authority from the surrounding workspace owner, but relative imports still cannot escape the nearest nested `package.json` scope. If the nested scope was not extended, or was removed with `regions.exclude`, importing it from governed source crosses the region boundary before ordinary package access rules are considered.

`#imports` follows a similar boundary. Its declaration source is the nearest package scope of the importing file. Relative targets should remain inside the package scope that declares them. If the target points to a third-party package or a workspace dependency, that dependency still needs to be authorized by the workspace package scope that owns the importing file, or it must be covered by a matching workspace root dependency grant.

Cross-package imports must follow the dependency declarations and public entries in the package manifests.

## Graph Checks Follow Consumed Exports

In a workspace, `package.json#exports` participates in the importing checker's resolution. Limina retains that occurrence's result, then uses the actual target to determine workspace ownership, source or artifact consumption, and graph rules.

For example, a package may declare both entries:

```json [packages/utility/package.json]
{
  "name": "utility",
  "type": "module",
  "exports": {
    "./a": "./src/a.ts",
    "./broken": "./src/missing.ts"
  }
}
```

If `src/a.ts` exists and a consumer imports only `utility/a`, the unused broken entry does not fail `limina graph check`. The consumed dependency still has to satisfy ownership, reference, and graph rules. If the consumer instead imports `utility/broken` and its checker cannot resolve it, graph checking fails at that import. `graph export` also reports the failure instead of silently omitting the dependency.

The consumer's checker remains authoritative for self-name imports, conditions, `paths`, ambient modules, framework sources, and declarations. Another checker profile or a runtime file hit cannot repair its failed resolution or create a source edge. Graph checking does not enumerate the package's exports or expand wildcard entries to validate a public surface. Existing declaration-reference rules, including the exclusion of `require.resolve()`, continue to apply.

Publishing has a separate subject. [Package checks](./config/package-checks.md) operate on explicitly configured output entries. Limina checks declaration consistency, including local dependency protocols and mixed exports root keys. Optional publint checks the packed artifact, including missing export targets; when publint is disabled or unavailable, that item is not checked. Optional ATTW checks runtime/type compatibility and does not change graph facts, edges, or diagnostics. Boundary checks retain their own emitted-code constraints, and [release checks](./config/release-checks.md) remain separate.

A passing graph check is not a complete publish-contract guarantee. Which public entries to retain, deprecate, or remove remains the package author's decision; unused entries may serve external consumers or compatibility needs.

## References Come from Declaration Providers, Not Import Text

Whether an import needs a TypeScript project reference depends on the declaration provider identified under the current checker and `tsconfig`.

```ts
// packages/app/src/main.ts
import { createClient } from '@acme/core';
```

If the checker resolves this to an existing `.d.ts` file from `core`, this is declaration-file consumption and does not force a source project reference. A consumed source relationship maps to a declaration-output module under `.limina` only when semantic evidence requires a declaration provider and the other managed config has a valid provider. Framework scheduling dependencies remain a separate relationship.

Resolution results affect references as follows:

| TypeScript type resolution result                     | Limina project-reference handling                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `.d.ts` / `.d.mts` / `.d.cts`                         | Treat as declaration-file consumption; do not generate a TypeScript project reference                      |
| Source code inside the current type-checking module   | Treat as an internal relationship within the current scope; do not generate a TypeScript project reference |
| Source file governed by another Limina-managed module | May generate a project reference to the target declaration-output module                                   |
| TypeScript cannot resolve it                          | Do not use Oxc to infer a project reference; emit diagnostics or let relevant checks surface the issue     |

If there is a real source edge that static analysis cannot observe, such as code generation, runtime manifests, plugin tables, or framework-generated connections, it should be declared explicitly with `liminaOptions.implicitRefs`, including a clear reason.

```json [packages/app/tsconfig.lib.json]
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],

  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../core/tsconfig.lib.json",
        "reason": "The app route manifest is generated by a build plugin and loads core after generation; there is no static import in source."
      }
    ]
  }
}
```

`implicitRefs` adds real relationships that static analysis cannot observe to the declaration build graph. Those relationships remain subject to graph rules; `implicitRefs` does not authorize violations.

## Graph Rules Must Apply to Real Imports

Some architectural boundaries cannot be expressed by package names alone. For example, browser code must not import Node built-ins, public APIs should not access internal implementations, and plugin runtime code should not depend on CLI code. Limina allows these boundaries to be encoded as graph rules and then verified against real imports.

```jsonc [packages/app/src/client/tsconfig.json]
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "include": ["./**/*.ts"],
}
```

```ts [limina.config.mts]
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    rules: {
      'runtime-client': {
        deny: {
          deps: [
            {
              name: 'node:*',
              reason: 'client runtime must stay free of Node builtin imports',
            },
          ],
        },
      },
    },
  },
});
```

An import of `node:fs` in this scope matches the deny rule selected by its `runtime-client` label. Limina reports the import as a graph-rule violation.

The check matches configured rules against imports in the labeled config's source scope.

## Declared Workspace Dependencies Should Be Reachable

Declaring another workspace package in `package.json` does not mean the dependency is still used. When `source.knip` is enabled, Limina’s source checks combine package entry points, `bin`, scripts, and explicitly configured additional entries, and use Knip-related capabilities to check the reachability of workspace dependencies and source files.

```json [packages/app/package.json]
{
  "dependencies": {
    "@acme/core": "workspace:*",
    "@acme/unused": "workspace:*"
  }
}
```

Limina can report `@acme/unused` as unused when it is not reachable from the configured entries. If generated code, runtime strings, or another path outside the tool's analysis uses it, record the ignore reason. Otherwise, remove the unused dependency.

These results are limited to the source owners, configured entries, and Knip analysis collected by Limina. They do not establish that the entire repository has no unused code.

## Artifact Relationships Are Constrained Facts in the Dependency Graph

Some imports do not point to another package’s source code. They point to build artifacts:

```ts
import { runtimeValue } from '@acme/core/runtime';
```

If `@acme/core/runtime` resolves through a public entry point into a validated output root declared by `liminaOptions.outputs` or a configured package output entry, and the target has no actual source owner, `limina graph export --view artifact` can export this relationship as an artifact edge. A directory named `dist` alone does not establish that classification; custom outputs such as `lib` are eligible. This edge comes from a real import and its preserved checker resolution, with the importing file, import specifier, and resolution result as evidence.

Exported artifact edges describe consumption and do not determine build-task ordering. To use them for orchestration, an external task system or CI pipeline must combine the graph with its own build-target configuration.

## Pre-Publish Checks Only Cover Reportable Artifact Consistency Issues

Passing source checks does not mean a published package will necessarily work. Limina’s package checks select configured output entries, read each output `package.json`, pack when the selected tools require a tarball, and run enabled publint, Are The Types Wrong, or package-boundary checks. Unconfigured outputs are not included. An absent optional analyzer can be skipped; a disabled or skipped check has not validated its subject. Installed analyzers that fail to load cause a failure instead of an optional-absence skip.

Package-boundary checks scan JavaScript files in the published output: browser-targeted output should not import Node built-ins; self-references in output should resolve to entries exposed by `exports`; non-relative external imports must be explainable by dependency declarations in the output package.

Release-consistency checks inspect the tarball for `package.json`, required files, source map files, and `sourceMappingURL` comments. They also check published dependencies for local protocols such as `workspace:`, `link:`, `file:`, or `catalog:`, and validate registry baselines or content hashes for published workspace dependencies.

These checks report problems found in tarballs, output manifests, dependency scopes, and enabled analyzers. Publishing, package-manager validation, and real consumer tests still need their own workflows.

## Constraints at a Glance

| What Limina constrains                                         | Main problem it prevents                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A source module belongs to exactly one type-checking module    | The same implementation file having multiple declaration-output providers               |
| Declaration-output modules are managed by `.limina`            | User source configuration being mixed with declaration build configuration              |
| Source files remain in the current region and have an owner    | A `tsconfig` crossing stopped regions or mixing source from multiple owners             |
| Ordinary source leaf configs do not hand-write `references`    | Manual edge patches being confused with generated project references                    |
| Cross-package access goes through public entry points          | Relative paths bypassing dependency declarations and `exports`                          |
| Bare package imports are acknowledged by manifests             | Code using a dependency that the current package does not declare                       |
| `#imports` stays within the semantics of the declaring package | Internal aliases bypassing package scopes or dependency authorization                   |
| Public entry points hit by imports are resolvable              | Type-side or runtime-side ambiguity when subpaths are used by source code               |
| Project references come from declaration providers             | Import text, dependency declarations, and TypeScript project references being conflated |
| Graph rules match real imports                                 | Browser, public API, or runtime boundaries remaining only verbal conventions            |
| Workspace dependencies are reachable                           | Long-lived unused dependencies remaining in `package.json`                              |
| Artifact edges can be exported                                 | Artifact consumption relationships being hidden inside source imports                   |
| Pre-publish checks validate artifact consistency               | Source checks passing while the tarball or output manifest still has reportable issues  |

## A Practical Troubleshooting Path

When Limina reports an issue, inspect it in this order:

```text
1. Does this package scope belong to the current run, and which workspace package owns it?
2. Is the current source file owned by exactly one ordinary type-checking module?
3. Does the current tsconfig stay inside the current governed region and one workspace owner?
4. Does an ordinary source leaf config hand-write references?
5. Does this cross-package import go through a package name and public entry point?
6. Does the current package.json declare this bare package dependency?
7. Can TypeScript confirm the declaration provider under the current checker and tsconfig?
8. If this is a real edge invisible to the static graph, does it have implicitRefs and a reason?
9. If this is artifact consumption, should it only be exported as a dependency-graph edge rather than a source project reference?
10. If this is a pre-publish issue, does it come from outDir, the tarball, dependency protocols, type entries, or boundary checks?
```

Use this sequence to locate issues in source ownership, type-checking configs, import authority, declaration graphs, artifact graphs, or published outputs. Project-specific checks may still be needed.

::: tip Summary

Limina checks the relationships described by source, configuration, and output:

```text
Code may be organized according to project needs, but source ownership, type ownership, cross-package relationships, and artifact relationships must be explainable by source code, configuration, or build output.
```

Limina checks source and checker ownership, import authorization, declaration references, artifact consumption, and reportable output issues. These checks still need TypeScript, framework checkers, bundlers, publishing workflows, and real consumer tests for their respective responsibilities.

:::
