# Why import Cannot Directly Equal references

In a monorepo, `import`, `package.json` dependencies, and `TypeScript references` are often discussed together. They are related, but they are not the same kind of information.

When a package declares a dependency in `package.json`, it only means that the package is allowed to use another package. When a source file contains an `import`, it only means that a file uses a certain module entry. `references` are concerned with something else:

```text
During declaration builds, which upstream declaration build output should the current tsconfig consume first?
```

Limina identifies the types an import needs for TypeScript declaration builds and the provider of those types. An import list alone does not establish the required `references`.

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

`references` record which upstream declaration projects the current declaration build needs.

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

Limina first activates package regions and discovers default `tsconfig.json` entries within them. Automatic ownership remains enabled; named checker `include` scopes can fix selected entry identities, while unclaimed entries use automatic discovery. For example:

```ts [limina.config.mts]
export default defineConfig({
  config: {
    checkers: {
      tsc: {
        include: ['packages/*/tsconfig.json'],
      },
    },
  },
});
```

This configuration fixes the `tsc` identity of matching default entries. It does not disable automatic discovery for other activated entries. Each selected default entry may reach ordinary named source leaves through its `references` closure. Structural package boundaries still constrain every entry and file.

Within that scope, Limina resolves effective source inputs, checker capability, compiler options, and dependency facts. Read-only input topology uses TypeScript config readers; it is not yet frozen semantic authority or an executable declaration graph. See [Concepts](./concepts.md#input-topology-and-dependency-graphs).

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

Ordinary source leaf configs do not maintain declaration build references. Limina generates those references from validated relationships in the declaration build graph under `.limina/`.

## What Limina actually determines is the declaration provider

Limina infers references through these steps:

```text
import/export in source code
  -> TypeScript type resolution under the current checker and tsconfig
  -> Determine the declaration provider
  -> Validate the compiler relation requirement, source owner, checker capability and identity, and graph policy
  -> Generate a reference to the accepted declaration provider
```

The source collector uses the owning TypeScript AST for native inputs and the official generated representation for locked framework inputs. The dependency fact keeps resolution, Program admission, existing type evidence, and compiler relation requirement separate. An absent type provider does not automatically erase a source-semantic requirement, and a concrete declaration provider may stop a new source reference. Oxc does not rescue a locked semantic miss.

For those decision rules and the current diagnostics, see [Import Resolution to Declaration Build Graph](./import-resolution-to-declaration-build-graph.md).

## Edges invisible to static import analysis must be declared explicitly

Some real dependencies do not appear directly as source imports, for example:

- Imports that only appear after code generation;
- Modules connected by route tables, plugin tables, or command tables;
- Modules registered through runtime manifests;
- Dependencies produced by framework macros or compiler plugins;
- Virtual modules that are mapped to real source files only during the build phase.

The static import graph cannot prove these relationships. Limina does not infer them or write them into native TypeScript `references` in ordinary source tsconfigs.

Such edges should be declared explicitly through `liminaOptions.implicitRefs`:

```json [packages/app/tsconfig.lib.json]
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],

  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../core/tsconfig.lib.json",
        "reason": "The app route manifest is generated by a build plugin. After generation, it loads core, but there is no static import in source code."
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
packages/a/tsconfig.dts.json -> packages/b/tsconfig.dts.json
packages/b/tsconfig.dts.json -> packages/a/tsconfig.dts.json
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

One source config can cover both sets of files:

::: code-group

```json [packages/runtime/tsconfig.json]
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/a/**/*.ts", "src/b/**/*.ts"]
}
```

:::

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

### Move Runtime Assembly Upstream

For cycles caused by registration, startup, plugin assembly, or runtime wiring, move that wiring to a higher-level entry that imports both modules and calls their exposed functions.

Instead of:

::: code-group

```ts [packages/a/src/index.ts]
import { registerB } from '@repo/b';

export function startA() {
  registerB();
}
```

```ts [packages/b/src/index.ts]
import { registerA } from '@repo/a';

export function startB() {
  registerA();
}
```

:::

Change it to:

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

If the importer resolves to `packages/b/dist/index.d.ts` under the current TypeScript configuration, this is closer to declaration-file consumption. It does not need a TypeScript project reference to constrain the source declaration build of `packages/b`.

This approach fits scenarios where the declaration files of `packages/b` are maintained by a bundler, a declaration bundler, or hand-written declarations. It is not meant to hide a real source dependency that should be expressed through a source project reference.

The current reference generator does not minimize emitted `.d.ts` dependencies. Final declaration bundling and entry optimization are separate build steps. Adding explicit public types can control declaration leakage, but it does not remove a project reference while the source-derived compiler relation still exists.

## Why failure is necessary

When inferring a reference from an import, unresolved checker targets or ambiguous source ownership need to be investigated.

Common cases and their implications include:

| Symptom                                                          | What it more likely indicates                                                                 |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| TypeScript cannot resolve the import                             | The type entry, path alias, or tsconfig resolution configuration needs to be fixed            |
| Consuming checker has no target for an observed workspace import | The checker cannot resolve the workspace entry under its current options                      |
| The import reaches another package’s internal source             | It may be bypassing the public entry                                                          |
| The import resolves to `.d.ts`                                   | It is closer to declaration-file consumption and should not be forced into a source reference |
| A source file is governed by multiple tsconfigs                  | File ownership is unclear                                                                     |
| A real edge is invisible to static imports                       | It needs to be declared explicitly through `implicitRefs`                                     |
| A generated reference violates graph rules                       | The source relationship exists, but the architecture rules do not allow it                    |
| Generated references form a cycle                                | Source relationships cross independently ordered declaration build boundaries                 |

A generated declaration reference needs valid source ownership and permission under graph rules. Generated `references` affect TypeScript build order, incremental caches, and upstream declaration consumption, so their evidence and boundaries need to be checked.

## When this inference should be trusted

Check these repository conditions to understand inferred references and diagnose failures:

- Source tsconfig boundaries are clear;
- Each checked source file belongs to only one source type config as much as possible;
- Cross-package imports preferably go through package names and public entries;
- Type entries and runtime entries in package exports are clearly defined;
- Framework files such as Vue and Svelte are handled by their corresponding checkers;
- Real declaration edges invisible to static analysis are declared explicitly through `implicitRefs`;
- Runtime cycles stay inside one source config where appropriate, while declaration relations between configs remain orderable;
- Limina runs in CI, keeping graph generation, graph checks, and checker builds consistent.

Cross-package relative paths, overlapping tsconfig scopes, unstable public entries, and inconsistent artifacts or type entries need to be addressed separately. Use the diagnostics to decide whether to fix entries, adjust tsconfig boundaries, or declare explicit exceptions; graph generation does not repair those inputs.

::: tip

Generated `references` follow validated declaration relationships.

The process is:

```text
Within the user-declared governance scope,
use TypeScript type resolution under the current checker and tsconfig to determine the declaration provider,
validate the compiler relation requirement, source ownership, checker capability and identity, and graph rules,
then convert accepted declaration relationships into build references under .limina.
```

Observed compiler relations and explicit `implicitRefs` jointly form the generated graph. They do not copy `dependencies`, and they do not claim the minimal dependency graph of final `.d.ts` output. Unobserved real declaration relationships still require explicit supplements.

:::
