# Architecture Conformance

[Why Limina](./why.md) explains the positioning: limina operates at the architecture-conformance layer, proving whether the structure a monorepo depends on is trustworthy before downstream workflows run.

This page is the practical companion. It walks through concrete scenarios where a pnpm + TypeScript monorepo looks healthy — commands succeed, CI is green — yet the underlying graphs already disagree with each other. Each scenario shows the symptom, how limina sees it, and how to fix it.

## Workspace Exports Can Mix Source and Artifacts

Suppose you have two packages:

```text
packages/
  core/
    src/index.ts
    dist/runtime.js
    dist/runtime.d.ts
    dist/types.d.ts
    dist/index.d.ts
    package.json
  app/
    src/main.ts
    package.json
```

`app` depends on `core`:

```json
{
  "dependencies": {
    "@acme/core": "workspace:*"
  }
}
```

In `app/src/main.ts`:

```ts
import { createClient } from '@acme/core';
```

From pnpm's perspective, this is fine. `workspace:*` links the local workspace package.

Package-private `#imports` have a similar split. A relative target is private to the package scope that declares it, so it must stay inside that scope. A package target may point at a third-party package or another workspace dependency, but the importing file's pnpm workspace source owner must still authorize that dependency.

`@acme/core/package.json` may deliberately expose both source-facing and artifact-facing public entries:

```json
{
  "name": "@acme/core",
  "exports": {
    ".": "./src/index.ts",
    "./runtime": {
      "types": "./dist/runtime.d.ts",
      "import": "./dist/runtime.js"
    },
    "./types": {
      "types": "./dist/types.d.ts"
    }
  }
}
```

This is valid in limina's current model. Workspace package exports may point to source files or built artifacts. What matters is the resolved entry:

- TypeScript must resolve every public export to a stable type entry or supported source entry;
- Oxc must resolve every public export, with a declaration-only fallback when TypeScript resolves a pure `.d.ts` export;
- imports that resolve to checker-owned source entries participate in project-reference governance;
- imports that resolve to `dist` become artifact edges in the exported dependency graph.

### How limina sees this

limina first pre-resolves the exports for active checker profiles. If `@acme/core/runtime` is missing from the export map, points at a missing file, or TypeScript only reaches runtime JavaScript, graph check reports the package export before reference analysis continues.

For a source entry:

```ts
import { createClient } from '@acme/core';
```

If TypeScript resolves that entry to `packages/core/src/index.ts`, and that file is owned by `packages/core/tsconfig.lib.json`, Limina's generated app declaration build config must reference the generated core config:

```jsonc
// .limina/tsconfig/checkers/typescript/projects/packages/app/tsconfig.lib.dts.json
{
  "references": [{ "path": "../core/tsconfig.lib.dts.json" }],
}
```

For an artifact entry:

```ts
import { renderRuntime } from '@acme/core/runtime';
```

If that entry resolves into `packages/core/dist`, graph references are not required. Instead, `limina graph export --view artifact` reports an artifact edge:

```json
{
  "from": "pkg:@acme/app",
  "to": "pkg:@acme/core",
  "kind": "artifact"
}
```

### How to fix it

The fix depends on the failing layer.

- If export pre-resolution fails, fix the `exports` target, condition order, `checker.include`, or missing build output.
- If a source entry is consumed but the generated declaration graph lacks an edge, make sure both source tsconfigs are selected by `checker.include`, then run `limina graph prepare`.
- If an artifact entry is consumed, inspect the artifact view as a Limina-scoped architecture fact. Do not treat it as an authoritative build-order source.

## `tsconfig.json` Has Too Many Responsibilities

Many projects write `tsconfig.json` like this:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "outDir": "dist",
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "references": [{ "path": "../core" }],
}
```

This config is doing several things at once:

- default IDE entry;
- local typecheck;
- declaration emit;
- project reference graph;
- mixed lib + test environment.

It may be convenient in the short term, but over time it causes several problems:

1. The type environment seen by the IDE may differ from the one used by the build.
2. Test-only dependencies may enter the production declaration graph.
3. Declaration emit may include files that should not be published.
4. Project references cannot express distinct boundaries for lib, test, and tools.

limina recommends splitting these responsibilities:

```text
packages/app/
  tsconfig.json
  tsconfig.lib.json
  tsconfig.test.json
  tsconfig.tools.json
```

Limina mirrors those source configs into generated declaration leaves under `.limina/tsconfig/checkers/<checker>/projects/...`.

In a single-environment directory, `tsconfig.json` can be a leaf directly:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
  },
  "include": ["src/**/*.ts"],
}
```

In a multi-environment directory, `tsconfig.json` should be a pure aggregator:

```jsonc
{
  "files": [],
  "references": [
    { "path": "./tsconfig.lib.json" },
    { "path": "./tsconfig.test.json" },
    { "path": "./tsconfig.tools.json" },
  ],
}
```

