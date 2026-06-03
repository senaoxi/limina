# Why Limina

TypeScript monorepos tend to start simple. A root `tsconfig.json`, a few packages, and a `typecheck` script feel enough.

As the repository grows, the same files begin to serve different jobs:

- the editor wants fast local type information;
- `tsc -b` wants a clean project reference graph;
- framework files may need `vue-tsc`, `vue-tsgo`, or `svelte-check`;
- packages may import each other through `workspace:*`;
- published output must work after it is packed and installed.

Those jobs are related, but TypeScript does not automatically prove that they agree with each other. Limina exists for that gap.

## The Project Graph Can Drift

Project references are supposed to describe which project depends on which other project. Real imports are the source of truth, though. If a file imports another workspace package but the declaration project does not reference the target project, the graph is stale.

Limina reads the projects reachable from your checker entries, resolves real imports with TypeScript, and reports missing or forbidden references. It also checks label-based rules, so a browser runtime project can be denied access to Node-only projects or dependencies.

For example, `@acme/app` imports `@acme/core`, but `packages/app/tsconfig.lib.dts.json` does not reference `packages/core/tsconfig.lib.dts.json`. Limina points at the importing file, the current references, and the missing edge. After the fix, `tsc -b`, the editor, and CI are looking at the same dependency graph.

## Workspace Dependencies Need Clear Meaning

`workspace:*` means "this package is part of the source workspace". That is different from `link:`, `file:`, `catalog:`, or a normal semver dependency, which usually means "consume this package as an artifact".

That distinction matters because TypeScript project references do not rewrite package exports. If package A references package B but imports `@scope/b`, TypeScript still follows B's package exports. When those exports point to `dist`, the graph may silently consume build output instead of source.

Limina detects this situation. It asks you to either expose source entries in the source manifest or stop modeling the edge as a source dependency.

For example, `@acme/app` depends on `@acme/core` with `workspace:*`, but `@acme/core`'s source manifest exports `./dist/index.js`. Limina reports that the source dependency resolved to build output. Fix the source manifest so `exports` points at `./src/index.ts`, then let the build or packaging step rewrite the published manifest to `./index.js` and `./index.d.ts`. If `app` intentionally consumes built output, use `link:`, `catalog:`, `file:`, or semver instead and remove the cross-package project reference.

## Source Ownership Should Be Boring

In a monorepo, relative imports that jump across package folders make ownership unclear. A package can also import a bare dependency that is not declared in its nearest `package.json`.

Limina's source check keeps these rules plain:

- source files must belong to a nearest package owner;
- a non-aggregator tsconfig should not mix several package owners;
- relative imports must stay inside the same package owner;
- bare imports must be declared in the nearest `package.json`, in `dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies`;
- `#imports` must match the nearest package's `imports` field, must not target another workspace package, and must resolve inside that package.

For example, `packages/app/src/main.ts` reaches into another package with `../core/src/index`. Limina reports the cross-package relative import and nudges the dependency back through `@acme/core` package exports. After that, reviewers can understand the dependency from manifests and exports instead of chasing relative paths.

## Passing Source Checks Is Not Enough

A source graph can pass while the published package is still broken. Consumers install the built output, not your source tsconfigs.

Limina package checks run after your build. They pack the output when needed and check consumer-facing package metadata, type resolution, runtime imports, dependency declarations, and self imports. Release checks then validate publish hygiene such as README/license files, source map bans, packed manifest consistency, and registry-backed workspace publish order. Together, they catch a different class of release bugs than `tsc`.

For example, source typechecking passes, but `dist/package.json` points `types` at a missing declaration file, or browser output still imports `node:fs`. `limina package check` fails before release. The thing being validated is the package consumers install, not only the source tree in your repository.

## The Design Goal

Limina tries to keep the rules visible. Instead of hiding policy in a preset, it keeps checker entries, graph rules, package entries, allowlists, and pipelines in `limina.config.mjs`.

That makes architecture changes something reviewers can read, not something CI discovers only after the merge.

For example, if browser runtime code must never reach Node-only packages, put `"graphRules": ["runtime-client"]` under `liminaOptions` in the declaration leaf and define the deny rule under `graph.rules.runtime-client`. Future boundary changes then appear in config or tsconfig diffs, where reviewers can discuss them directly.
