Here is the English version of the uploaded article.

# A Healthy Monorepo Through limina’s Eyes

## How limina differs from Nx / Turborepo

`limina`, Nx, and Turborepo all belong to the category of monorepo tooling, but they operate at different layers of the problem.

Nx and Turborepo primarily solve problems at the **task execution layer**: in a monorepo, which projects need to run which tasks, what order those tasks should run in, which tasks can run in parallel, which results can be cached, and how CI can run faster. Nx’s official documentation describes its task capabilities as running multiple targets across multiple projects in parallel, defining task pipelines, running only the projects affected by changes, and accelerating task execution through caching. Turborepo likewise focuses on automatic parallelization, task caching, and filtering tasks by directory, package, or source-control changes.

`limina` solves problems at the **architecture conformance layer**: before those tasks run, can the repository structure itself be trusted?

In other words:

```text
Nx / Turborepo:
  In this monorepo, which tasks should run? How can they run faster?

limina:
  Do the TypeScript source graph, package dependency graph, project references,
  package exports, runtime boundaries, and published artifacts all express
  the same facts?
```

For example, suppose `packages/app` depends on `packages/core`:

```json
{
  "dependencies": {
    "@acme/core": "workspace:*"
  }
}
```

Nx / Turborepo can help you decide:

```text
Should @acme/core build run before app build?
Is app test affected by changes in @acme/core?
Can the @acme/core build output be reused from cache?
```

These capabilities are important. Nx’s documentation explains that Nx uses project dependencies and task pipeline configuration to ensure tasks run in the correct order while still running in parallel where possible. Turborepo’s cache mechanism generates fingerprints from task inputs and restores task outputs when the cache is hit.

But these tools usually do not answer questions like these:

```text
@acme/core is declared as workspace:* — is it actually consumed as a source dependency?
Did TypeScript resolve to packages/core/src/index.ts?
Or did it resolve to packages/core/dist/index.d.ts?

Does app's tsconfig reference @acme/core's declaration leaf?
Does @acme/core's tsconfig.lib.dts.json have a strict tsconfig.lib.json companion?
Did app bypass package exports by importing ../../core/src directly across package boundaries?
Is @acme/core's dist/package.json actually usable by consumers?
```

These are the problems limina cares about.

A more precise positioning is therefore:

```text
Nx / Turborepo are monorepo task orchestration layers.
limina is a TypeScript monorepo architecture conformance layer.
```

They are not mutually exclusive. A project can use Nx / Turborepo and limina together:

```json [package.json]
{
  "scripts": {
    "build": "turbo build",
    "test": "turbo test",
    "typecheck": "limina check typecheck",
    "prepublishOnly": "limina check publish"
  }
}
```

In this combination:

```text
Nx / Turborepo are responsible for:
  - task orchestration
  - affected execution
  - parallel execution
  - local / remote caching
  - CI acceleration

limina is responsible for:
  - whether workspace:* really means a source dependency
  - whether package imports are authorized by the nearest package.json
  - whether project references match real imports
  - whether tsconfig*.dts.json files have strict companions
  - whether source files are covered by checkers
  - whether client / shared / node runtime boundaries are violated
  - whether dist published artifacts are usable by consumers
```

Nx itself also provides module boundary and conformance capabilities, for example by declaring dependency constraints through project tags and enforcing those boundaries through an ESLint rule or Nx Conformance. The difference between limina and those capabilities is that limina’s rules are not generic tag-level project dependency policies. Instead, limina focuses specifically on structural consistency problems in **pnpm + TypeScript package monorepos**, including `workspace:*` protocol semantics, the TypeScript declaration graph, local typecheck companions, package exports resolving into the source graph, and published artifact boundaries.

So you can think of it this way:

```text id="fy541j"
Nx module boundaries are more like:
  "Can a project tagged A depend on a project tagged B?"

limina is more like:
  "Is this dependency consistent across package.json, tsconfig references,
   TypeScript module resolution, source file ownership, and dist package exports?"
```

This is also why limina should not be described merely as “not a builder” or “not a replacement for tsc.” A better description is:

> limina is an architecture conformance tool for pnpm + TypeScript monorepos. It complements task execution layer tools like Nx / Turborepo and focuses on checking whether the monorepo structure is healthy, provable, and publishable.

---

