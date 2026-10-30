# Getting Started

This guide starts with a small TypeScript project. You'll run a check, introduce an uncovered file, and use the report to fix it. Then you'll see how to adopt Limina in an existing project. Limina checks source scope and dependencies and runs checkers. Your existing tools still handle production builds.

## Requirements

This documentation describes the development version in the current repository. The npm release may not include the configuration shown here, even if its version number is the same. First build and install the source version that matches this documentation. If you use a published release, consult the documentation for that release instead.

This source version requires Node.js `^22.22.3 || ^24.15.0 || >=26.0` and TypeScript `>=5.4.0 <5.10.0 || >=6.0.0 <6.1.0`. Other Limina releases declare their own peer dependency ranges.

The examples use pnpm and ESM. Limina also supports npm, Yarn, and Bun workspaces and single-package projects. In an existing project, use its usual package manager.

### Build the development version {#install}

Clone Limina into a directory that is not part of another workspace:

```sh
git clone https://github.com/senaoxi/limina.git
cd limina
```

If the documentation footer shows a commit ID, check out that commit first: run `git checkout <commit>` with the actual ID. If you are reading a local development preview, you can use the source directory that produced it.

In the Limina source directory, use the pnpm version specified by the repository's `packageManager` field to install dependencies and build:

```sh
pnpm install --frozen-lockfile
pnpm run build
```

This produces the Limina and migration-tool build directories in the repository. It does not publish either package.

Next, create an example project alongside the `limina` directory:

```sh
cd ..
mkdir limina-example
cd limina-example
```

## Try a small project

<span id="run-the-first-check"></span>

Create these files in the new `limina-example` directory:

`package.json`:

```json
{
  "name": "limina-example",
  "private": true,
  "type": "module"
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "types": []
  },
  "include": ["src/**/*.ts"]
}
```

`src/index.ts`:

```ts
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
```

The example uses `types: []` so it does not depend on other environment types. Keep the type environment your existing project needs. Install the Limina build and a compatible TypeScript version:

```sh
pnpm add -D file:../limina/packages/limina/dist typescript@~6.0.3
```

The `file:` path installs the built package. It assumes the `limina` source directory and `limina-example` are siblings; adjust it if your directories differ.

Create a config in the same directory:

`limina.config.mjs`:

```js
import { defineConfig } from 'limina';

export default defineConfig({});
```

The empty config enables the default checks. Limina discovers this project's `tsconfig.json` and uses the TypeScript checker. Add `.limina/` to the project's `.gitignore`, then run:

```sh
pnpm exec limina check
```

The check creates internal configs, declarations, build caches, and check records under `.limina/`. When the example succeeds, the output includes `limina check passed` and a task summary. The framework typecheck is `disabled` because the example has no Astro or Svelte targets. That status means there was no applicable work, not that a framework check ran.

### See how a check finds an omission

Add `scripts/tool.ts`:

```ts
export const tool = true;
```

Run `pnpm exec limina check` again. By default, Limina expects this TypeScript file to be covered, but the example's `tsconfig.json` includes only `src`. The `proof:check` task reports `LIMINA_PROOF_UNCOVERED_SOURCE_FILE`.

To see the file in the saved result:

```sh
pnpm exec limina check --issues --task proof:check --verbose
```

If the script belongs to the project source, add it to `tsconfig.json` and rerun the check:

```json
{
  "include": ["src/**/*.ts", "scripts/**/*.ts"]
}
```

This fragment shows only the field to change; keep the existing `compilerOptions`. If the script needs a different type environment, you can give it a separate source config and include that config through an entry. If the file should not be governed in this run, adjust the [source scope](./config/source-boundary.md) rather than adding an allowlist entry just to remove the error.

## Adopt Limina in an existing project

<span id="pick-an-adoption-path"></span>

Build the development version as described above, then install it in the root of the project you want to check. Keep an existing compatible TypeScript version. These examples assume your project and the `limina` source directory are siblings:

::: code-group

```bash [pnpm single package]
pnpm add -D file:../limina/packages/limina/dist
```

```bash [pnpm workspace root]
pnpm add -D -w file:../limina/packages/limina/dist
```

:::

Adjust the `file:` path for your layout. For other package managers, use their local-package installation method.

### Choose the workspace scope {#selecting-a-config-inside-a-monorepo}

<span id="governance-root"></span>

