# Getting Started

## Requirements

Limina expects a pnpm workspace and an ESM config file.

- Node.js `^22.18.0 || >=24.11.0`
- A `pnpm-workspace.yaml` exists at the workspace root
- TypeScript is installed in the consuming repository
- `limina.config.ts` is inside the workspace

## Install

::: code-group

```bash [pnpm]
pnpm add -D limina typescript
```

```bash [npm]
npm install -D limina typescript
```

```bash [yarn]
yarn add -D limina typescript
```

:::

## Pick an Adoption Path

If your workspace does not yet have a Limina config, start with `limina init`. It writes a `limina.config.ts` that uses automatic mode (`mode: 'auto'`), adds the root script, ensures `.limina/` is ignored, and can install the optional Limina agent skill for this project.

If your repository already has a clear `tsconfig` convention, writing the minimal `limina.config.ts` directly is faster. Automatic checker discovery is enough for many workspaces; use [Checker Entries](./config/checkers.md) only when you need explicit checker routing.

## Initialize an Existing Workspace

For a pnpm monorepo that has not adopted Limina's declaration graph layout yet, run:

```sh
pnpm exec limina init
```

`limina init` searches upward for the nearest `pnpm-workspace.yaml`, confirms the workspace root, and writes the Limina config file.

For non-interactive environments, use:

```sh
pnpm exec limina init --yes
```

`--yes` accepts only the core initialization confirmations and skips the optional skill installation. To install the skill manually later, run:

```sh
npx --yes skills add senaoxi/docs-islands --skill limina
```

Initialization can create or update:

- a root `limina.config.ts`;
- a root `.gitignore` entry for `.limina/`;
- a root `limina:build` script;
- missing root `limina` and `typescript` dev dependencies.

::: warning
Generated checker graphs are written under `.limina/` by `limina graph prepare` and by commands that use the graph.
:::

When graph preparation fails, it usually means the checker's `include` matched a reserved config or a non-source `tsconfig`. Narrow `include` or add `exclude` entries until only ordinary source configs are selected.

After initialization, run:

```sh
pnpm i
pnpm limina:build
```

::: tip
You only need `pnpm i` when `limina init` changed dependencies or created a root `package.json`.
:::

## Minimal Manual Config

Create `limina.config.ts` at the workspace root:

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      mode: 'auto',
    },
  },
});
```

Writing `mode: 'auto'` explicitly makes the config state Limina's behavior directly: Limina will find source `tsconfig.json` files and send each one to `tsc` or `vue-tsc` based on its contents. If some `tsconfig.json` files should stay out of that scan for now, put them in `exclude`.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      mode: 'auto',
      exclude: ['**/__tests__/**', 'playground/**'], // [!code focus]
    },
  },
});
```

`limina init` starts with an empty array so you can add paths directly later.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      mode: 'auto',
      exclude: [], // [!code focus]
    },
  },
});
```

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

The build entry prepares Limina's checker graph first, then runs the checkers that support build mode. Once the build path is stable, run `pnpm exec limina check` to turn on the full check flow. The default check includes the following tasks. Results are displayed and recorded in this order, while scheduling can run tasks concurrently when the concurrency budget and resource locks allow it:

1. `graph:check` (which prepares the checker graph first)
2. `source:check`
3. `proof:check`
4. `checker:build` (checker build)
5. `checker:typecheck` (checker typecheck)

When the run fails, first check the failed tasks and issue summary in the output. The same output can contain multiple failed tasks. Task names identify the broad problem category, while issue codes, file or config paths, failure reasons, and suggested fixes identify the concrete cause. `--issues` shows the issues recorded by the most recent check and can narrow them by task.

```sh
pnpm exec limina check --issues
```

You can also inspect only one task category:

```sh
pnpm exec limina check --issues --task graph:check
pnpm exec limina check --issues --task source:check
pnpm exec limina check --issues --task proof:check
pnpm exec limina check --issues --task checker:build
pnpm exec limina check --issues --task checker:typecheck
```

Common next steps:

- `graph:check` failures usually mean source import relationships are not aligned with the TypeScript project graph that Limina generated or validated. First check whether project references inferred from static imports are missing or extra, whether cross-workspace-package references have matching dependency declarations, whether graph rules or labels deny the current dependency edge, and whether workspace imports can be resolved and mapped to the source graph consistently.
- `source:check` failures usually mean source file ownership or source import authorization did not pass. First check source owners, tsconfig governance, whether relative imports cross the nearest `package.json` package boundary, whether `#...` imports match the current source owner's `package.json#imports`, whether bare package imports are authorized by dependency declarations or `source.importAuthority.allow`, and whether Knip reported unused source files or unused dependencies.
- `proof:check` failures usually mean Limina cannot prove that the actual source files are covered by type checking. First check whether checker entries generated the corresponding tsconfig files, whether declaration build configs match their companion typecheck configs, whether files in `config.source` are covered by checkers, the graph, or `proof.allowlist`, and whether the same source file is covered by multiple graph or typecheck owners.
- `checker:build` failures mean a build-capable checker did not pass. Common causes include non-zero exits from external `tsc`, `tsgo`, or `vue-tsc` commands, missing checker dependencies, or Limina being unable to select a valid build target for the current target. Check the checker, config path, and exit code in the Limina summary first, then inspect the corresponding checker raw log.
- `checker:typecheck` failures mean a typecheck-only checker did not pass. Common causes include non-zero exits from external `vue-tsgo` or `svelte-check` commands, missing checker dependencies, or a generated checker entry that cannot execute correctly. Use the Limina summary to identify the runner and config path, then inspect the corresponding issue or raw log.

As a general order, handle structural problems from `graph:check`, `source:check`, and `proof:check` before executor failures from `checker:build` and `checker:typecheck`. The structural checks determine how Limina understands the project graph, source ownership, import authorization, and type-checking coverage; checker failures are usually the result of concrete source or framework type constraints. The default check displays and records issues in the task order above, but tasks can still run concurrently when resources allow it, so this order is an issue-reading and remediation order rather than a guarantee that later tasks are blocked by earlier tasks.

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

Checker entries are always `tsconfig.json` files. If a package has `tsconfig.lib.json` or `tsconfig.test.json`, declare those project references through `references` from that package's `tsconfig.json`; Limina will follow the project references.

Built-in presets are `tsc`, `tsgo`, `vue-tsc`, `vue-tsgo`, and `svelte-check`. Install the matching package when you enable a checker; `tsgo` and `vue-tsgo` require `@typescript/native-preview`. Limina parses Vue SFC imports with its built-in heuristic rules by default. If you opt into `config.imports.vue: 'compiler-sfc'`, also install `@vue/compiler-sfc`.