## Why monorepos need architecture conformance

The complexity of a monorepo does not come only from “having many projects.” The real danger is that **the same dependency relationship is expressed repeatedly across multiple systems**.

In a TypeScript package monorepo, at least the following graphs coexist:

```text id="ejf3wn"
pnpm workspace graph
package.json dependency graph
TypeScript project reference graph
TypeScript module resolution graph
package exports graph
source file ownership graph
runtime boundary graph
published artifact graph
```

As soon as these graphs express inconsistent facts, the repository enters a dangerous state: it may work locally and pass CI, while the structure has already started to decay.

### Scenario 1: The package graph says “source dependency,” but TypeScript resolves to artifacts

In `package.json`:

```json id="mx9jsq"
{
  "dependencies": {
    "@acme/core": "workspace:*"
  }
}
```

In limina’s model, `workspace:*` means a source dependency. A source dependency should enter the TypeScript project graph and be expressed through project references.

But `@acme/core` may define exports like this:

```json id="p18vyi"
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

So TypeScript actually resolves to:

```text id="u68r4s"
packages/core/dist/index.d.ts
```

instead of:

```text id="jq12ya"
packages/core/src/index.ts
```

At this point, a task execution tool can still run `build`, `test`, and `typecheck` normally, and may even cache the results. But limina considers this monorepo unhealthy: `workspace:*` declares a source dependency, while TypeScript is actually using an artifact dependency. limina’s README explicitly distinguishes source dependencies from artifact dependencies: `workspace:*` is treated as a source dependency, while `link:`, `file:`, `catalog:`, or plain semver are treated as artifact dependencies.

What is needed here is not “running tasks faster,” but architecture conformance: proving that `package.json`, project references, and module resolution agree on whether this dependency is source or artifact.

### Scenario 2: The TypeScript project reference graph and the real import graph disagree

Suppose `app` contains:

```ts id="pr21rt"
import { createClient } from '@acme/core';
```

But `packages/app/tsconfig.lib.dts.json` does not reference `packages/core/tsconfig.lib.dts.json`.

TypeScript may still pass because it might find type files through package exports, paths, or `node_modules`. But from an engineering graph perspective, this is unhealthy: a real source import creates a cross-package dependency, while project references fail to express it.

limina’s graph check exists precisely to verify that project references and real cross-project imports are consistent. The README describes this as checking reachable TypeScript declaration leaves, references, graph-owned imports, package boundaries, and label-based deny rules.

Without conformance, this kind of issue usually surfaces only during refactoring, incremental builds, publishing, or after consumers install the package.

### Scenario 3: Cross-package relative imports bypass package exports

Code may contain:

```ts id="o1q8q1"
import { createClient } from '../../core/src/client';
```

This often works inside the monorepo, but it bypasses `@acme/core`’s public exports and the dependency relationship that should be declared in `packages/app/package.json`.

This is not a problem a task runner can solve. Tasks can run quickly, but running quickly does not mean the structure is correct.

limina expects workspace packages to depend on each other through package exports, not by piercing package boundaries with relative paths. It treats this as a cross-package boundary violation.

### Scenario 4: Declaration files are generated, but the source was not checked with equal strictness

A `tsconfig.lib.dts.json` may successfully emit `.d.ts` files:

```jsonc id="trmq2d"
{
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "emitDeclarationOnly": true,
    "outDir": "dist",
  },
  "include": ["src/**/*.ts"],
}
```

But if it does not have a corresponding `tsconfig.lib.json`, or if the two configs have inconsistent file sets or strictness semantics, then the generated declarations do not prove that the source was strictly typechecked.

limina’s document model requires declaration leaves to have strict local companions. For example, `tsconfig.lib.dts.json` corresponds to `tsconfig.lib.json`, and `tsconfig.dts.json` corresponds to `tsconfig.json`. This is the meaning of conformance: it does not merely check whether artifacts exist, but proves that artifacts came from correctly checked source.

### Scenario 5: CI is green, but some source files were never checked

In monorepos, it is common for newly added files to be excluded from all `include` patterns, all framework checkers, and the declaration graph.

A green CI does not necessarily mean the file is correct. It may simply mean no task ever saw the file.

limina’s typecheck coverage proof verifies that files within the source boundary are covered by checker entries or an allowlist. The README describes this as verifying that reachable declaration leaves match strict local typecheck companions, and that source files are covered by checker entries or an allowlist.

This is the difference between architecture conformance and ordinary task execution:

```text id="mzmtsn"
Ordinary typecheck:
  Do the files already included in tsconfig pass?

