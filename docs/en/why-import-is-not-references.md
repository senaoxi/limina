# Why Imports Cannot Directly Become References

In a monorepo, `import`, `package.json` dependencies, and `TypeScript references` are often discussed together. They are related, but they are not the same kind of information.

When a package declares a dependency in `package.json`, it only means that the package is allowed to use another package. When a source file contains an `import`, it only means that a file uses a certain module entry. `references` are concerned with something else:

```text
During declaration builds, which upstream declaration build output should the current tsconfig consume first?
```

Limina needs to know where the current checker gets types and whether an upstream source project must participate in the declaration build. An import list alone cannot answer either question. This article explains why the distinction matters; see [From Import Resolution to the Declaration Build Graph](./import-resolution-to-declaration-build-graph.md) for the decision process.

## references are not a regular dependency list

These relationships describe:

```text
package.json dependency: this package declares that it depends on another package
Source import: this file uses a module entry
package.json#exports: which entries this package exposes externally
tsconfig: which files belong to a type-checking scope
references: which upstream project output should be built first and consumed during declaration builds
```

They affect each other, but they cannot replace each other.

For example, declaring `@acme/core` in `dependencies` does not mean that every `tsconfig` importing `@acme/core` should reference the source build config of `core`. An entry of `@acme/core` may expose source code, already generated `.d.ts` files, or only runtime resources. Reference inference combines resolution, type evidence, and compiler relation requirements under the current `tsconfig` and checker semantics.

## A single import may have different meanings

Suppose a monorepo package exposes its entries like this:

```json [packages/core/package.json]
{
  "name": "@acme/core",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./src/index.ts"
    },
    "./internal": "./src/internal.ts"
  }
}
```

Another package imports it:

```ts
import { createClient } from '@acme/core';
```

The current checker and `tsconfig` determine which entry TypeScript resolves. If it resolves through `types` to `./dist/index.d.ts`, Limina does not generate a source project reference for that target. The `default` branch pointing to `./src/index.ts` does not change that result.

Now consider another import:

```ts
import { createInternalClient } from '@acme/core/internal';
```

If TypeScript resolves this to `packages/core/src/internal.ts` in another Limina-managed source `tsconfig`, the relationship may become a declaration build `reference`. It requires that source scope to provide declaration output; package identity or a dependency declaration alone is insufficient.

Different entries in the same package can use different declaration providers. Limina identifies that provider before deciding whether a project reference is needed.

For how each resolution result (`.d.ts`, source in the current scope, source in another scope, external dependency, unresolved) maps to references, declaration-file consumption, or diagnostics, see [Import Resolution to Declaration Build Graph](./import-resolution-to-declaration-build-graph.md).

## Why Limina requires boundaries to be declared first

Monorepos can use different package structures, tsconfig layouts, and bundling strategies. Those boundaries need to be declared in project configuration.

A single package may contain several configs at the same time:

```text
packages/app/
  tsconfig.json
  tsconfig.lib.json
  tsconfig.test.json
  tsconfig.client.json
  tsconfig.server.json
```

These configs may have different file sets and compiler options, and may not all need declaration builds. Imports and `package.json` dependencies alone do not specify which configs should participate. The checker entries and source config boundaries supply that scope.

