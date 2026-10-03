# Getting Started

## Requirements

Limina supports single-package projects and pnpm, npm, Yarn, and Bun workspaces with an ESM config file.

- Node.js `^22.18.0 || >=24.11.0`
- A readable `package.json` whose top level is an object
- TypeScript installed in the consuming project, within the installed Limina version's peer range (currently `>=5.4.0 <5.10.0 || >=6.0.0 <6.1.0`)
- A Limina config module, usually `limina.config.mts`

## Governance root

Limina first selects the config module. Without `--config`, it searches upward from cwd, checking `limina.config.mts`, `limina.config.mjs`, `limina.config.ts`, and `limina.config.js` in that order at each directory. It then searches from the selected config's directory for the nearest `package.json`. That manifest fixes the governance root. An unreadable file, non-file entry, malformed JSON, or non-object manifest fails at that location; Limina does not skip it.

Only workspace declarations at this root determine membership. With no declaration, the root package is the sole package before region exclusions. `{}` is sufficient: name, version, package manager, and lockfile are optional. Missing, ambiguous, or invalid manager metadata does not block governance that needs no manager semantics.

At the selected root, `pnpm-workspace.yaml` takes priority. It identifies pnpm unless an explicit `packageManager` conflicts. A `package.json#workspaces` declaration requires a determinable npm, Yarn, or Bun manager: its own `packageManager` wins, otherwise same-directory lockfiles provide evidence. Missing or ambiguous authority and invalid declarations fail; even a workspace containing only its root stays a workspace.

Limina reads these workspace declarations: pnpm `packages: string[]` (absent means no child packages), npm `workspaces: string[]`, and Yarn/Bun either that array or `{ packages: string[] }`. Manager adapters retain their selection and ignore rules. Catalog validity, installability, version availability, and lockfile consistency remain package-manager responsibilities.

### Selecting a config inside a monorepo

Selecting the repository's root config governs its workspace even when invoked from a child directory. Selecting a child's own config governs the child's nearest manifest; if it has no same-root workspace declaration, it is a single-package project. Ancestor workspace declarations cannot enlarge that scope.

This changes the former ancestor-workspace-first root selection contract. Membership semantics at the same candidate root remain unchanged. Review scripts that select a child config but previously relied on an ancestor workspace. See [Config File](./config/config-file.md).

## Install

::: code-group

```bash [pnpm]
pnpm add -D limina@latest typescript@~6.0.3
```

```bash [npm]
npm install -D limina@latest typescript@~6.0.3
```

```bash [yarn]
yarn add -D limina@latest typescript@~6.0.3
```

```bash [bun]
bun add -d limina@latest typescript@~6.0.3
```

:::

These examples select the TypeScript 6.0 range used by this source version. When installing a different Limina release, check its declared peer range before choosing TypeScript.

The native `tsc` checker uses the TypeScript installation resolved by Limina itself, including version validation and execution. A different `tsc` earlier in PATH or a package-local `.bin` does not override that compiler.

## Pick an Adoption Path

If your project does not yet have a Limina config, start with `limina init`. It writes a `limina.config.mts` with the flat `checkers.auto` configuration, adds the root script, ensures `.limina/` is ignored, and can install the optional Limina agent skill for this project.

You can also write the minimal `limina.config.mts` directly. Use [Checker Entries](./config/checkers.md) when automatic discovery needs explicit checker routing.

## Initialize an Existing Project

For a project that has not adopted Limina's declaration graph layout yet, run:

```sh
pnpm exec limina init
```

`limina init` searches from cwd for the nearest `package.json`, validates it, and writes `limina.config.mts` beside it. An invalid nearest manifest stops initialization. Only when no manifest exists in the ancestor chain does init offer to create one at cwd. Init adds no workspace declaration. `--yes` also works without manager metadata and prints neutral next-step guidance.

Init does not rewrite source tsconfigs. If ordinary source leaves still declare native `references` or need configuration conversion, use the matching `limina-migrate` after initialization; review its input-consumption result, then run `limina check`. See [Workflows](./workflows.md) and the [migration contract](./cli.md#limina-migration).

For non-interactive environments, use:

```sh
pnpm exec limina init --yes
```

`--yes` accepts the core initialization confirmations, including overwriting an existing config or conflicting `limina:build` script, and skips the optional skill installation. To install the skill manually later, run:

```sh
npx --yes skills add senaoxi/docs-islands --skill limina
```

Initialization can create or update:

- a root `limina.config.mts`;
- a root `.gitignore` entry for `.limina/`;
- a root `limina:build` script;
- missing root `limina` and `typescript` dev dependencies.

::: warning
Init removes an existing root `.limina/` directory before writing the config, including generated files and persisted check/migration records. Review existing configuration before rerunning init, especially with `--yes`.

`limina graph prepare` explicitly materializes generated checker files under `.limina/`. Managed `build`, checker execution, and `check` pipelines containing checker or `graph:prepare` tasks also materialize them when needed. Validation-only graph, source, and proof checks calculate the graph in memory without writing those files.
:::

When graph preparation fails, inspect its config path and reason. An invalid checker entry selector, unsupported named solution, ordinary leaf with native `references`, region/input boundary violation, or checker ownership/provider conflict can prevent preparation. Checker `include` selects only default `tsconfig.json` entries; selector exclusions do not cut an already selected entry's references closure.

Initialization reports commands for the selected manager:

| Manager | Install when dependencies changed | Build                  |
| ------- | --------------------------------- | ---------------------- |
| pnpm    | `pnpm install`                    | `pnpm limina:build`    |
| npm     | `npm install`                     | `npm run limina:build` |
| Yarn    | `yarn install`                    | `yarn limina:build`    |
| Bun     | `bun install`                     | `bun run limina:build` |

The following commands use pnpm as an example:

```sh
pnpm i
pnpm limina:build
```

::: tip
You only need `pnpm i` when `limina init` changed dependencies or created a root `package.json`.
:::

## Minimal Manual Config

Create `limina.config.mts` at the workspace root:

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      auto: {},
    },
  },
});
```

Auto discovery is always enabled. Limina finds default source `tsconfig.json` entries inside activated workspace package regions, resolves framework ownership before the ordinary TypeScript fallback, and recursively follows managed references. If individual automatic entries should stay out of root discovery for now, put them in `auto.exclude`; this never cuts the references closure of an entry already in scope.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      auto: {
        exclude: ['**/__tests__/**', 'playground/**'], // [!code focus]
      },
    },
  },
});
```

