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

Config can also be a function:

```ts
export default defineConfig(({ command, mode }) => ({
  config: {
    // return different entries for `CI`, local, or release usage
  },
}));
```

Function configs are useful when local, `CI`, or release workflows need different checkers, rules, or package entries. The environment-specific differences stay in one reviewable config file.

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

Function configs are useful when local, `CI`, or release workflows need different checkers, rules, or package entries. The environment-specific differences stay in one reviewable config file.

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

`command` is the command family currently loading the config, such as `check`, `graph`, `source`, `package`, or `release`. The open string branch covers other current commands such as `build` and `migration`, and keeps function configs forward-compatible with additional command families. Use it when expensive configuration only matters for one command family.

For example, declare package output entries only for package-aware commands:

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

Normal graph and proof checks then stay independent from package output configuration.

In a fuller example, the directory can look like this:

```text
limina.config.mts
packages/core/
  src/index.ts
  dist/package.json
```

The config can declare package output only for package-aware commands:

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

The result is that everyday local checks do not care whether `dist` exists, while package and release checks explicitly require `packages/core/dist` to be built and valid as package output.
