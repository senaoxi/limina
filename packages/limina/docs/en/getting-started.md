# Getting Started

## Requirements

Limina expects a pnpm workspace and an ESM config file.

- Node.js `^20.19.0 || >=22.12.0`
- A `pnpm-workspace.yaml` at the workspace root
- TypeScript installed in the consuming repository
- `limina.config.mjs` inside the workspace

## Install

::: code-group

```sh [pnpm]
pnpm add -D limina typescript
```

:::

## Pick an Adoption Path

If your workspace does not yet have a Limina config, start with `limina init`. It writes a `limina.config.mjs` that uses auto mode, adds the root script, ensures `.limina/` is ignored, and can install the optional Limina agent skill for this project.

If your repository already has a clear tsconfig convention, write the minimal `limina.config.mjs` directly. Auto checker discovery is enough for many workspaces; use [Checker Entries](./config/checkers.md) when you need explicit checker routing.

## Initialize an Existing Workspace

For a pnpm monorepo that has not adopted Limina's declaration graph layout yet, run:

```sh
pnpm exec limina init
```

`limina init` searches upward for the nearest `pnpm-workspace.yaml`, confirms the workspace root, and writes Limina config files.

For non-interactive environments, use:

```sh
pnpm exec limina init --yes
```

`--yes` accepts the core init confirmations but skips the optional skill installation. To install the skill manually later, run:

```sh
npx --yes skills add senaoxi/docs-islands --skill limina
```

Initialization can create or update:

- a root `limina.config.mjs`;
- a root `.gitignore` entry for `.limina/`;
- a root `limina:build` script;
- missing root `limina` and `typescript` dev dependencies.

::: warning
Generated checker graphs are written later under `.limina/` by `limina graph prepare` and by graph-consuming commands.
:::

When graph preparation fails, it usually means `checker.include` matched a reserved or non-source tsconfig. Narrow `include` or add `exclude` entries until only ordinary source configs are selected.

After initialization, run:

```sh
pnpm i
pnpm limina:build
```

::: tip
You only need `pnpm i` when init changed dependencies or created a root `package.json`.
:::

## Minimal Manual Config

Create `limina.config.mjs` at the workspace root:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      mode: 'auto',
    },
  },
});
```

Writing `mode: 'auto'` out makes the config clear at a glance: Limina will find source `tsconfig.json` files and send each one to `tsc` or `vue-tsc` based on its contents. If a `tsconfig.json` should stay out of that scan for now, put it in `exclude`; `limina init` starts with an empty array so you can add paths directly.

Add a root script:

```json
{
  "scripts": {
    "limina:build": "limina checker build"
  }
}
```

Run it:

```sh
pnpm limina:build
```

This build-first entry prepares Limina's checker graph and runs the checkers that support build mode. Once that build path is stable, run `pnpm exec limina check` to turn on the full check flow. The default check includes these tasks. Results are displayed and recorded in this order, while scheduling can run tasks concurrently when the concurrency budget and resource locks allow it:

1. `graph:check` (which prepares the generated graph first)
2. `source:check`
3. `proof:check`
4. `checker:build`
5. `checker:typecheck`

When the run fails, use the failed task to choose the next layer to inspect. The same output can contain multiple failed tasks:

- `graph:check` usually points to imports, generated project references, package dependencies, or label rules that are out of sync;
- `source:check` usually points to file ownership, cross-package relative imports, dependency declarations, or `#imports`;
- `proof:check` usually points to checker includes, generated declaration coverage, or allowlists that do not cover source files;
- `checker:build` means a build-capable checker such as `tsc`, `tsgo`, or `vue-tsc` found type errors;
- `checker:typecheck` means a typecheck-only runner such as `vue-tsgo` or `svelte-check` found type errors.

For example, if `@acme/app` adds an import from `@acme/core` and `pnpm exec limina check` reports a `graph:check` problem, start with the importing file and source tsconfig shown in the report. Re-run the same command after the fix to confirm graph, source ownership, coverage proof, and checker execution together.

## Add Framework Checkers

Limina can also run framework-aware checkers. Add another checker entry when part of the workspace needs it:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        include: ['packages/**/tsconfig.json'],
        exclude: ['packages/web/tsconfig.json'],
      },
      vue: {
        preset: 'vue-tsc',
        include: ['packages/web/tsconfig.json'],
      },
    },
  },
});
```

Checker entries are always `tsconfig.json` files. If a package has `tsconfig.lib.json` or `tsconfig.test.json`, reference them from that package's `tsconfig.json`; Limina will follow those references.

Built-in presets are `tsc`, `tsgo`, `vue-tsc`, `vue-tsgo`, and `svelte-check`. Install the matching package when you enable a checker; `tsgo` and `vue-tsgo` require `@typescript/native-preview`. Limina parses Vue SFC imports with its built-in heuristic by default. If you opt into `config.imports.vue: 'compiler-sfc'`, also install `@vue/compiler-sfc`.
