# Config File

Limina reads a selected configuration module, usually `limina.config.mts` beside the project's `package.json`:

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  config: {},
});
```

When `--config` is omitted, Limina searches the current directory and its ancestors, checking `limina.config.mts`, `limina.config.mjs`, `limina.config.ts`, then `limina.config.js` at each directory. Explicit `--config` is resolved relative to cwd. Execution commands require that module to exist.

The nearest `package.json` above the selected module fixes the governance root. It must be a readable regular file containing a non-null, non-array object. Limina never skips an invalid nearest manifest. Only that root's workspace declarations determine whether the run governs a workspace or one package. See [Governance root](../getting-started.md#governance-root) for manager authority and migration details.

Config-relative selection is stable across invoking directories: choosing the repository root config still governs its workspace; choosing a child config uses the child's nearest manifest. The config directory itself need not be the package root.

Read-only `check --issues` uses an explicit `--config` path as a location anchor, so the module may have been deleted or renamed. It finds and validates the nearest manifest from that path's directory and reads persisted state there, without importing config, resolving manager membership, or running governance. Without `--config`, it must discover a currently existing default config. Missing records never trigger fallback to an ancestor workspace.

`defineConfig` preserves the supplied object, promise, or function and provides configuration typing; runtime loading and schema validation happen in the loader. The public `limina` entry exports this helper, configuration and issue types, and validation error classes. Workspace-only `limina/internal/*` source exports are removed from the published package and are not a consumer API.

Config can also be a function:

```ts
export default defineConfig(({ command, mode }) => ({
  config: {
    // return different entries for `CI`, local, or release usage
  },
}));
```

Use a function config when local, CI, or release workflows need different checkers, rules, or package entries.

::: tip
If `config.checkers` is omitted, Limina uses auto checker discovery. See [Checker Entries](./checkers.md) when you need explicit checker routing.
:::

## config loader

- **Type:** `'native' | 'tsx'`
- **Default:** `'native'`
- **CLI:** `--config-loader native` or `--config-loader tsx`

The native loader imports the config through the current runtime and follows that runtime's module rules. An existing `limina.config.js` can therefore use CommonJS when Node treats the file as CommonJS; `.mts` and `.mjs` use ESM. Use `tsx` when your config relies on TypeScript syntax that the runtime cannot import natively. The `tsx` loader uses `tsx/esm/api`, so install `tsx` in the consuming workspace before using it.

## mode

- **Type:** `string`

`mode` is resolved from `--mode`, then `NODE_ENV`, then `'default'`.

A function config can use `mode` to return different checkers, rules, or package entries for local, CI, and release workflows.

Prefer `command` branching for package output entries that only matter to `package` and `release` commands. Reserve `mode` for broader environment-level differences.

```ts
export default defineConfig(({ mode }) => ({
  config: {
    // return different entries for `CI`, local, or release usage
  },
}));
```

## command

- **Type:** `'check' | 'graph' | 'package' | 'proof' | 'release' | 'source' | (string & {})`
- **Related:** [Checker Entries](./checkers.md)

`command` is the command family loading the config, such as `check`, `graph`, `source`, `package`, or `release`. Its open string type also permits current values such as `build` and `migration`; it does not define additional supported commands. `checker build` without a config path and `checker typecheck` load the `check` family; `checker build <config>` and top-level `build` load `build`. Named `check` pipelines load configuration once with `command: 'check'`, including their package or release steps.

For example, return package output entries only for `package` and `release`:

```ts
export default defineConfig(({ command }) => ({
  package:
    command === 'package' || command === 'release'
      ? {
          entries: [
            {
              name: '@acme/core',
              outDir: 'packages/core/dist',
            },
          ],
        }
      : undefined,
}));
```

With this branch, graph and proof checks do not receive package output entries.

For the following directory:

```text
limina.config.mts
packages/core/
  src/index.ts
  dist/package.json
```

The config can select checkers and return package output for `package` and `release`:

```ts
export default defineConfig(({ command }) => ({
  config: {
    checkers: {
      tsc: {
        include: ['packages/**/tsconfig.json'],
      },
    },
  },
  package:
    command === 'package' || command === 'release'
      ? {
          entries: [
            {
              name: '@acme/core',
              outDir: 'packages/core/dist',
            },
          ],
        }
      : undefined,
}));
```

When `pnpm exec limina check` runs, Limina loads the config for the `check` command and analyzes the pieces needed for graph, source, proof, checker build, and checker typecheck. When `pnpm exec limina package check` or `pnpm exec limina release check` runs, Limina loads the config for that command and reads `package.entries`.

With this branch, everyday checks do not require built output files, while standalone package and release checks require `packages/core/dist`. To put `package:check` or `release:check` in a named `check` pipeline, also return the entries for `command: 'check'`, for example only when `mode === 'release'`, and run `limina --mode release check <name>`. Pipeline steps do not reload configuration for their own command family.
