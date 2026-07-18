# Config File

Limina reads configuration from `limina.config.mts` inside the workspace. It usually lives at the workspace root:

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  config: {},
});
```

When `--config` is omitted, Limina searches from the current directory upward to the `pnpm` workspace root. In each directory it checks `limina.config.mts`, `limina.config.mjs`, `limina.config.ts`, then `limina.config.js`. Existing `limina.config.ts` and `limina.config.mjs` files remain supported, but new projects should prefer `limina.config.mts`.

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
      typescript: {
        preset: 'tsc',
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
