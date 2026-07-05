# Why import Cannot Directly Equal references

In a monorepo, `import`, `package.json` dependencies, and `TypeScript references` are often discussed together. They are related, but they are not the same kind of information.

When a package declares a dependency in `package.json`, it only means that the package is allowed to use another package. When a source file contains an `import`, it only means that a file uses a certain module entry. `references` are concerned with something else:

```text
During declaration builds, which upstream declaration build output should the current tsconfig consume first?
```

This is why we cannot simply say “it has already been imported, so a reference should be generated automatically”. Limina’s job is not to copy an import list into `references`; it is to determine what type declarations this import actually needs in `TypeScript` declaration builds, and who provides those declarations.

## references are not a regular dependency list

First, separate these relationships:

```text
package.json dependency: this package declares that it depends on another package
Source import: this file uses a module entry
package.json#exports: which entries this package exposes externally
tsconfig: which files belong to a type-checking scope
references: which upstream project output should be built first and consumed during declaration builds
```

They affect each other, but they cannot replace each other.

For example, declaring `@acme/core` in `dependencies` does not mean that every `tsconfig` importing `@acme/core` should reference the source build config of `core`. An entry of `@acme/core` may expose source code, already generated `.d.ts` files, or only runtime resources. For `references`, what really matters is how TypeScript, under the current `tsconfig` and checker semantics, obtains the type declarations for that entry.

In other words, `references` do not mean “who I depend on”; they mean “which upstream declaration project my declaration build needs”.

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

Here, we cannot only look at `default` pointing to `./src/index.ts`. For declaration builds, the more important question is whether `TypeScript` has already obtained `./dist/index.d.ts` through `types`. If `TypeScript`'s type resolution result under the current checker and `tsconfig` is already a `.d.ts` file, this edge is closer to declaration-file consumption. It should not be forced into a project reference merely to make the graph look more like a source dependency graph.

Now consider another import:

```ts
import { createInternalClient } from '@acme/core/internal';
```

If `TypeScript` resolves this to `packages/core/src/internal.ts`, and that file belongs to another Limina-managed source `tsconfig`, then this edge may become a declaration build `reference`. The reason is not that “the package name is the same”, nor that “this package exists in dependencies”. The reason is that the type declarations required by this import need to be provided by another source scope through declaration build output.

These two examples show that under the same package and the same dependency declaration, different entries may correspond to different engineering relationships. This is why Limina now frames the problem as determining the “declaration provider”: first determine where the type declarations come from, then decide whether a project reference is needed.

For how each resolution result (`.d.ts`, source in the current scope, source in another scope, external dependency, unresolved) maps to references, declaration-file consumption, or diagnostics, see [Import Resolution to Declaration Build Graph](./import-resolution-to-declaration-build-graph.md).

## Why Limina requires boundaries to be declared first

`TypeScript` has to serve the entire ecosystem. It cannot assume that every monorepo uses the same package structure, the same tsconfig layout, or the same bundling strategy.

A single package may contain several configs at the same time:

```text
packages/app/
  tsconfig.json
  tsconfig.lib.json
  tsconfig.test.json
  tsconfig.client.json
  tsconfig.server.json
```

These configs should not necessarily all participate in declaration builds. Test configs, browser configs, `Node` configs, and framework checker configs may have different file sets and compiler options. If TypeScript inferred `references` from imports or `package.json` dependencies by default, it would have to decide build boundaries between these configs on behalf of the user. That decision is difficult to make safe as a default semantic for all projects.

Limina narrows the scope instead. Users first declare which tsconfigs are source entries governed by Limina:

```ts [limina.config.mts]
export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        include: ['packages/*/tsconfig.json'],
      },
    },
  },
});
```

This configuration does not ask Limina to scan the entire repository and guess freely. It tells Limina:

```text
These tsconfigs are source entries that may enter the governed scope.
```

Within this scope, Limina then resolves the file set, checker capability, compiler options, and source imports for each entry. The generated `references` therefore have a clear premise: they come from type-checking boundaries already declared by the user, not from every file in the repository that happens to look like source code.

## Source type configs and declaration build configs should be separated

One important constraint in Limina is: users maintain source type configs, and Limina generates declaration build configs.

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

This reduces a common source of confusion: should an ordinary source tsconfig contain native TypeScript solution references, or tool-generated edges used to complete the dependency graph? In Limina’s model, ordinary source configs do not carry this implicit edge-completion responsibility. The declaration build graph lives under `.limina/`, and Limina generates it from relationships that can be proven.

## What Limina actually determines is the declaration provider

From a user’s perspective, references inference can be understood as the following chain:

```text
import/export in source code
  -> TypeScript type resolution under the current checker and tsconfig
  -> Determine the declaration provider
  -> Generate a reference only when the provider is another source tsconfig
```

The key point is that `references` are produced only from declaration providers that TypeScript can confirm. Oxc can help Limina quickly extract imports from source code and can also indicate, in diagnostics, where runtime resolution may have found a file. But it does not decide the `.limina` declaration build graph on behalf of TypeScript.

For the full four-branch decision rules, how each resolution result maps, and how to investigate diagnostics such as “Oxc can resolve this specifier, but TypeScript cannot”, see [Import Resolution to Declaration Build Graph](./import-resolution-to-declaration-build-graph.md).

## Edges invisible to static import analysis must be declared explicitly

Some real dependencies do not appear directly as source imports, for example:

