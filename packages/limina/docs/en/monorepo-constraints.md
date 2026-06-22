# Limina Constrains the Key Relationships in a Monorepo

Limina does not require every monorepo to use the same directory layout. It constrains the relationships that drift most often in large TypeScript workspaces: who owns a file, how packages access each other, whether public entries resolve, whether type relationships come from real imports, and whether built output still behaves like an installable package.

> If a relationship affects another package, the type graph, artifact consumption, or release output, Limina expects it to be explicit and aligned with the source.

You can read the constraints as a chain:

```text
source file
  | owned by which package.json
  v
source import
  | authorized by dependencies and exports
  v
type graph
  | inferred from real imports
  v
artifact edge
  | exported as a scoped architecture fact
  v
published package
    installable and resolvable by consumers
```

## Files Need Clear Package Ownership

Limina uses pnpm workspace packages to decide which source owner owns a file. Nameless workspace packages can still become source owners by path. A nested `package.json` affects package resolution, but it does not split source ownership unless pnpm reports it as a workspace package. Checked source files need an owner, and an ordinary source `tsconfig*.json` should not cover files from multiple owners.

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

If `packages/app/tsconfig.lib.json` also includes `packages/ui/src/Button.ts`, that type-checking unit crosses a package boundary. The usual fix is not to silence the diagnostic. Let `app` depend on `ui` by package name, and let `ui` own its own source config.

Default `tsconfig.json` files also have shape rules. If a default config has `references`, it should act as an aggregator with `files: []` and `references`, while source inputs and compiler options live in leaf configs. Source leaf configs should not handwrite TypeScript `references`; Limina infers static edges from real imports, and dynamic or virtual source edges belong in `liminaOptions.implicitRefs`.

## Cross-Package Access Goes Through Public Entries

Cross-package relative imports are explicitly rejected:

```ts
import { Button } from '../../ui/src/Button';
```

That import bypasses both `ui`'s public API and `app`'s dependency declaration. A steadier shape is:

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

Relative imports must stay inside the nearest `package.json` package scope. Bare package imports must also be acknowledged by the nearest pnpm workspace source owner: if source imports `p-map`, then the owner `dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies` must declare it. A matching `source.importAuthority.allow` package rule may add the workspace root `package.json` as a second declaration candidate, and specifier rules can cover project templates and aliases whose dependencies are provided elsewhere. Self imports and Node built-ins are not treated as ordinary external dependency violations.

`#imports` stay under the same boundary: `#utils/foo` must match the current source owner's own `package.json#imports`, and the resolved file must remain inside that owner or resolve to an authorized external package artifact.

## Public Exports Must Really Resolve

In a monorepo, `workspace:*` only says that the dependency comes from the workspace. It does not say whether an import reads source or built output. The dependent package's `exports` decide the entry.

```json [packages/core/package.json]
{
  "name": "@acme/core",
  "exports": {
    ".": "./src/index.ts",
    "./runtime": {
      "types": "./dist/runtime.d.ts",
      "import": "./dist/runtime.js"
    }
  }
}
```

Limina checks that public entries can be resolved by the relevant type and runtime profiles. The type side must not fall through to runtime-only JavaScript; the runtime side must not fail entirely. Pure type entries may resolve to stable declarations, and source entries may point at checker-supported source files.

The point is simple: once a package exposes a subpath, that subpath must be explainable in both the monorepo's type world and the consumer's runtime world.

## Type Relationships Come From Real Imports

Limina manages the type graph from real source imports. If one package imports another package's source entry, the type graph should carry that relationship. A graph edge without import evidence needs an explicit `implicitRefs` reason.

```ts
// packages/app/src/main.ts
import { createClient } from '@acme/core';
```

If this entry resolves to `core` source, Limina treats it as a source edge. If the entry resolves to `core` built output, Limina does not turn it into a source project reference. It exports an artifact edge scoped to the importing tsconfig domain.

This avoids two common problems: source already depends on an upstream package but the type graph does not know it, or the graph still contains stale edges no real import supports. When a real source edge is invisible to static analysis, `implicitRefs` must carry a reason so the exception remains auditable.

## Runtime Boundaries Land on Real Imports

Some architecture rules are not expressible by package name alone: browser code must not import Node built-ins, public APIs must not reach internal implementations, and plugin runtime code may need to stay away from CLI code. Limina lets you encode those boundaries as graph rules and validate them against real imports.

```jsonc [packages/app/src/client/tsconfig.json]
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "include": ["./**/*.ts"],
}
```

```js [limina.config.mjs]
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

If real source imports `node:fs`, Limina reports a runtime-boundary violation rather than treating it as a mere type or style problem.

## Declared Workspace Dependencies Should Be Reachable

Declaring another workspace package in `package.json` does not prove the dependency still needs to exist. Limina's source checks use package entries, bins, scripts, and configured extra entries to decide whether a workspace dependency is reachable.

```json [packages/app/package.json]
{
  "dependencies": {
    "@acme/core": "workspace:*",
    "@acme/unused": "workspace:*"
  }
}
```

If `@acme/unused` is not used from those entry paths, Limina can report it as an unused workspace dependency. If generated code, runtime strings, or tool-specific behavior really keep it alive, the exception should explain why. Otherwise the better fix is to delete the dependency.

## Artifact Relationships Are Scoped Graph Facts

If one package consumes another package's built output, Limina can show that relationship as part of its dependency graph export. It derives artifact edges from real imports that resolve to public built-output entries.

```ts
import { runtimeValue } from '@acme/core/runtime';
```

```json [packages/core/package.json]
{
  "exports": {
    "./runtime": {
      "types": "./dist/runtime.d.ts",
      "import": "./dist/runtime.js"
    }
  }
}
```

When that import resolves into `core/dist`, `limina graph export --view artifact` emits an artifact edge from the consumer to `core`.

That edge is scoped by the importing project's compiler options, including `compilerOptions.customConditions`. It is useful for architecture review and diagnostics. It is not an authoritative task graph, and it should not be treated as proof that any particular build schedule is correct.

## Published Packages Must Work for Consumers

Passing source checks does not prove the published package is usable. Limina's package checks inspect `outDir`: whether `exports` targets exist, type entries resolve, browser artifacts import Node capabilities, output JavaScript imports undeclared externals, and package self-imports only use exported entries.

Release checks go one step further by packing the npm tarball and validating the manifest, README, license, accidental files, missing files, source maps, local protocol leaks, and whether workspace release dependencies are safe relative to what is already published.

The constraint is plain: code that works inside the repository must still work after users install the package.

## At a Glance

| Limina constrains           | It prevents                                          |
| --------------------------- | ---------------------------------------------------- |
| Clear file ownership        | One tsconfig silently mixing multiple packages       |
| Public cross-package access | Relative paths bypassing dependencies and exports    |
| Declared bare imports       | Code using a package the manifest does not own       |
| Resolvable public exports   | Public subpaths that fail for types or runtime       |
| Import-derived type graph   | Missing references, stale edges, and dead edges      |
| Graph rules on real imports | Browser, public API, or runtime boundary leaks       |
| Reachable workspace deps    | Lingering dependencies in `package.json`             |
| Exported artifact edges     | Artifact consumption hidden from architecture review |
| Installable package output  | Healthy source with broken consumer output           |

Together, these constraints express Limina's basic stance on monorepos: organize code freely, but make cross-package relationships explicit; layer configuration, but make each layer say the same thing; collaborate inside the workspace, but publish packages that remain complete and reliable.
