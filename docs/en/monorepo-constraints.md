# Monorepo Constraints

In a monorepo, Limina requires clear package and type-checking ownership for implementation source before checking cross-package imports, declaration references, and artifact consumption. The directory layout is up to the project, but a leaf config cannot combine implementation files from multiple packages into its own inputs.

This page explains the constraints through common structural problems. See [Core Concepts](./concepts.md) for config roles and [Configuration Reference](./config/index.md) for exact matching rules.

## Source Leaf Configs Define Source Ownership Boundaries {#type-checking-modules-define-source-ownership-boundaries}

Users maintain source leaf configs. Limina manages declaration build configs under `.limina/` for build-capable checkers.

| Config                   | Location                             | Maintainer | Purpose                                                                                                            |
| ------------------------ | ------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| Source leaf config       | User-authored `tsconfig*.json` files | User       | Defines the files in a type-checking scope and the TypeScript semantics used to check them                         |
| Declaration build config | `.limina/tsconfig/.../*.dts.json`    | Limina     | Derives declaration output, incremental build settings, and generated project references from a source leaf config |

A declaration build config extends its source leaf config. Options such as `moduleResolution`, `paths`, `baseUrl`, `customConditions`, `types`, `lib`, `jsx`, and `strict` still affect how the checker understands source. Generated configs explicitly record effective inputs and adjust declaration output, incremental caches, relative `types`, automatic `typeRoots`, and related options; they also disable `rewriteRelativeImportExtensions` when declaration emit requires it. This inheritance does not promise equivalent native `tsc -b` behavior. Semantic authority is fixed before final checker ownership: a TypeScript-semantic config can be built by `vue-tsc` without its imports being reinterpreted as Vue.

Ordinary source leaves follow this ownership rule:

```text
A source module checked by Limina can belong to only one ordinary source leaf config.
```

This unique-leaf requirement concerns implementation source. Declaration inputs (`.d.ts`, `.d.mts`, and `.d.cts`) use separate ambient-sharing and coverage rules.

Limina reports an ownership conflict when multiple ordinary source leaves cover the same implementation file. Declaration-provider selection and generated references depend on unique source ownership.

Avoid this layout:

```text
packages/core/tsconfig.lib.json       includes src/index.ts
packages/core/tsconfig.browser.json   also includes src/index.ts
```

Assign each implementation file to one source leaf. To aggregate multiple environments, use a `tsconfig.json` that references separate leaves without overlapping their implementation file sets.

## Files Must Have a Governed Region and Clear Package Ownership First

The nearest `package.json` above the selected Limina config determines the governance root, and that root's own workspace declaration determines the package set. Each activated package supplies an independent source governance scope, with its root manifest authorizing dependencies. Without a workspace declaration, the root package is the only candidate.

For example:

```text
packages/
  app/
    package.json
    tsconfig.lib.json
    src/main.ts
  ui/
    package.json
    tsconfig.lib.json
    src/Button.ts
```

If `app/tsconfig.lib.json` also includes `ui/src/Button.ts`, it crosses the package ownership boundary. Let the `ui` config own that file and let `app` depend on it through a public package entry. A checker reading a file because of an import does not give the importer ownership of it.

By default, nested `package.json` files, nested workspace roots, and activated child packages stop traversal by the outer package. Activated children govern independently from their own roots. Eligible unnamed nested package scopes can remain in the outer region through `regions.extendNestedPackageScopes`, but their nearest package scope still constrains relative imports and `#imports`.

`regions.exclude` excludes packages, nested package scopes, or exact tsconfigs by kind. Excluding a parent does not automatically exclude independently activated descendants; excluding only a config file does not exclude source. See [Regions](./config/regions.md) for the detailed conditions.

Also distinguish source ownership, effective analysis inputs, and the checker's `Program` file set. Local relative `compilerOptions.types` can add type inputs, and `extends` can reference configs, but neither alone establishes source ownership. Local effective inputs inside the governance root must still belong to activated regions.

::: details Layered boundaries

![Limina monorepo layered boundary model](/layered-boundaries.png)

In the diagram, `Module` means a source module, `tsconfig scope` means a source config's scope, and `tsconfig build scope` corresponds to a derived build-config scope. The internal declaration configs discussed here live in `.limina`, distinct from artifacts published to `dist`. pnpm is only an example of workspace structure; whether nested package scopes in the diagram are governed also depends on actual activation and extension rules.

:::

## Source Leaves Do Not Handwrite Native references {#type-checking-modules-should-not-patch-declaration-build-edges}

Users maintain two kinds of input: leaves describe source scopes and type environments, while aggregators organize leaves with `references`. A default `tsconfig.json` is a supported Limina aggregator only when its checker-resolved file set is empty and it directly declares `references`.

An ordinary source leaf cannot directly declare native `references`, including an empty array. Limina derives declaration references under `.limina` from source relationships. `liminaOptions.implicitRefs` on a leaf supplements real requirements that static analysis cannot see.

```text
User tsconfig.json: aggregates leaf members
User tsconfig.lib.json: defines source and its type environment; may declare implicitRefs
.limina/.../*.dts.json: records internal declaration output and generated references
```

Fix source scopes in user configs. For reference problems, inspect imports, providers, and rules, then regenerate. Do not patch `.limina` files manually; report a generation defect if valid inputs cannot be projected.

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

If the checker resolves this to an existing `.d.ts` file from `core`, this is declaration-file consumption and does not force a source project reference. A consumed source relationship maps to a declaration build config under `.limina` only when semantic evidence requires a declaration provider and the other managed config has a valid provider. Framework scheduling dependencies remain a separate relationship.

Resolution results affect references as follows:

| TypeScript type resolution result                     | Limina project-reference handling                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `.d.ts` / `.d.mts` / `.d.cts`                         | Treat as declaration-file consumption; do not generate a TypeScript project reference                      |
| Source code inside the current source leaf config     | Treat as an internal relationship within the current scope; do not generate a TypeScript project reference |
| Source file governed by another Limina-managed module | May generate a project reference to the target declaration build config                                    |
| TypeScript cannot resolve it                          | Do not use Oxc to infer a project reference; emit diagnostics or let relevant checks surface the issue     |

If a real declaration-build relationship is invisible to static analysis, such as a connection created by code generation, declare it through `liminaOptions.implicitRefs` with a clear reason.

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

## Choose Where to Fix the Problem {#a-practical-troubleshooting-path}

| Problem                                               | Inputs to inspect                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A file has no owner or crosses a stopped region       | Governance root, activated packages, and `regions`                                  |
| Multiple configs own the same implementation file     | Effective file sets of the source leaves                                            |
| A leaf declares native references                     | The separate roles of aggregator membership and `implicitRefs`                      |
| Cross-package imports or undeclared dependencies      | Importer manifest, public entries, and limited root-dependency grants               |
| Declaration references are missing, denied, or cyclic | Current checker resolution, target ownership, checker identities, and graph rules   |
| Source passes but artifact checks fail                | Configured `outDir`, output manifest, packed files, and analyzers that actually ran |

See [Troubleshooting](./troubleshooting.md) for diagnostics and query commands.