### How limina sees this

If a `tsconfig.json` with references also contains fields such as `compilerOptions` or `include`, limina considers it not to be a pure aggregator.

limina's rule is: **a default `tsconfig.json` with references should aggregate only; it should not also behave as a leaf.**

## Client Runtime Accidentally Uses a Node API

Suppose you have a browser-side runtime:

```text
packages/app/src/client/runtime.ts
```

Someone writes:

```ts
import fs from 'node:fs';

export function loadConfig() {
  return fs.readFileSync('config.json', 'utf8');
}
```

This may typecheck in a Node environment, but this code cannot enter a browser runtime.

Traditionally, teams rely on code review to catch this. But in a monorepo, such boundaries are easy to violate, especially when shared, client, and server directories reference each other.

limina expresses architecture boundaries with labels.

```jsonc
// packages/app/src/client/tsconfig.json
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "extends": "../../../tsconfig.base.json",
  "include": ["./**/*.ts"],
}
```

Then declare the rule in `limina.config.mjs`:

```js
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

### How limina sees this

limina reports this as an architecture violation, not an ordinary TypeScript error:

```text
Denied graph access:
  rules: runtime-client
  importing project: packages/app/src/client/tsconfig.json
  file: packages/app/src/client/runtime.ts:1
  imported specifier: node:fs
  denied dependency: node:*
  reason: client runtime must stay free of Node builtin imports
```

### Suitable scenarios

This kind of rule is especially useful when:

- `runtime-client` must not depend on `runtime-node`;
- `runtime-shared` must not depend on client-only or node-only implementations;
- browser packages must not import Node built-ins;
- public API layers must not import internal packages;
- plugin runtimes must not depend on CLI-only code.

::: tip
See [Graph Rules](./config/graph-rules.md) for the full label and deny-rule syntax.
:::

## One File Is Owned by Multiple Declaration Leaves

Suppose you have:

```text
packages/core/src/index.ts
packages/core/tsconfig.lib.json
packages/core/tsconfig.tools.json
```

Both source configs include the same file:

```jsonc
{
  "include": ["src/**/*.ts"],
}
```

This means `src/index.ts` would belong to both the generated lib declaration graph and the generated tools declaration graph.

That causes several problems:

1. The same file may be checked with different compiler options.
2. Declaration emit may be duplicated.
3. The project reference graph cannot determine which leaf owns the file.
4. Runtime boundary labels may conflict.

limina requires each checker graph file to have exactly one source tsconfig owner per checker.

### How to fix it

Give different leaves different file sets:

```jsonc
// tsconfig.lib.json
{
  "include": ["src/**/*.ts"],
  "exclude": ["src/tools/**"],
}
```

```jsonc
// tsconfig.tools.json
{
  "include": ["src/tools/**/*.ts"],
}
```

Or restructure the directory:

```text
src/
  lib/
  tools/
```

so that each generated declaration build config has a more natural boundary.

## Putting It Together

A healthy monorepo through limina's eyes is not one where "all commands finish successfully." It is one where the following graphs are mutually consistent:

```text
pnpm workspace packages
        │
        ▼
package.json dependencies
        │
        ▼
workspace package exports
        │
        ▼
TypeScript / Oxc module resolution
        │
        ▼
source-owned imports and artifact imports
        │
        ▼
TypeScript project references and exported artifact edges
        │
        ▼
source files covered by checkers
        │
        ▼
built package outputs consumed by users
```

If any layer expresses a different fact, limina considers the monorepo unhealthy.

For example:

| Symptom                                                     | limina's judgment                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| workspace export cannot be resolved by TypeScript/Oxc       | Public package contract is not resolvable in the active checker/runtime profiles |
| Declared package import resolves to source but no reference | Source entry is consumed without the matching TS project edge                    |
| Import resolves to `dist`                                   | Artifact entry is consumed and should appear in graph export                     |
| Cross-package relative import                               | Bypasses package exports and the nearest package scope boundary                  |
| Project reference crosses packages without a declaration    | TS graph declares a source dependency, but package graph does not                |
| Generated declaration config has no source config           | Declaration emit has no checked source proof                                     |
| Source file is not covered by any checker                   | Green CI does not mean the file was checked                                      |
| Browser runtime imports `node:fs`                           | Runtime boundary is violated                                                     |
| dist manifest has broken exports/types                      | Source is healthy, but published artifact is unhealthy                           |
| dist import has undeclared dependency                       | Consumers may miss dependencies after installation                               |

::: tip
The source-side scenarios above are enforced by graph and source checks, artifact edges are exported by `limina graph export`, and the `dist` output-health rows are enforced by [Package Checks](./config/package-checks.md). For the full set of commands that run these layers, see [Built-in Tasks](./built-in-tasks.md).
:::
