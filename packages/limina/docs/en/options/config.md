# Config File

Limina reads configuration from `limina.config.mjs` inside the workspace. It usually lives at the workspace root:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {},
});
```

Config can also be a function:

```js
export default defineConfig(({ command, mode }) => ({
  config: {
    // return different entries for CI, local, or release usage
  },
}));
```

`mode` comes from `--mode`, then `NODE_ENV`, then `default`.

## `mode`

Function configs are useful when local, CI, or release workflows need different checkers, rules, or package entries. The environment-specific differences stay in one reviewable config file.

Prefer `command` branching for package output entries that only matter to package and release commands. Reserve `mode` for broader environment-level differences.

## `command`

`command` is the command family currently loading the config, such as `check`, `graph`, `paths`, `package`, or `release`. Use it when expensive configuration only matters for one command family.

For example, declare package output entries only for package-aware commands:

```js
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
limina.config.mjs
packages/core/
  src/index.ts
  dist/package.json
```

The config can declare package output only for package-aware commands:

```js
export default defineConfig(({ command }) => ({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: 'tsconfig.build.json',
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
