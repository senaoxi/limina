# Why Limina

A TypeScript monorepo often starts simple: one root `tsconfig.json`, a few packages, and a type-check script.

At that stage, the code structure is usually easy to understand. Which package a file belongs to, which modules it depends on, which config checks it, and where it should appear in build order can usually be judged directly.

As the repository grows, a single package can become complex. It may contain browser runtime code, Node runtime code, shared modules, test modules, tool scripts, build configuration, and published entries at the same time. To give each of these files the correct type environment, teams usually create different `tsconfig` files for different scenarios.

At that point, the real burden is no longer “write one `tsconfig`.” It is maintaining an accurate TypeScript project reference graph across multiple `tsconfig` files over time. Every source import change can affect build order, runtime boundaries, and check coverage.

Limina's core problem is to build a verifiable project-reference graph on top of TypeScript project references, so code structure in complex monorepos stays understandable, reviewable, and predictable.

## One Package Can Contain Multiple Engineering Boundaries

In a simple project, a package can usually be understood as a single boundary: one package, one source set, one type-check entry.

In a complex TypeScript monorepo, a package may already contain multiple boundaries. For example, a VitePress-related package may include:

- client runtime code for the browser;
- server-side or build-time code for Node;
- shared modules that may be reused by both browser and Node code;
- test code;
- build scripts and tool scripts;
- multiple public entries exposed to consumers.

These files may live in the same package, but they should not be covered by one type environment without distinction. Browser code should not depend on Node builtins; shared modules should not accidentally bind to one specific runtime; test code and tool scripts should not pollute production build relationships.

Therefore, splitting multiple `tsconfig` files is reasonable. The problem is that, after the split, the dependency relationships between those configs also have to be maintained.

## Project References Improve Builds, but Add Maintenance Cost

TypeScript project references are suitable for large repositories. They let type builds run in dependency order and reuse incremental build results.

But project references assume that the reference graph is accurate.