Architecture conformance:
  Are the files that should be checked actually included in some checker?
```

### Scenario 6: The source graph is healthy, but the published package is broken

Passing source checks does not mean npm consumers can use the package successfully.

For example:

```text id="tm0cmz"
packages/core/src/index.ts       works
packages/core/dist/index.js      works
packages/core/dist/package.json  has broken exports / types
```

This problem is not fully covered by the source-level project graph, because consumers install the package from `dist`.

limina therefore separates source graph checks, package artifact checks, and release hygiene checks. The README explicitly says that source graph checks do not prove that an installed package is usable by consumers; `limina package check` checks the manifest, exports, type resolution, and runtime imports under built package outputs, while `limina release check` owns npm tarball hygiene and publish dependency consistency.

This is why publishing needs `package:check` and `release:check`, not just `typecheck`.

---

## What architecture conformance guarantees

The goal of architecture conformance is not to add rules for the sake of rules. Its goal is to prevent a monorepo from entering a state where multiple conflicting truths coexist.

In a healthy pnpm + TypeScript monorepo, the same dependency should be consistent across multiple layers:

```text id="h8idlj"
package.json:
  @acme/app depends on @acme/core via workspace:*

tsconfig references:
  app's declaration leaf references core's declaration leaf

TypeScript module resolution:
  @acme/core resolves to source graph owned files, not stale dist files

package exports:
  imports go through declared public entrypoints

source ownership:
  files stay inside their nearest package.json owner

runtime rules:
  client code does not import node:* or node-only projects

dist package:
  published package exports/types/runtime imports work for consumers
```

limina’s job is to turn these consistency requirements into executable checks.

Top-level `strict: true` asks Limina to treat this model as mandatory instead of advisory compatibility behavior. In that mode, ordinary `tsconfig*.json` leaves must have same-named `tsconfig*.dts.json` build leaves, source ownership must resolve to the nearest `package.json`, `workspace:` package exports must enter the source graph, `link:`/artifact dependencies must not keep cross-package project references, and built or packed manifests must already be valid npm package manifests without pnpm-local dependency protocols.

You can understand it with this formula:

```text id="dk29fb"
task runner answers:
  Can we run this efficiently?

architecture conformance answers:
  Is the thing we are running structurally meaningful and safe?
```

So monorepos need architecture conformance not because `tsc` is not good enough, and not because Nx / Turborepo are not powerful enough. They need it because large TypeScript workspaces have a class of problems that are not “execution efficiency” problems.

They are “structural truth” problems:

```text id="g4j5vo"
Is this dependency a source dependency or an artifact dependency?
Is this import authorized by package.json?
Does this project reference reflect a real import?
Does this declaration come from strictly checked source?
Is this file actually covered by any checker?
Does this runtime cross the client/node boundary?
Is this dist output truly an installable package for consumers?
```

These are the problems limina solves.

[1]: https://nx.dev/features/run-tasks 'Run Tasks | Nx'
[2]: https://turbo.build/repo/docs/core-concepts/monorepos/running-tasks 'Running tasks'
[3]: https://turbo.build/repo/docs/crafting-your-repository/caching 'Caching'
[4]: https://nx.dev/features/enforce-module-boundaries 'Enforce Module Boundaries | Nx'

---

`limina` is an architecture governance tool for pnpm + TypeScript monorepos.

It operates in the same problem domain as monorepo tools such as Nx, Turborepo, and Rush, but approaches the problem from a different angle: Nx focuses more on task orchestration, affected execution, caching, and CI acceleration; limina focuses more on whether the monorepo structure itself is healthy, especially whether TypeScript project references, `workspace:*` source dependencies, package exports, source coverage proofs, and published artifact boundaries are consistent.

In other words:

> Nx makes monorepo tasks run more efficiently; limina makes the monorepo structure those tasks depend on more trustworthy.

The following concrete scenarios explain what limina checks.

## Use Case 1: `workspace:*` looks like a source dependency, but TypeScript actually resolves to `dist`

Suppose you have two packages:

```text
packages/
  core/
    src/index.ts
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

