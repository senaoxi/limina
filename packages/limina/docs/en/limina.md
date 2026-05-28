# Limina

Limina keeps a TypeScript monorepo honest. It checks that the source graph, package ownership, typecheck coverage, generated compatibility paths, and built package outputs all describe the same project.

For a small package, `tsc --noEmit` may be enough. In a larger workspace, there are usually more moving parts:

- packages import each other through `workspace:*`;
- TypeScript project references describe the build graph;
- Vue, Svelte, docs, tools, tests, and runtime code may need different checkers;
- published packages need their own `exports`, types, dependency declarations, README, and license files.

Limina does not replace those tools. It coordinates them and verifies the assumptions between them before CI or a release surprises you.

Think of Limina as an architecture health check for the monorepo. It does not write business code or decide how you publish. It tells you, during review, CI, or pre-release checks, whether the source graph, typecheck graph, and final package output still describe the same project.

## What Limina Checks

Limina is built around a single config file, `limina.config.mjs`, and a few focused checks:

- **Graph checks** verify that real imports match TypeScript project references and workspace dependency rules.
- **Source checks** keep files inside the package that owns them and make sure imports are declared where they are used.
- **Proof checks** show that declaration configs, local typecheck configs, checker entries, and allowlists cover the intended source files.
- **Checker runs** call `tsc`, `tsgo`, `vue-tsc`, `vue-tsgo`, or `svelte-check` against the right targets derived from the graph.
- **Path generation** creates explicit TypeScript `paths` files only when a workspace dependency is consumed as source but still exports build artifacts.
- **Package checks** inspect built output the way consumers install it, using `publint`, Are The Types Wrong, and a runtime import boundary scan.
- **Pipelines** compose Limina tasks and shell commands into local, PR, and publish workflows.

## Good Fit

Limina is a good fit when your repository:

- uses pnpm workspaces with multiple packages;
- uses TypeScript project references or wants to migrate to `tsc -b`;
- needs clear boundaries between production code, tooling, tests, browser code, and Node code;
- publishes packages and wants to validate the built output before release;
- has framework-specific files that plain `tsc -b` does not typecheck by itself.

Limina is not a bundler, test runner, package publisher, or hidden preset. The goal is to make monorepo rules explicit, reviewable, and runnable in CI.

## Common Situations

- **A pull request changes a cross-package import**: `@acme/app` adds `import { createClient } from '@acme/core'`, but the app declaration leaf does not reference core. `limina check` reports the missing project reference or missing `workspace:*` dependency before the build graph drifts after merge.
- **Browser code imports a Node-only dependency**: a `runtime-client` project accidentally imports `node:fs` or `@acme/internal-node`. A graph rule blocks that edge before the browser runtime fails in production.
- **Source typechecks pass but publish output is broken**: local `tsc` passes, but `dist/package.json` points `exports` or `types` at the wrong files. `limina package check` inspects the built output from a consumer's point of view before npm publish.
- **A workspace dependency still exports `dist`**: a package uses `workspace:*` to mean source dependency, but its package exports still point to build output. Limina reports that the edge is not resolving as source and can generate an explicit `tsconfig.dts.paths.generated.json` compatibility file.

## How It Fits Into Your Workflow

After adoption, Limina gives you checks that can live in local development, pull requests, and release workflows:

- locally, you can see whether a change broke the TypeScript graph or checker coverage;
- in review, architecture boundary changes show up in `limina.config.mjs`, `package.json`, or `tsconfig*.dts.json`;
- before publishing, you can validate the actual `dist` output consumers install, including metadata, type entries, README, license, and runtime import boundaries.

For a first-time user, the practical benefit is that you do not need to already be a monorepo expert to read the failure. The report usually points you toward the right category of fix: add a reference, declare a dependency, fix package exports, or repair package output.
