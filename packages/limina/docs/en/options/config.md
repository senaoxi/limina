# Config File

Limina reads configuration from `limina.config.mjs` inside the workspace. It usually lives at the workspace root:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  strict: true,
  config: {},
});
```

Config can also be a function:

```js
export default defineConfig(({ command, mode }) => ({
  strict: mode === 'ci',
  config: {
    // return different entries for CI, local, or release usage
  },
}));
```

`mode` comes from `--mode`, then `NODE_ENV`, then `default`.

## `mode`

Function configs are useful when local, CI, or release workflows need different checkers, rules, or package entries. The environment-specific differences stay in one reviewable config file.

Prefer `command` branching for package output entries that only matter to package and release commands. Reserve `mode` for broader environment-level differences.

## `strict`

`strict` is a top-level boolean. It defaults to `false` so existing projects keep the same behavior after upgrading.

Set `strict: true` when the workspace is ready for Limina's full structural model:

```js
export default defineConfig(({ mode }) => ({
  strict: mode === 'strict' || mode === 'ci',
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: 'tsconfig.build.json',
      },
    },
  },
}));
```

In strict mode, the existing command surface stays the same, but `graph:check`, `source:check`, `proof:check`, `package:check`, and `release:check` enforce extra modeling constraints. Typecheck leaves must have same-named declaration leaves, declaration leaves must extend their companions and keep the same file set except for declaration/build output options, build graph configs may only reference build aggregators or declaration leaves, source ownership must stay under the nearest `package.json`, workspace source imports must resolve to source graph-owned files, and built or packed package manifests must not expose `workspace:`, `link:`, `file:`, or `catalog:` dependency specifiers.

## `command`

`command` is the command family currently loading the config, such as `check`, `graph`, `source`, `package`, or `release`. Use it when expensive configuration only matters for one command family.

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
