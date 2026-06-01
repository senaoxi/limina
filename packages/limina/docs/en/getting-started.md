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

If your workspace does not yet have clear `tsconfig*.dts.json`, `tsconfig.build.json`, and project references, start with `limina init`. It infers the declaration graph it can safely generate from existing `tsconfig*.json` files and stops when the structure is ambiguous.

If your repository already has a stable declaration build graph, write the minimal `limina.config.mjs` directly. In that case, Limina does not redesign the graph; it starts from the checker entry you provide and checks the structure that already exists.

## Initialize an Existing Workspace

For a pnpm monorepo that has not adopted Limina's declaration graph layout yet, run:

```sh
pnpm exec limina init
```

`limina init` searches upward for the nearest `pnpm-workspace.yaml`, confirms the workspace root, scans ordinary `tsconfig*.json` files, and writes the Limina files it can infer.

For non-interactive environments, use:

```sh
pnpm exec limina init --yes
```

Initialization can create:

- paired `tsconfig*.dts.json` declaration configs;
- `tsconfig.build.json` aggregators;
- a root `limina.config.mjs`;
- a root `limina:check` script;
- a missing root `limina` dev dependency.

It refuses ambiguous inputs instead of guessing, including existing `tsconfig*.build.json` or `tsconfig*.dts.json` files and `tsconfig.json` files that mix source files with project references.

When init stops this way, it usually means the repository already has a tsconfig convention. Read the files named in the error, then decide whether to keep the current layout and write config manually, or split that area into an aggregator, declaration leaf, and local companion.

After initialization, run:

```sh
pnpm i
pnpm limina:check
```

You only need `pnpm i` when init changed dependencies or created a root `package.json`.

## Minimal Manual Config

If you already have a declaration build graph, create `limina.config.mjs` at the workspace root:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: 'tsconfig.build.json',
      },
    },
  },
});
```

Add a root script:

```json
{
  "scripts": {
    "typecheck": "limina check"
  }
}
```

Run it:

```sh
pnpm typecheck
```

The default check pipeline runs:

1. `graph:check`
2. `source:check`
3. `nx:check`
4. `proof:check`
5. `checker:build`
6. `checker:typecheck`

The first failure usually tells you which layer to inspect:

- `graph:check` usually points to imports, project references, `workspace:*`, or label rules that are out of sync;
- `source:check` usually points to file ownership, cross-package relative imports, dependency declarations, or `#imports`;
- `nx:check` usually points to a missing or stale `project.json`; its `dependsOn` build edges are derived from `link:` artifact dependencies, so a fresh workspace must run `limina nx sync` first;
- `proof:check` usually points to checker entries, declaration leaves, local companions, or allowlists that do not cover source files;
- `checker:build` means a first-class build execution checker such as `tsc`, `tsgo`, or `vue-tsc` found type errors;
- `checker:typecheck` means a second-class typecheck execution checker such as `vue-tsgo` or `svelte-check` found type errors.

For example, if `@acme/app` adds an import from `@acme/core` and the first `pnpm typecheck` fails in graph checking, start with the importing file and expected reference shown in the report. Re-run the same command after the fix to confirm graph, source ownership, coverage proof, and checker execution together.

## Add Framework Checkers

Limina can also run framework-aware checkers. Add another checker entry when part of the workspace needs it:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: 'tsconfig.build.json',
      },
      vue: {
        preset: 'vue-tsc',
        entry: 'tsconfig.vue.build.json',
      },
    },
  },
});
```

Built-in presets are `tsc`, `tsgo`, `vue-tsc`, `vue-tsgo`, and `svelte-check`. Install the matching package when you enable a checker; `tsgo` and `vue-tsgo` require `@typescript/native-preview`, and `vue-tsc` entries also require `@vue/compiler-sfc` so Limina can parse SFC imports.