When installing at a workspace root, use the package manager's root-dependency option. Limina uses the directory of the selected config's nearest `package.json` as its root and reads that root's own workspace declaration. A config in a child package selects that package's scope; an ancestor workspace does not automatically expand it. See [Config File](./config/config-file.md#governance-root) for discovery rules.

### Create a config {#minimal-manual-config}

<span id="initialize-an-existing-project"></span>

If the project already has a Limina config, start with that config. During default discovery, `limina.config.mts` takes precedence over `limina.config.mjs`. Otherwise, create the `limina.config.mjs` shown above in the selected root, or use the initialization command.

::: warning Initialization changes project files
`limina init` may create or modify `limina.config.mts`, `.gitignore`, `package.json`, and dependencies. It also deletes the root `.limina/`, including saved check and migration records. A new `.mts` config takes precedence over an existing `.mjs` config in the same directory. Review and save anything you need first. `--yes` accepts core initialization confirmations, including overwriting an existing config or conflicting script.
:::

In the selected project directory, run:

```sh
pnpm exec limina init
```

Initialization searches upward for the nearest `package.json` and creates a config beside it. It does not add workspace declarations or rewrite source tsconfigs. If it changes dependencies or creates a manifest, reinstall dependencies as prompted. The generated `limina:build` script runs Limina's internal declaration build, not a production bundle. See [CLI Reference](./cli.md#limina-init) for other initialization behavior.

The default source scope includes `.ts`, `.tsx`, `.mts`, `.cts`, and corresponding declaration files. A `limina.config.mts` therefore also needs coverage by a suitable `tsconfig`, or an exclusion from `scope.source` when appropriate. Otherwise it may be reported as uncovered, like the script above. A manually created `.mjs` config does not match those default TypeScript patterns by extension.

For example, if the `.mts` file created by `limina init` should not be checked and is not included by a `tsconfig`, add an exclusion under `scope.source`:

`limina.config.mts`:

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  scope: {
    source: { exclude: ['...', 'limina.config.mts'] },
  },
});
```

The `...` keeps the default exclusions and adds this config file. Merge the exclusion into any existing source-scope config. If `scope.source.exclude` already has an array, add `limina.config.mts` to that array. Alternatively, include the file in an appropriate `tsconfig` and run the check again.

### Existing project references {#migrate-existing-project-references-first}

If a `tsconfig` that **directly includes source** declares native `references` by hand, first organize those configs. Use the separate `limina-migrate` package built from the same source as `limina`. Assuming the project and source directory are siblings, run this at a pnpm workspace root:

```sh
pnpm add -D -w file:../limina/packages/migrate/dist
pnpm exec limina-migrate --dry-run --yes
```

For a single-package project, omit `-w` and adjust the path as needed. Review the preview's scope and write plan. The migration tool does not write project files during the preview, but the config module still executes. When ready, run `pnpm exec limina-migrate`, review the result, and run `pnpm exec limina check`. Migration does not replace a full check or guarantee equivalence to native `tsc -b`. See [Migration](./cli.md#limina-migration) for eligibility, writes, and recovery.

### Use Vue, Astro, or Svelte {#using-vue-astro-or-svelte}

<span id="configure-checker-ownership"></span>

Selecting a framework checker and selecting files that need coverage are separate steps. The default source scope does **not** include `.vue`, `.astro`, or `.svelte` files. Add them explicitly when needed. If a managed `tsconfig` includes Vue components but Limina's source scope does not, the coverage check may report a boundary mismatch. Make the two scopes agree.

For example, to check `src/App.vue` in an existing single-package Vue and TypeScript project:

1. Install a supported `vue-tsc` in the checker's execution scope. This version is supported by the current source version. In a pnpm workspace, choose the installation location according to the project's dependency management:

   ```sh
   pnpm add -D vue-tsc@3.2.4
   ```

2. Include the components in the `tsconfig` responsible for Vue source. This fragment shows only `include`; retain the existing compiler options and other necessary patterns. If `tsconfig.json` is an aggregator, edit the Vue source config it references:

   ```json
   {
     "include": ["src/**/*.ts", "src/**/*.vue"]
   }
   ```

3. Add Vue files to the expected source scope in the Limina config:

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

Run `pnpm exec limina check` and inspect both coverage and the `vue-tsc` build result. `...` retains the default TypeScript patterns. Vue uses `checker:build`. If there are no Astro or Svelte targets, `checker:typecheck` being `disabled` does not mean Vue was skipped.

::: details If the Vue check fails

If `proof:check` reports `App.vue` as uncovered, first check that the responsible source `tsconfig` includes it. If it reports a source-boundary mismatch instead, compare the files included by `scope.source` and the `tsconfig`. A successful coverage check alone does not mean the component passed type checking.

If `checker:build` fails but the summary does not show the compiler error, run `pnpm exec limina checker build` to rerun the internal declaration builds and inspect their output. This can write under `.limina/`; it is not a production build. See [Troubleshooting](./troubleshooting.md#checker-build-diagnostics) for details.

:::

For Astro or Svelte, add `**/*.astro` or `**/*.svelte` as needed and include the files in the corresponding framework config. They require different checker dependencies, and Astro also needs generated types first. See [Checker Configuration](./config/checkers.md#framework-prerequisites) for dependency locations, supported versions, and prerequisites. `scope.source` alone does not change a framework checker's own file selection.

## Read the result and continue

The default `limina check` examines project references, source ownership, package imports, and expected source coverage, then runs applicable checkers. It does not include package or release checks. Tasks may run concurrently; see [Built-in Tasks](./built-in-tasks.md) for their responsibilities and statuses.

On failure, start with the task name, issue code, and file path, then consult [Troubleshooting](./troubleshooting.md). To change which packages, files, or checkers participate, start with [Configuration Reference](./config/index.md). For the motivation behind these constraints, read [Why Limina](./why.md).
