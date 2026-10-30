# Configuration Reference

An empty config is enough to run the default checks. Add fields as you encounter specific needs; you do not have to learn every option first. The default checks analyze project relationships, source imports, and coverage, then run applicable checkers. Package and release checks run separately.

`limina.config.mjs`:

```js
import { defineConfig } from 'limina';

export default defineConfig({});
```

## First, distinguish packages, files, and checkers

Suppose the config is at the workspace root, the repository has `packages/core` and `apps/web`, and the web project contains `apps/web/src/App.vue`:

```text
limina.config.mjs
packages/core/tsconfig.json
packages/core/src/index.ts
apps/web/tsconfig.json
apps/web/src/App.vue
```

The following fields answer different questions and can be adjusted separately:

| What do I want to decide?                                  | Configuration                          | Effect in this example                                                                                                    |
| ---------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Which packages and areas within them participate?          | [`scope.regions`](./regions.md)        | Discovers and activates packages from the workspace declaration. You can also exclude an area and record a reason.        |
| Which files need source and coverage checks?               | [`scope.source`](./source-boundary.md) | Matches TypeScript files by default. To include `App.vue`, add `**/*.vue` to `include`.                                   |
| Which `tsconfig.json` entries and checkers should be used? | [`scope.checkers`](./checkers.md)      | Discovers entries automatically by default. To fix ownership, you can select `vue-tsc` for the web entry.                 |
| How should source imports and other rules be checked?      | [`source`](./source-checks.md)         | Configures import authorization or optional unused-code analysis. It does not select the source file set described above. |

These fields are not interchangeable. `scope.source` patterns only filter files in activated regions; they cannot bring an inactive package into scope. Selecting `vue-tsc` does not automatically add `.vue` to `scope.source`. If a `tsconfig` includes components but the source scope does not, the coverage check may report a mismatch. Conversely, adding `.vue` still requires a checker and its source config to cover the files. Excluding an automatically discovered entry does not cut references from another selected entry.

For example, this config retains the default TypeScript scope and requires additional coverage for Vue files. It does not change the file list in the project's `tsconfig`:

`limina.config.mjs`:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  scope: {
    source: {
      include: ['...', '**/*.vue'],
    },
  },
});
```

Prepare the framework checker as needed, then run `pnpm exec limina check` and use the report to adjust file ownership. See [Getting Started](../getting-started.md#using-vue-astro-or-svelte) for the complete steps.

## Read by Configuration Goal

| What you need to decide                                                                            | Configuration entry                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Which config to use, which package is the governance root, and what to return for each environment | [Config File](./config-file.md): `defineConfig`, loaders, `mode`, and `command` |
| Whether to persist analysis and which additional files affect validity                             | [Analysis Cache](./config-file.md#cache): `cache` and `cache.dependencies`      |
| Which packages and nested package scopes belong to the run                                         | [Regions](./regions.md): `scope.regions`                                        |
| Which source files need checking coverage                                                          | [Source Boundary](./source-boundary.md): `scope.source`                         |
| Which checker owns each source config                                                              | [Checker Configuration](./checkers.md): `scope.checkers`                        |
| Who authorizes source imports, and how to check unused code                                        | [Source Checks](./source-checks.md): `source`                                   |
| Which project references, packages, or built-in module dependencies are forbidden                  | [Graph Rules](./graph-rules.md): `graph.rules` and labels in source configs     |
| Which specific files temporarily do not require ordinary checking coverage                         | [Proof Allowlist](./proof-allowlist.md): `proof.allowlist`                      |
| Which built outputs need checking                                                                  | [Package Checks](./package-checks.md): `package.entries`                        |
| How to check packed files and workspace publish dependencies                                       | [Release Checks](./release-checks.md): `release`                                |
| How to combine tasks and control execution resources                                               | [Pipelines](./pipelines.md) and [Execution Concurrency](./execution.md)         |

## Suggested Configuration Order

First choose the project root for the config and run the default checks. Use the report to review the package scope, expected source files, and checkers. Add graph rules when you need to constrain dependency directions. When you need to publish packages, configure output entries and artifact checks. Omitting top-level `graph`, `source`, and `proof` does not disable their default tasks.

Source tsconfigs use `liminaOptions` for labels, declaration relationships invisible to static analysis, and user artifact outputs. If you need to split TypeScript configurations, start with [Core Concepts](../concepts.md).