The most typical maintenance cost does not necessarily come from cross-package access. It often comes from [multiple engineering boundaries inside one package](#one-package-can-contain-multiple-engineering-boundaries). When a module uses a relative path to access another module in the same package, for example:

```ts
import { resolveThemeConfig } from '../shared/theme';
```

it looks like a normal relative import. But if the importer and imported file are owned by different `tsconfig` files, that source dependency also needs to be reflected in the TypeScript project reference graph. Otherwise, the source relationship exists, but the build graph does not express it.

Without automated checks, developers have to decide whether this import crosses different `tsconfig` ownership scopes, whether the dependent config needs a new `references` entry, whether old `references` are still necessary, and whether the relationship breaks runtime boundaries.

The more configs a repository has, the harder this is to maintain by hand. Project references improve incremental build capability, but they also shift part of the structural maintenance cost onto developers: when real source dependencies change, `references` must change with them; when source dependencies are removed, stale references should be removed as well. As soon as these two relationship sets drift, build order, check coverage, and runtime boundaries become unpredictable.

## Limina Starts Governance from the Project Reference Graph

Limina's checks are not an extra rule system detached from TypeScript. They are built on top of TypeScript project references.

Teams still maintain their existing source configs and package boundaries. Limina reads those configs and real source imports, generates an incrementally executable type build graph, and checks whether that graph is consistent with the source structure.

This means users do not need to spend all their effort hand-writing and synchronizing `references`. More importantly, the build graph is no longer just static configuration; it becomes an engineering fact that can be generated, verified, and run continuously.

When the source structure changes, Limina continues to answer questions around that generated graph: whether real imports require new project references, whether existing project references are still necessary, whether cross-runtime dependencies violate boundary constraints, whether source files belong to clear check coverage, and whether the generated build relationship remains suitable for incremental execution.

The following scenarios all explain the same underlying point: put code relationships into one verifiable project-reference graph, rather than asking developers to manually reconstruct the entire `references` graph for every change.

## Typical Scenario: One Package Supports Multiple Runtimes

Suppose one package contains three source groups: `client`, `node`, and `shared`:

```txt
packages/example/
  src/client/
  src/node/
  src/shared/
```

They usually need different type environments:

```txt
src/client/tsconfig.json   # browser runtime
src/node/tsconfig.json     # Node runtime
src/shared/tsconfig.json   # shared modules
```

The expected structure is clear: `client` may depend on `shared`, but should not depend on `node`; `shared` should remain reusable and should not bind to one concrete runtime; `node` may use Node types and Node builtins.

The problem is that these expectations need to be reflected in the project reference graph and source boundaries. Otherwise, each time a developer adds a relative import across `tsconfig` ownership scopes, they have to make the same decisions described in [Project References Improve Builds, but Add Maintenance Cost](#project-references-improve-builds-but-add-maintenance-cost): whether the dependent config should add `references`, whether the edge violates runtime boundaries, and whether old references are still necessary.

Limina's value is to turn those decisions into checks. Users express real dependencies through source code; Limina maintains a verifiable project-reference graph based on those dependencies and reports failures when the structure does not match expectations.

## Typical Scenario: Tests and Tooling Should Not Pollute the Main Build

Complex packages often contain test code and tool scripts:

```txt
packages/example/
  src/
  scripts/
  tests/
  vitest.config.ts
  build.config.ts
```

These files need type checking, but they should not necessarily participate in production build relationships.

Without clear configuration boundaries, test code may import dependencies that are only available in tests, tool scripts may import Node-only modules, and those relationships may be incorrectly mixed into the production build graph. This is the same problem as [one package supporting multiple runtimes](#typical-scenario-one-package-supports-multiple-runtimes): different source ranges need different type environments and explicit reference relationships.

Limina is not concerned with how many check scripts a repository has. It is concerned with whether the source ranges behind those scripts are clear. Test files should enter only test configs, tool scripts should use their own suitable type environment, and production source should not be accidentally owned by test or tool configs.

When these relationships can be checked, teams can understand more clearly where each piece of code sits in the repository structure.

## Typical Scenario: Code Runs, but the Structure Is No Longer Predictable

Cross-package relative imports are a common structural problem in monorepos:

```ts
import { Button } from '../../ui/src/Button';
```

This code may work in the short term, but it bypasses the package name, dependency declaration, and public entry. As a result, `package.json` does not show the real dependency, the package's public entries cannot constrain the way it is used, and developers still have to manually decide whether this import should enter the TypeScript project reference graph.

A more predictable form is to access the package through its package name and public entry:

```ts
import { Button } from '@acme/ui';
```

Then the code relationship appears in source imports, dependency declarations, public entries, and the project graph at the same time. Reviewers can also judge whether the change fits the repository structure.

`#imports` follow the same idea: a relative target is an internal entry of the declaring package scope and cannot be used to access another package; a package target may point to a third-party package or a workspace dependency, but it still needs to be authorized by the workspace package that owns the importing file.

This is the same kind of problem as the earlier [cross-`tsconfig` relative import inside one package](#project-references-improve-builds-but-add-maintenance-cost): the fact that code resolves does not mean the structural relationship has been expressed correctly. Limina's checks help the team confirm whether the code is in a clear, reasonable, and predictable position in the overall repository structure.

## The Final Goal: Reduce Structural Maintenance Cost

Limina's goal is not to add more rules to the repository. It is to reduce the maintenance cost caused by complex structure.

For large TypeScript monorepos, the hard part is not writing one `tsconfig`. It is keeping multiple packages, multiple runtimes, multiple checkers, and multiple published entries consistent over time. The scenarios above explain this from runtime boundaries, test/tool configs, and cross-package access, but they all point to the same requirement: source relationships must stay consistent with the TypeScript project reference graph.

After adopting Limina, teams can answer these questions more reliably:

- Which source range does this file belong to?
- Which `tsconfig` should govern it?
- Do its module dependencies respect runtime boundaries?
- Do project references accurately express real source dependencies?
- Can the type build graph run incrementally?
- Are tests, tools, and production source clearly separated?
- Before publishing, do artifacts still satisfy the structural expectations established at the source stage?

When these questions can be answered by automated checks, developers do not need to manually reconstruct the entire project reference graph for every change.

That is Limina's core value: it builds a verifiable project-reference graph on top of TypeScript project references, so code structure in complex monorepos stays understandable, reviewable, and predictable.

::: tip
If you want to adopt it directly in a repository, start with [Getting Started](./getting-started.md).
If you want to understand how specific rules are configured, continue with the [Configuration Reference](./config/).
:::