From pnpm’s perspective, this is fine. `workspace:*` links the local workspace package.

The problem is that `@acme/core/package.json` may be written like this:

```json
{
  "name": "@acme/core",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

This means that when TypeScript resolves `@acme/core`, it may go to:

```text
packages/core/dist/index.d.ts
```

instead of:

```text
packages/core/src/index.ts
```

This is the problem limina cares about.

In limina’s model, `workspace:*` means a **source dependency**. Since `app` declares that it depends on the source of `@acme/core`, the TypeScript project graph should express the same fact:

```jsonc
// packages/app/tsconfig.lib.dts.json
{
  "references": [{ "path": "../core/tsconfig.lib.dts.json" }],
}
```

At the same time, `@acme/core`’s exports or paths should allow TypeScript to resolve into the source graph, not into `dist`.

### How limina sees this

limina considers this an unhealthy structure:

```text
workspace:* dependencies are source dependencies,
but TypeScript resolved this package export to a file not owned by the source graph.
```

### How to fix it

There are three possible directions.

First, add a source-facing condition to package exports:

```json
{
  "exports": {
    ".": {
      "source": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

Second, use limina to generate compatible paths:

```sh
pnpm exec limina paths generate
```

Then manually add the generated paths config to the relevant `tsconfig*.dts.json`:

```jsonc
{
  "extends": [
    "./tsconfig.dts.paths.generated.json",
    "./tsconfig.lib.json",
    "../../tsconfig.dts.base.json",
  ],
}
```

Third, if you intentionally want to consume `dist`, then do not model it as a source dependency. Use `link:`, `catalog:`, or semver, and remove the project reference.

---

## Use Case 2: Packages import each other through relative paths; it works in the repo but breaks after publishing

Many monorepos contain code like this:

```ts
// packages/app/src/main.ts
import { createClient } from '../../core/src/client';
```

This usually works inside the repository because the file path exists.

But it violates package boundaries.

`app` has effectively bypassed:

```json
{
  "dependencies": {
    "@acme/core": "workspace:*"
  }
}
```

and it has also bypassed `@acme/core`’s `exports`:

```json
{
  "exports": {
    "./client": "./dist/client.js"
  }
}
```

More seriously, this style of import does not represent how real consumers use the package. When npm users install `@acme/app`, they do not have a `../../core/src/client` path.

### How limina sees this

limina treats this as cross-package relative path penetration:

```text
Relative import escapes package owner scope:
  reason: relative source imports must not cross the nearest package.json owner boundary.
```

### Recommended style

Use a package export import instead:

```ts
import { createClient } from '@acme/core/client';
```

Then explicitly export it in `@acme/core/package.json`:

```json
{
  "exports": {
    "./client": {
      "source": "./src/client.ts",
      "types": "./dist/client.d.ts",
      "import": "./dist/client.js"
    }
  }
}
```

This has three benefits:

1. The source consumption path inside the repository is clear.
2. The consumer path after publishing is consistent.
3. The TypeScript project graph can align with the package dependency graph.

---

## Use Case 3: `tsconfig.dts.json` can generate declarations, but the source was not strictly typechecked

Suppose a package contains:

```text
packages/core/
  src/index.ts
  tsconfig.lib.dts.json
```

`tsconfig.lib.dts.json` is responsible for generating declaration files:

```jsonc
{
  "extends": "../../tsconfig.dts.base.json",
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "emitDeclarationOnly": true,
    "rootDir": "src",
    "outDir": "dist",
  },
  "include": ["src/**/*.ts"],
}
```

This config can run `tsc -b` and generate `.d.ts` files.

But it has a problem: it only proves that declarations can be emitted. It does not necessarily prove that the source was strictly checked.

For example, your declaration emit base config may disable certain strict options for compatibility with the build, or its included file set may differ from the local typecheck config.

limina’s model requires every declaration leaf to have a local companion:

```text
tsconfig.lib.dts.json  ->  tsconfig.lib.json
tsconfig.test.dts.json ->  tsconfig.test.json
tsconfig.dts.json      ->  tsconfig.json
```

For example:

```jsonc
// packages/core/tsconfig.lib.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "strict": true,
  },
  "include": ["src/**/*.ts"],
}
```

### How limina sees this

If the companion is missing, limina reports:

```text
Missing typecheck companion config:
  declaration leaf: packages/core/tsconfig.lib.dts.json
  expected typecheck config: packages/core/tsconfig.lib.json
  reason: every tsconfig*.dts.json project should have a matching tsconfig*.json file with the same typechecking semantics.
```

If the companion exists but the file sets differ, limina also fails.

For example, the dts leaf includes:

```text
src/index.ts
src/runtime.ts
```

but the local typecheck includes only:

```text
src/index.ts
```

limina considers this unhealthy because the declaration leaf is generating types for files that were not strictly typechecked locally.

### Recommended structure

```text
packages/core/
  tsconfig.json              # default IDE/typecheck entry
  tsconfig.lib.json          # strict typecheck for lib source
  tsconfig.lib.dts.json      # lib declaration emit
  tsconfig.test.json         # strict typecheck for tests
  tsconfig.test.dts.json     # test declaration graph leaf
```

---

## Use Case 4: `tsconfig.json` has too many responsibilities: IDE, typecheck, and build are all mixed together

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
  tsconfig.lib.dts.json
  tsconfig.test.json
  tsconfig.test.dts.json
  tsconfig.tools.json
  tsconfig.tools.dts.json
```

In a single-environment directory, `tsconfig.json` can be a leaf directly:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "strict": true,
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

limina’s rule is: **a default `tsconfig.json` with references should aggregate only; it should not also behave as a leaf.**

---

## Use Case 5: Client runtime accidentally uses a Node API

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
// packages/app/src/client/tsconfig.dts.json
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "extends": ["./tsconfig.json", "../../../tsconfig.dts.base.json"],
  "references": [],
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
  rule: runtime-client
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

---

## Use Case 6: A new source file was added, but no checker covers it

Suppose someone adds a file:

```text
packages/core/src/generated/runtime.d.ts
```

But it is not included by any `tsconfig*.json`, nor covered by any checker entry.

This kind of file is dangerous because CI may still be green.

Not because the file is correct, but because it was never checked.

limina’s proof check first determines the source boundary, then proves that every source file is covered by at least one of the following:

- declaration graph;
- checker entry;
- allowlist.

If not, it reports:

```text
Source files are not covered by typecheck proof:
  - packages/core/src/generated/runtime.d.ts
  reason: every file in config.source must be covered by a checker entry or an explicit allowlist entry.
```

### Correct fix

Prefer adding it to tsconfig:

```jsonc
{
  "include": ["src/**/*.ts", "src/**/*.d.ts"],
}
```

If it is truly a generated file and validated by another process, it can be placed in the allowlist:

```js
export default defineConfig({
  proof: {
    allowlist: [
      {
        file: 'packages/core/src/generated/runtime.d.ts',
        reason: 'Generated declaration stub validated by the runtime build pipeline.',
      },
    ],
  },
});
```

The allowlist must include a concrete reason. limina does not encourage treating the allowlist as a junk drawer for skipped checks.

---

## Use Case 7: Test code depends on a test tool, but package.json does not declare it

Suppose `packages/core/src/__tests__/core.spec.ts` contains:

```ts
import { describe, it, expect } from 'vitest';
```

But `packages/core/package.json` does not contain:

```json
{
  "devDependencies": {
    "vitest": "catalog:test"
  }
}
```

This is common in monorepos because `vitest` may already be installed at the repository root, so tests work locally.

But from the package owner’s perspective, the test source of `packages/core` uses `vitest`, so it should be authorized by the nearest package owner.

### How limina sees this

limina reports an unauthorized bare package import:

```text
Unauthorized bare package import:
  package owner: packages/core/package.json
  imported specifier: vitest
  package: vitest
  reason: source imports must be authorized by the nearest package.json dependencies, devDependencies, peerDependencies, or optionalDependencies.
```

### How to fix it

Declare it in the nearest package owner:

```json
{
  "devDependencies": {
    "vitest": "catalog:test"
  }
}
```

The goal of this rule is not to force every package to reinstall dependencies repeatedly. Its goal is to make each package’s source dependency relationship auditable.

---

## Use Case 8: Source checks pass, but the published artifact is unusable for consumers

Suppose the source contains:

```ts
export { createClient } from './client';
```

Source typecheck passes, and the build successfully generates:

```text
dist/client.js
dist/client.d.ts
```

But `dist/package.json` is wrong:

```json
{
  "name": "@acme/core",
  "exports": {
    ".": "./index.js"
  },
  "types": "./missing.d.ts"
}
```

Source graph checks cannot catch this because the source itself is correct.

But consumers install the package from the `dist` directory. What consumers see is `exports`, `types`, the actual `.js` files, and the actual `.d.ts` files.

So limina treats package checks as a separate layer:

```js
export default defineConfig({
  package: {
    entries: [
      {
        name: '@acme/core',
        outDir: 'packages/core/dist',
      },
    ],
  },
});
```

Run:

```sh
pnpm exec limina package check
```

limina checks the real `dist` output:

- it uses publint to check package manifests and exports;
- it uses Are The Types Wrong to check type resolution;
- it checks whether runtime imports are authorized by the manifest;
- it checks whether browser output accidentally imports Node built-ins;
- it checks whether public package output contains README/LICENSE.

### limina’s view

A healthy source graph and a healthy published artifact are two different things.

A healthy monorepo must guarantee both:

```text
source graph is valid
package artifact is valid
```

---

## Use Case 9: One file is owned by multiple declaration leaves at the same time

Suppose you have:

```text
packages/core/src/index.ts
packages/core/tsconfig.lib.dts.json
packages/core/tsconfig.tools.dts.json
```

Both dts configs include the same file:

```jsonc
{
  "include": ["src/**/*.ts"],
}
```

This means `src/index.ts` belongs to both the lib declaration graph and the tools declaration graph.

That causes several problems:

1. The same file may be checked with different compiler options.
2. Declaration emit may be duplicated.
3. The project reference graph cannot determine which leaf owns the file.
4. Runtime boundary labels may conflict.

limina requires each checker graph file to have exactly one declaration owner.

### How to fix it

Give different leaves different file sets:

```jsonc
// tsconfig.lib.dts.json
{
  "include": ["src/**/*.ts"],
  "exclude": ["src/tools/**"],
}
```

```jsonc
// tsconfig.tools.dts.json
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

so that each declaration leaf has a more natural boundary.

---

## Use Case 10: A browser package output accidentally depends on an undeclared dependency

Suppose the built `dist/index.js` contains:

```js
import { parse } from 'yaml';
```

But `dist/package.json` does not declare:

```json
{
  "dependencies": {
    "yaml": "^2.0.0"
  }
}
```

The source package may test successfully because `yaml` is installed at the repository root, but when consumers install the published package, `yaml` may not exist.

limina’s package boundary check scans JS imports in the published artifact and checks whether they are declared in the output manifest.

### How limina sees this

```text
"yaml" resolves to package "yaml" which is not listed in dependencies, peerDependencies, optionalDependencies, or self exports
```

### How to fix it

Add the dependency to the final published package manifest:

```json
{
  "dependencies": {
    "yaml": "^2.0.0"
  }
}
```

Or, if the dependency is expected to be provided by the external environment, declare it in `peerDependencies`.

---

## Summary

A healthy monorepo through limina’s eyes is not one where “all commands finish successfully.” It is one where the following graphs are mutually consistent:

```text
pnpm workspace packages
        │
        ▼
package.json dependencies
        │
        ▼
workspace:* source dependency graph
        │
        ▼
TypeScript project references
        │
        ▼
actual TypeScript module resolution
        │
        ▼
source files covered by checkers
        │
        ▼
built package outputs consumed by users
```

If any layer expresses a different fact, limina considers the monorepo unhealthy.

For example:

| Symptom                                                 | limina’s judgment                                                 |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `workspace:*` but resolves to `dist`                    | Source dependency and TypeScript resolution are inconsistent      |
| Cross-package relative import                           | Bypasses package exports and the package owner boundary           |
| Project reference crosses packages but no `workspace:*` | TS graph declares a source dependency, but package graph does not |
| dts leaf has no companion                               | Declaration emit has no strict typecheck proof                    |
| Source file is not covered by any checker               | Green CI does not mean the file was checked                       |
| Browser runtime imports `node:fs`                       | Runtime boundary is violated                                      |
| dist manifest has broken exports/types                  | Source is healthy, but published artifact is unhealthy            |
| dist import has undeclared dependency                   | Consumers may miss dependencies after installation                |