`limina init` sets `auto.exclude` to an empty array in the generated config.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      auto: {
        exclude: [], // [!code focus]
      },
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

The build entry prepares Limina's checker graph, then runs build-capable checkers. Run `pnpm exec limina check` for the default pipeline below. Results are displayed and recorded in this order; tasks may run concurrently when the concurrency budget and resource locks allow it:

1. `graph:check` (which prepares the checker graph first)
2. `source:check`
3. `proof:check`
4. `checker:build` (checker build)
5. `checker:typecheck` (checker typecheck)

This prepares declaration builds and runs the selected type checkers; it does not build every package's distributable output. Astro/Svelte application builds and other artifact builds remain in the project's own build flow. `checker:typecheck` is disabled when no typecheck targets are discovered, and package/release checks are outside the default pipeline. Inspect disabled, blocked, and skipped outcomes separately from passing checks.

When the run fails, first check the failed tasks and issue summary in the output. The same output can contain multiple failed tasks. Task names identify the broad problem category, while issue codes, file or config paths, failure reasons, and suggested fixes identify the concrete cause. `--issues` reads persisted check state without running checks or importing the config. With current attempt metadata, it returns the latest attempt's completed inventory only when completion is consistent; a running, interrupted, aborted, corrupt, or persistence-failed latest attempt prevents fallback to older issues. You can narrow an available inventory by task.

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

- `graph:check` failures can mean a source relationship cannot form a legal declaration-provider reference, a cross-workspace-package reference lacks a dependency declaration, a graph rule or label denies an edge, or a consumed workspace import cannot be resolved under its checker. Ordinary source leaves must not hand-write native `references`; inspect the reported provider, ownership, or boundary reason before changing selectors or adding `implicitRefs`.
- `source:check` failures usually mean source file ownership or source import authorization did not pass. First check source owners, tsconfig governance, whether relative imports cross the nearest `package.json` package boundary, whether `#...` imports match the importing file's nearest package scope's `package.json#imports`, whether bare package imports are authorized by the workspace source owner's dependency declarations or `source.importAuthority.allow`, and whether enabled Knip analysis reported unused source files or unused dependencies.
- `proof:check` failures usually mean Limina cannot prove that the actual source files are covered by type checking. First check whether ownership is unique, solution leaves have one final owner, declaration build configs match their companion typecheck configs, Astro or Svelte owners have an executable leaf target, and files in `config.source` are covered by checkers, the graph, or `proof.allowlist`.
- `checker:build` failures mean a build-capable checker did not pass. Common causes include non-zero exits from external `tsc`, `tsgo`, or `vue-tsc` commands, missing checker dependencies, or Limina being unable to select a valid build target for the current target. Check the checker, config path, and exit code in the Limina summary first, then inspect the corresponding checker raw log.
- `checker:typecheck` failures mean a framework-owned leaf did not pass. Common causes include non-zero exits from `astro check` or `svelte-check`, missing leaf-local checker or parser dependencies, or missing Astro generated types. Use the Limina summary to identify the owner and config path, then inspect the corresponding issue or raw log.

Start with structural failures in `graph:check`, `source:check`, and `proof:check`, then inspect execution failures in `checker:build` and `checker:typecheck`. Structural checks concern declaration relationships, source ownership, import authorization, and coverage. Checker failures may come from source or framework type errors. This is a suggested reading and repair order; tasks may run concurrently, so it does not imply that earlier failures block later tasks.

## Configure Checker Ownership

Use fixed checker keys when different parts of the workspace need different build owners:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      tsc: {
        include: ['packages/**/tsconfig.json'],
        exclude: ['packages/web/tsconfig.json'],
      },
      'vue-tsc': {
        include: ['packages/web/tsconfig.json'],
      },
    },
  },
});
```

Checker entries are always `tsconfig.json` files. If a package has `tsconfig.lib.json` or `tsconfig.test.json`, declare those project references through `references` from that package's `tsconfig.json`; Limina will follow the project references even when a referenced path matches checker `exclude`. Keep every referenced ordinary source config inside an activated region.

Checker identities are `tsc`, `tsgo`, `vue-tsc`, `astro`, and `svelte-check`; every managed type config finishes with exactly one of them. The first three can emit declarations, while Astro and Svelte execute per leaf without declaration projection. Install the matching package when an owner is active; `tsgo` requires `@typescript/native-preview`. Astro checks and semantic graph analysis require `astro`, `@astrojs/check`, and `typescript` in the owning leaf. Limina obtains Astro's compiler through the installed `@astrojs/check` Language Server toolchain and does not declare a separate `@astrojs/compiler` peer or runtime. Svelte checks and semantic graph analysis require `svelte-check`, `svelte2tsx`, `svelte`, and `typescript` in the owning leaf. Vue semantic graph analysis resolves a supported `vue-tsc` from the checker execution scope and its internal toolchain from that checker installation; applications do not install Language Core or Volar TypeScript for Limina. Standalone import collection accepts only native JavaScript and TypeScript files; framework files require project/checker context.