- Imports that only appear after code generation;
- Modules connected by route tables, plugin tables, or command tables;
- Modules registered through runtime manifests;
- Dependencies produced by framework macros or compiler plugins;
- Virtual modules that are mapped to real source files only during the build phase.

These relationships may be real, but the static import graph cannot prove them. Limina should not guess them, nor should it write them into native TypeScript `references` in ordinary source tsconfigs.

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

It is not an allowlist, nor a switch to bypass rules. Later graph rules can still determine whether this edge is allowed to exist.

## Runtime Cycles Are Not Project Reference Cycles

Both ESM and CommonJS allow circular dependencies between modules. This capability belongs to the **runtime module system**: code can be loaded mutually during the execution phase, provided that both sides can accommodate the initialization order constraints imposed by circular loading.

TypeScript **project references** solve an entirely different problem. The `references` field describes which upstream project outputs should be consumed first at **build time**. When integrated into the `.limina` dependency graph, these reference relationships across different source configurations must be sortable and executable by build-time checkers. Just because a cycle is permitted at runtime does not mean it belongs across a TypeScript project reference boundary.

For example, the following source code relationship might work perfectly fine at runtime:

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

Such relationships cannot be stably executed as a TypeScript project reference graph. The issue here is not that ESM or CommonJS forbids cycles, but rather that the two source scopes have become so tightly coupled that they can no longer be sorted as independent declaration build units.

The solution is usually not to make Limina judge whether an import ultimately contributes to `.d.ts` outputs, nor to bypass checks using `paths`, dynamic string imports, or ignore rules. A more robust approach is to align the source code structure with the type-building boundaries.

### Merge Tightly Coupled Source Scopes

If two source scopes frequently invoke each other and share the same lifecycle, they are likely unfit to exist as two independent declaration build units. You should bring them back under the governance of a single source `tsconfig`.

Splitting tightly coupled source code into two mutually referencing projects is discouraged:

```text
packages/a/tsconfig.json
packages/b/tsconfig.json

a -> b
b -> a
```

A better practice is to let a single source configuration cover this entire set of tightly coupled files:

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

This way, cycles can still exist within internal source modules, but they will never cross the TypeScript project reference boundary.

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

This type of refactoring ensures a unidirectional declaration build graph and makes dependency boundaries much easier to audit.

### Move Runtime Assembly Upstream

If the cycle is caused by registration, bootstrapping, plugin assembly, or runtime glue code, you generally shouldn't let the two underlying modules import each other. A sounder approach is to have both sides expose only their capabilities and let a higher-level composition entry point wire them together.

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

This preserves runtime assembly capabilities while preventing assembly relationships from degrading into project reference cycles.

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

Limina does not treat minimizing the final `.d.ts` artifacts as the goal of generating project references. It cares more about whether the check graph is reliable, whether the declaration build order is executable, and whether source relationships can be explained by the current TypeScript configuration. Final declaration bundling, removing unexposed types, and entry optimization are better handled in a declaration bundler or a release build process.

## Why failure is necessary

If TypeScript cannot confirm the declaration provider, or if a source file is governed by multiple tsconfigs at the same time, Limina should not keep guessing.

These cases should be surfaced:

| Symptom                                              | What it more likely indicates                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| TypeScript cannot resolve the import                 | The type entry, path alias, or tsconfig resolution configuration needs to be fixed            |
| Oxc can resolve it but TypeScript cannot             | Runtime resolution and type resolution are not aligned                                        |
| The import reaches another package’s internal source | It may be bypassing the public entry                                                          |
| The import resolves to `.d.ts`                       | It is closer to declaration-file consumption and should not be forced into a source reference |
| A source file is governed by multiple tsconfigs      | File ownership is unclear                                                                     |
| A real edge is invisible to static imports           | It needs to be declared explicitly through `implicitRefs`                                     |
| A generated reference violates graph rules           | The source relationship exists, but the architecture rules do not allow it                    |

These failures are not intended to make adoption harder. They prevent uncertain relationships from being written into the declaration build graph. Once generated, `references` affect TypeScript’s build order, incremental cache, and upstream declaration consumption. For this kind of relationship, being conservative is more reliable than guessing.

## When this inference should be trusted

Limina’s references inference is more stable when a repository satisfies these conditions:

- Source tsconfig boundaries are clear;
- Each checked source file belongs to only one source type config as much as possible;
- Cross-package imports preferably go through package names and public entries;
- Type entries and runtime entries in package exports are clearly defined;
- Framework files such as Vue and Svelte are handled by their corresponding checkers;
- Real edges invisible to static analysis are declared explicitly through `implicitRefs`;
- Limina runs in CI, keeping graph generation, graph checks, and checker builds consistent.

If a repository heavily depends on cross-package relative paths, mixes tsconfig scopes, has unstable public entries, or keeps build artifacts and type entries inconsistent over time, Limina will not automatically turn these problems into a healthy architecture. It is more likely to expose the issues first, so users can decide whether to fix entries, adjust tsconfig boundaries, or declare explicit exceptions.

::: tip

Limina can generate references, but not because it simply translates import into project references.

More accurately, Limina does this:

```text
Within the user-declared governance scope,
use TypeScript type resolution under the current checker and tsconfig to determine the declaration provider,
then convert declaration relationships confirmed to be provided by another source tsconfig
into declaration build references under .limina.
```

This means references no longer depend on manually written supplemental edges, and they do not degrade into a copy of dependencies. They express only source relationships that TypeScript declaration builds actually need and that Limina can prove within the current repository boundaries.

:::
