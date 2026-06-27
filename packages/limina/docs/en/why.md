# Why Limina

TypeScript monorepos tend to start simple. A root `tsconfig.json`, a few packages, and a `typecheck` script feel enough.

As the repository grows, the same files begin to serve different jobs:

- the editor wants fast local type information;
- `tsc -b` wants a clean project reference graph;
- framework files may need `vue-tsc`, `vue-tsgo`, or `svelte-check`;
- packages may import each other through declared package dependencies;
- published output must work after it is packed and installed.

Those jobs are related, but TypeScript does not automatically prove that they agree with each other. Limina exists for that gap.

## Where Limina Fits

Limina belongs to the monorepo toolbox, but it operates at a specific layer of the problem.

Limina does not bundle code, run tests, or schedule every repository task. It solves problems at the **architecture-conformance layer**: can the repository structure itself be trusted, and do the TypeScript source graph, package dependency graph, project references, package exports, runtime boundaries, scoped graph exports, and published artifacts all express the same facts?

A project can run Limina alongside the rest of its workflow:

```sh
pnpm exec limina checker build
pnpm exec limina check
pnpm exec limina graph export --view artifact --output .limina/dependency-graph.json
```

For a first trial, start with `limina checker build` to get a Limina-managed incremental type build entry. Once that build path is stable, put `limina check` into pull requests or CI. The surrounding workflow still owns ordinary execution concerns. Limina owns whether workspace package exports resolve correctly, whether imports are declared by the source owner or by an explicitly allowed root manifest candidate, whether project references match source-owned imports, whether artifact imports are visible in the scoped dependency graph, whether source configs have valid graph companions, whether source files are covered by checkers, whether client / shared / node runtime boundaries hold, and whether published `dist` artifacts are usable by consumers.

Some tools also offer module-boundary and conformance capabilities, for example declaring dependency constraints through project metadata. The difference is that limina's rules are not generic project-dependency policies:

```text
Generic module boundaries are more like:
  "Can project A depend on project B?"

limina is more like:
  "Is this dependency consistent across package.json, tsconfig references,
   TypeScript module resolution, source file ownership, and dist package exports?"
```

That is also why monorepos need conformance even when typechecking and workflow automation are already in place: large TypeScript workspaces have a class of problems that are not execution-efficiency problems but structural-truth problems. Is this dependency source or artifact? Is this import authorized by `package.json`? Does this project reference reflect a real import? Does this declaration come from checked source? Is this file covered by any checker? Does this runtime cross the client/node boundary? Is this `dist` output truly installable for consumers?

> Automation can make monorepo work run more smoothly; limina makes the monorepo structure that work depends on more trustworthy.

::: tip
For concrete, worked scenarios of what limina checks, see [Architecture Conformance](./architecture-conformance.md). To wire limina into a repository, see [Getting Started](./getting-started.md).
:::

## The Project Graph Can Drift

Project references are supposed to describe which project depends on which other project. Real imports are the source of truth, though. If a file imports another workspace package but the declaration project does not reference the target project, the graph is stale.

Limina reads the projects reachable from your checker entries, resolves real imports with TypeScript, and reports missing or forbidden references. It also checks label-based rules, so a browser runtime project can be denied access to Node-only projects or dependencies.

For example, `@acme/app` imports `@acme/core`, but the generated app declaration build config under `.limina/` does not reference the generated core config. Limina points at the importing file, maps the generated project back to the source tsconfig, and reports the missing edge. After `limina graph prepare`, `tsc -b`, the editor, and CI are looking at the same dependency graph.

## Workspace Dependencies Need Clear Meaning

A package dependency declaration authorizes access to another package, but it does not say whether an import consumes source or a built artifact. The resolved public export decides that meaning.

That distinction matters because TypeScript project references do not rewrite package exports. If package A references package B but imports `@scope/b`, TypeScript still follows B's package exports. Limina therefore resolves the public exports first and treats the resolved entry as the fact source for later checks.

If the import resolves to source covered by Limina, the consuming declaration build config must reference the config for that source. If the import resolves to a built declaration artifact such as `dist/*.d.ts`, graph references are not required. Instead, `limina graph export --view artifact` reports that artifact edge inside the importing tsconfig's condition domain. That export is useful for review and diagnostics, not as a task-ordering guarantee.

For example, `@acme/app` depends on `@acme/core`. If it imports `@acme/core` and that export resolves to `./src/index.ts`, graph check requires the matching project reference. If it imports `@acme/core/runtime` and that export resolves to `./dist/runtime.d.ts` or `./dist/runtime.js`, graph export reports an artifact edge from app to core.

## Source Ownership Should Be Boring

In a monorepo, relative imports that jump across the nearest `package.json` package scope make ownership unclear. A package can also import a bare dependency without an authority manifest that explains why the dependency is available.

Limina's source check keeps these rules plain:

- source files must belong to one pnpm workspace source owner;
- a non-aggregator tsconfig should not mix several source owners;
- relative imports must stay inside the same nearest `package.json` package scope;
- bare imports must be declared by the source owner, or by the workspace root manifest only when a matching `source.importAuthority.allow` package rule makes it a candidate; specifier rules cover intentional non-manifest exceptions;
- `#imports` must match the importing file's nearest package scope; relative targets must stay inside that declaring scope, while package targets must be authorized by the importing file's pnpm workspace source owner.

For example, `packages/app/src/main.ts` reaches into another package with `../core/src/index`. Limina reports the cross-package relative import and nudges the dependency back through `@acme/core` package exports. After that, reviewers can understand the dependency from manifests and exports instead of chasing relative paths.

## Passing Source Checks Is Not Enough

A source graph can pass while the published package is still broken. Consumers install the built output, not your source tsconfigs.

Limina package checks run after your build. They pack the output when needed and check consumer-facing package metadata, type resolution, runtime imports, dependency declarations, and self imports. Release checks then validate publish hygiene such as README/license files, source map bans, packed manifest consistency, and registry-backed workspace publish order. Together, they catch a different class of release bugs than `tsc`.

For example, source typechecking passes, but `dist/package.json` points `types` at a missing declaration file, or browser output still imports `node:fs`. `limina package check` fails before release. The thing being validated is the package consumers install, not only the source tree in your repository.

## The Design Goal

Limina tries to keep the rules visible. Instead of hiding policy in a preset, it keeps checker entries, graph rules, package entries, allowlists, and pipelines in `limina.config.mjs`.

That makes architecture changes something reviewers can read, not something CI discovers only after the merge.

For example, if browser runtime code must never reach Node-only packages, put `"graphRules": ["runtime-client"]` under `liminaOptions` in the source tsconfig and define the deny rule under `graph.rules.runtime-client`. Limina carries that label into the generated build config, so future boundary changes appear in config or tsconfig diffs where reviewers can discuss them directly.