Limina discovers default `tsconfig.json` entries inside activated package scopes and reaches source leaves through aggregator entries. Automatic discovery is already enabled; add named scopes only when a checker needs to be fixed. The key is unique ownership for each implementation file, not having every config include the whole package. See [Core Concepts](./concepts.md#aggregator-config) for entry and membership rules.

## Source type configs and declaration build configs should be separated

Users maintain source type configs; Limina generates declaration build configs.

| Config                   | Location                             | Maintainer | Purpose                                                                             |
| ------------------------ | ------------------------------------ | ---------- | ----------------------------------------------------------------------------------- |
| Source type config       | `tsconfig*.json` in user source code | User       | Describes which files belong to the current type-checking scope                     |
| Declaration build config | `.limina/tsconfig/.../*.dts.json`    | Limina     | Describes declaration build output, references, and incremental build relationships |

A user-authored source tsconfig only needs to state:

```text
Which files I govern;
Which TypeScript options should be used to check these files.
```

The `declaration`, `emitDeclarationOnly`, `outDir`, `tsBuildInfoFile`, and generated `references` needed for declaration builds are written by Limina into configs under `.limina/`.

Distinguish two kinds of `references`:

- **Aggregator membership references:** maintained by users in a default `tsconfig.json` to bring leaves into an entry. The aggregator's resolved file set must be empty.
- **Declaration build references between leaves:** written by Limina into generated configs. User source leaves cannot directly declare native `references`, even as an empty array.

## What Limina actually determines is the declaration provider

Suppose `app` needs types from `core`. They may already be provided by `core/dist/index.d.ts`, or a source leaf in `core` may need to generate declarations first. Only in the latter case is that leaf a candidate declaration provider.

Limina must also check who owns the target source, whether the config can emit declarations, whether both sides can use the same build checker, and whether graph rules allow the relationship. Only declaration-build relationships satisfying these conditions enter generated `references`.

Supported Astro / Svelte dependencies may instead need only checking order. These framework-scheduling relationships supply no declaration project and are not written as TypeScript references. See [the decision process](./import-resolution-to-declaration-build-graph.md#how-limina-decides-whether-an-import-needs-a-project-reference) for type evidence and scheduling distinctions.

## Edges invisible to static import analysis must be declared explicitly

Generated imports, route manifests, or plugin registries can contain connections that source analysis cannot currently see. Supplement them only when they form real declaration-build dependencies; ordinary runtime dependencies do not all need to become project references. Literal dynamic imports such as `import('./module.js')` already participate in analysis and are not such omissions.

Such edges should be declared explicitly through `liminaOptions.implicitRefs`:

```json [packages/app/tsconfig.lib.json]
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],

  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../core/tsconfig.lib.json",
        "reason": "The app declaration build needs core source referenced by the generated route manifest; the import is absent from the source currently analyzed."
      }
    ]
  }
}
```

`implicitRefs` means that this edge is invisible in static source imports, but the user explicitly declares it as part of the declaration build graph.

It is not an allowlist, nor a switch to bypass rules. Its path is relative to the declaring source config and must map to a governed declaration leaf. It does not supply missing resolver semantics or make unsupported virtual modules consumable. Later graph rules can still determine whether this edge is allowed.

## Runtime Cycles Are Not Project Reference Cycles

Both ESM and CommonJS allow circular dependencies between modules. This capability belongs to the **runtime module system**: code can be loaded mutually during the execution phase, provided that both sides can accommodate the initialization order constraints imposed by circular loading.

TypeScript **project references** solve an entirely different problem. The `references` field describes which upstream project outputs should be consumed first at **build time**. When integrated into the `.limina` dependency graph, these reference relationships across different source configurations must be sortable and executable by build-time checkers. Just because a cycle is permitted at runtime does not mean it belongs across a TypeScript project reference boundary.

For example, the runtime module system may permit the following relationship:

::: code-group

```ts [packages/a/src/index.ts]
import { initB } from '@repo/b';

export interface AOptions {
  value: string;
}

export function initA(options: AOptions) {
  initB();
  return options.value;
}
```

```ts [packages/b/src/index.ts]
import { initA } from '@repo/a';

export interface BOptions {
  count: number;
}

export function initB(options?: BOptions) {
  if (options) {
    initA({ value: String(options.count) });
  }
}
```

:::

If `packages/a` and `packages/b` are managed by two independent source `tsconfig` files, TypeScript resolves both imports when checking the source code. The declaration build graph generated by Limina is tailored for type-checking and incremental builds, and it conservatively generates references based on the declaration providers verified by TypeScript. Even if the final `.d.ts` artifacts do not explicitly import each other on the surface, this source-level relationship can still devolve into:

```text
generated declaration config for a -> generated declaration config for b
generated declaration config for b -> generated declaration config for a
```

These cross-config references form a declaration build cycle and cannot be ordered as independent build units.

Adjust the source structure and type-build boundaries to resolve the cycle. Avoid using `paths`, computed runtime imports, or ignore rules merely to bypass checks; Limina does not remove edges by analyzing emitted `.d.ts` output.

### Merge Tightly Coupled Source Scopes

If two source scopes frequently call each other and cannot be built independently, consider placing them under one source `tsconfig`.

Splitting tightly coupled source code into two mutually referencing projects is discouraged:

```text
packages/a/tsconfig.json
packages/b/tsconfig.json

a -> b
b -> a
```

If their package responsibilities also fit together, move both implementations into one package and let one source leaf in that package own them. Do not merely widen a config's `include` across two packages that remain independent:

```json [packages/runtime/tsconfig.json]
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/a/**/*.ts", "src/b/**/*.ts"]
}
```

```text
packages/runtime/src/a/index.ts
packages/runtime/src/b/index.ts
packages/runtime/tsconfig.json
```

The two source modules now belong to the same project, so their mutual dependency stays within that project.

### Extract Lower-Level Shared Contracts

If the cycle stems from shared types, protocols, constants, or abstractions, you should push these contents down to a lower-level `contracts` / `shared` module, allowing both sides to co-depend on it instead of depending on each other's implementation.

Instead of:

```text
@repo/a -> @repo/b
@repo/b -> @repo/a
```

Change it to:

```text
@repo/a -> @repo/contracts
@repo/b -> @repo/contracts
```

For example:

::: code-group

```ts [packages/contracts/src/metrics.ts]
export interface MetricsSink {
  record(name: string, value: number): void;
}
```

```ts [packages/a/src/app.ts]
import type { MetricsSink } from '@repo/contracts';

export function createApp(metrics: MetricsSink) {
  metrics.record('app.start', 1);
}
```

```ts [packages/b/src/metrics.ts]
import type { MetricsSink } from '@repo/contracts';

export const metrics: MetricsSink = {
  record(name, value) {
    // ...
  },
};
```

:::

In this example, both source scopes depend on `contracts` rather than each other. Other imports and explicit edges still need to be checked for cycles.

### Move Runtime Assembly to a Higher-Level Entry {#move-runtime-assembly-upstream}

For cycles caused by registration, startup, plugin assembly, or runtime wiring, move that wiring to a higher-level entry that imports both modules and calls their exposed functions.

If `a` and `b` originally depend on each other to register themselves, give that registration work to `app`:

::: code-group

```ts [packages/a/src/index.ts]
export function registerA() {
  // ...
}
```

```ts [packages/b/src/index.ts]
export function registerB() {
  // ...
}
```

```ts [packages/app/src/main.ts]
import { registerA } from '@repo/a';
import { registerB } from '@repo/b';

registerA();
registerB();
```

:::

Now, the build relationships become:

```text
app -> a
app -> b
```

Instead of:

```text
a -> b
b -> a
```

In this example, `app` performs the registration, and `a` and `b` no longer depend on each other through that registration code.

### Using explicitly maintained declaration boundaries

If one side is inherently an external declaration boundary, you can let it expose types through an explicitly maintained `.d.ts`. The generation and freshness of that declaration file are then the responsibility of the user's own build process, and Limina will not reverse-engineer it back into a source project reference.

For example:

```json [packages/b/package.json]
{
  "name": "@repo/b",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  }
}
```

If the importer resolves to `packages/b/dist/index.d.ts` under the current TypeScript configuration, this is existing declaration-file consumption. It does not need a TypeScript project reference to constrain the source declaration build of `packages/b`.

This approach fits scenarios where the declaration files of `packages/b` are maintained by a bundler, a declaration bundler, or hand-written declarations. It is not meant to hide a real source dependency that should be expressed through a source project reference.

The current reference generator does not minimize emitted `.d.ts` dependencies. Final declaration bundling and entry optimization are separate build steps. Adding explicit public types can control declaration leakage, but it does not remove a project reference while the source-derived compiler relation still exists.

## Why failure is necessary

When inferring a reference from an import, unresolved checker targets or ambiguous source ownership need to be investigated.

Common cases and their implications include:

| Symptom                                                          | What it more likely indicates                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| TypeScript cannot resolve the import                             | The type entry, path alias, or tsconfig resolution configuration needs to be fixed    |
| Consuming checker has no target for an observed workspace import | The checker cannot resolve the workspace entry under its current options              |
| The import reaches another package’s internal source             | It may be bypassing the public entry                                                  |
| The import resolves to `.d.ts`                                   | Existing declaration consumption; no reference is inferred back to the source project |
| A source file is governed by multiple tsconfigs                  | File ownership is unclear                                                             |
| A real edge is invisible to static imports                       | It needs to be declared explicitly through `implicitRefs`                             |
| A generated reference violates graph rules                       | The source relationship exists, but the architecture rules do not allow it            |
| Generated references form a cycle                                | Source relationships cross independently ordered declaration build boundaries         |

A generated declaration reference needs valid source ownership and permission under graph rules. Generated `references` affect TypeScript build order, incremental caches, and upstream declaration consumption, so their evidence and boundaries need to be checked.

## When this inference should be trusted

Check these repository conditions to understand inferred references and diagnose failures:

- Source tsconfig boundaries are clear;
- Each managed implementation file belongs to exactly one source leaf; declaration files follow separate declaration rules;
- Cross-package imports preferably go through package names and public entries;
- Type entries and runtime entries in package exports are clearly defined;
- Framework files such as Vue and Svelte are handled by their corresponding checkers;
- Real declaration edges invisible to static analysis are declared explicitly through `implicitRefs`;
- Runtime cycles stay inside one source config where appropriate, while declaration relations between configs remain orderable;
- Limina runs in CI, keeping graph generation, graph checks, and checker builds consistent.

Cross-package relative paths, overlapping tsconfig scopes, unstable public entries, and inconsistent artifacts or type entries need to be addressed separately. Use the diagnostics to decide whether to fix entries, adjust tsconfig boundaries, or declare explicit exceptions; graph generation does not repair those inputs.

Observed compiler relationships and explicit `implicitRefs` jointly form the generated graph. They do not copy `dependencies` or promise a minimal dependency graph for final `.d.ts` output. The next article explains how [resolution targets, type evidence, and compiler relation requirements](./import-resolution-to-declaration-build-graph.md) determine the result together.
