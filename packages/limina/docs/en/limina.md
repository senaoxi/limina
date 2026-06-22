# What is Limina

Limina is a project-reference graph compiler and architecture governance CLI for TypeScript monorepos. It turns TypeScript project-reference build relationships from hand-maintained config into generated, checked, incremental build capability, then extends the same facts across source dependencies, package boundaries, checker coverage, workspace exports, and published output.

For a small package, `tsc --noEmit` may be enough. In a larger workspace, there are usually more moving parts:

- packages import each other through declared package dependencies;
- TypeScript project references describe the build graph;
- Vue, Svelte, docs, tools, tests, and runtime code may need different checkers;
- published packages need their own `exports`, types, dependency declarations, README, and license files.

Limina does not replace those tools. It coordinates them and verifies the assumptions between them before CI or a release surprises you.

Think of Limina as an architecture health check for the monorepo. It does not write business code or decide how you publish. It tells you, during review, CI, or pre-release checks, whether the source graph, typecheck graph, and final package output still describe the same project.

## Start With Build

For a team trying Limina for the first time, the lowest-friction entry point is usually not the full check pipeline. It is `limina:build`. `limina init` writes a lightweight config, ensures the generated directory is ignored, and adds a `limina:build` script to the root `package.json`.

That script maps to `limina checker build`. It starts from enabled source `tsconfig.json` entries, prepares Limina's governed type build graph, then runs build-capable checkers such as `tsc -b`, `tsgo -b`, or `vue-tsc -b`.

The value is immediate:

- users get incremental TypeScript build first, instead of being blocked by the full governance surface on day one;
- project references are derived from real source imports, source configs, and checker coverage instead of being kept in sync by hand;
- once the build path is stable, teams can opt into `limina check`, package checks, and release checks to apply the same fact graph to architecture governance.

## What Limina Checks

Limina is built around a single config file, `limina.config.mjs`, and a few focused checks:

- **Graph checks** verify that real imports match TypeScript project references and declared package dependency rules.
- **Source checks** keep files inside the package that owns them and make sure imports are declared where they are used.
- **Dependency graph export** gives you a scoped JSON view of source and artifact consumption inferred from real imports and resolution results.
- **Proof checks** show that declaration configs, local typecheck configs, checker entries, and allowlists cover the intended source files.
- **Checker runs** call `tsc`, `tsgo`, `vue-tsc`, `vue-tsgo`, or `svelte-check` against the right targets derived from the graph.
- **Package checks** inspect built output the way consumers install it, using `publint`, Are The Types Wrong, and a runtime import boundary scan.
- **Release checks** pack the npm tarball and verify publish hygiene: required README and license files, no shipped source maps, packed-manifest consistency, and workspace publish dependencies compared against npm registry content.
- **Pipelines** compose Limina tasks and shell commands into local, PR, and publish workflows.

## Good Fit

Limina is a good fit when your repository:

- uses pnpm workspaces with multiple packages;
- uses TypeScript project references or wants to migrate to `tsc -b`;
- needs clear boundaries between production code, tooling, tests, browser code, and Node code;
- publishes packages and wants to validate the built output before release;
- has framework-specific files that plain `tsc -b` does not typecheck by itself.

::: tip
Limina is not a bundler, test runner, package publisher, or hidden preset. The goal is to make monorepo rules explicit, reviewable, and runnable in CI.
:::

## Common Situations

- **A team starts with incremental build**: the repository wants `tsc -b`, but the team does not want to handwrite and continuously sync project references. `limina:build` prepares the type build graph from existing source configs and real imports, giving the repository a runnable incremental build entry first.
- **A pull request changes a cross-package import**: `@acme/app` adds `import { createClient } from '@acme/core'`, but the type build graph does not express that source relationship. `limina check` reports the missing project reference or missing package dependency before the build graph drifts after merge.
- **Browser code imports a Node-only dependency**: a `runtime-client` project accidentally imports `node:fs` or `@acme/internal-node`. A graph rule blocks that edge before the browser runtime fails in production.
- **Source typechecks pass but publish output is broken**: local `tsc` passes, but `dist/package.json` points `exports` or `types` at the wrong files. `limina package check` inspects the built output from a consumer's point of view before npm publish.
- **A workspace export mixes source and `dist` entries**: `@acme/core` exposes `.` from `src` and `./runtime` from `dist`. Limina accepts both entries after TypeScript and Oxc can resolve them. Imports of the source entry require the matching project reference; imports of the `dist` entry become artifact edges in the exported dependency graph.

## How It Fits Into Your Workflow

After adoption, Limina gives you checks that can live in local development, pull requests, and release workflows:

- locally, you can start with `pnpm limina:build` to verify that the TypeScript project-reference build still runs incrementally;
- in review, architecture boundary changes show up in `limina.config.mjs`, `package.json`, or source `tsconfig` files;
- before publishing, you can validate the actual `dist` output consumers install, including metadata, type entries, README, license, and runtime import boundaries.

For a first-time user, the practical benefit is that you do not need to already be a monorepo expert to read the failure. The report usually points you toward the right category of fix: add a reference, declare a dependency, fix package exports, or repair package output.

## Next steps

Read [Why Limina](./why.md) for the motivation, or jump straight to [Getting Started](./getting-started.md).
