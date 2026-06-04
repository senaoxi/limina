# Why Limina

TypeScript monorepos tend to start simple. A root `tsconfig.json`, a few packages, and a `typecheck` script feel enough.

As the repository grows, the same files begin to serve different jobs:

- the editor wants fast local type information;
- `tsc -b` wants a clean project reference graph;
- framework files may need `vue-tsc`, `vue-tsgo`, or `svelte-check`;
- packages may import each other through `workspace:*`;
- published output must work after it is packed and installed.

Those jobs are related, but TypeScript does not automatically prove that they agree with each other. Limina exists for that gap.

## How Limina Relates to Nx / Turborepo

Limina, Nx, and Turborepo all belong to the category of monorepo tooling, but they operate at different layers of the problem.

Nx and Turborepo primarily solve problems at the **task-execution layer**: which projects run which tasks, what order tasks run in, which tasks run in parallel, which results can be cached, and how CI runs faster. Limina solves problems at the **architecture-conformance layer**: before those tasks run, can the repository structure itself be trusted — do the TypeScript source graph, the package dependency graph, project references, package exports, runtime boundaries, and published artifacts all express the same facts?

The two are not mutually exclusive. A project can use both together:

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

Here Nx / Turborepo own task orchestration, affected execution, parallelism, caching, and CI acceleration. Limina owns whether workspace package exports resolve correctly, whether imports are authorized by the nearest `package.json`, whether project references match source-owned imports, whether `workspace:*` artifact imports are reflected in Nx build edges, whether `tsconfig*.dts.json` files have strict companions, whether source files are covered by checkers, whether client / shared / node runtime boundaries hold, and whether published `dist` artifacts are usable by consumers.

Nx itself also offers module-boundary and conformance capabilities, for example declaring dependency constraints through project tags and enforcing them with an ESLint rule or Nx Conformance. The difference is that limina's rules are not generic tag-level project-dependency policies:

```text
Nx module boundaries are more like:
  "Can a project tagged A depend on a project tagged B?"

limina is more like:
  "Is this dependency consistent across package.json, tsconfig references,
   TypeScript module resolution, source file ownership, and dist package exports?"
```

That is also why monorepos need conformance even when `tsc`, Nx, and Turborepo are all in place: large TypeScript workspaces have a class of problems that are not execution-efficiency problems but structural-truth problems — is this dependency source or artifact, is this import authorized by `package.json`, does this project reference reflect a real import, does this declaration come from strictly checked source, is this file covered by any checker, does this runtime cross the client/node boundary, and is this `dist` output truly installable for consumers?

> Nx makes monorepo tasks run more efficiently; limina makes the monorepo structure those tasks depend on more trustworthy.

::: tip
For concrete, worked scenarios of what limina checks, see [Architecture Conformance](./architecture-conformance.md). To wire limina into a repository, see [Getting Started](./getting-started.md).
:::

## The Project Graph Can Drift

Project references are supposed to describe which project depends on which other project. Real imports are the source of truth, though. If a file imports another workspace package but the declaration project does not reference the target project, the graph is stale.

Limina reads the projects reachable from your checker entries, resolves real imports with TypeScript, and reports missing or forbidden references. It also checks label-based rules, so a browser runtime project can be denied access to Node-only projects or dependencies.

For example, `@acme/app` imports `@acme/core`, but `packages/app/tsconfig.lib.dts.json` does not reference `packages/core/tsconfig.lib.dts.json`. Limina points at the importing file, the current references, and the missing edge. After the fix, `tsc -b`, the editor, and CI are looking at the same dependency graph.

## Workspace Dependencies Need Clear Meaning

`workspace:*` means "this package is linked from the same workspace". That relationship can expose source entries, artifact entries, or a deliberate mix of both through `package.json#exports`.

That distinction matters because TypeScript project references do not rewrite package exports. If package A references package B but imports `@scope/b`, TypeScript still follows B's package exports. Limina therefore resolves the public exports first and treats the resolved entry as the fact source for later checks.

If the import resolves to a checker-owned source file, the consuming declaration leaf must reference the owner leaf. If the import resolves to a built declaration artifact such as `dist/*.d.ts`, graph references are not required. If the import resolves to `dist` through a `workspace:*` dependency, Nx checks require the consuming package's build target to depend on the producer's build target.

For example, `@acme/app` depends on `@acme/core` with `workspace:*`. If it imports `@acme/core` and that export resolves to `./src/index.ts`, graph check requires the matching project reference. If it imports `@acme/core/runtime` and that export resolves to `./dist/runtime.d.ts` or `./dist/runtime.js`, Nx check expects app's `project.json` to contain a build dependency on core.

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
