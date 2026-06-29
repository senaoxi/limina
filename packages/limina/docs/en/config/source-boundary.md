# Source Boundary

::: warning
`config.source` is the **managed source boundary** that source coverage checks use to decide which files must be covered by checker entries or an allowlist. It is different from the top-level `source` option, which configures source import authorization and Knip-driven source usage checks. For that option, see [Source Checks](./source-checks.md).
:::

`config.source` defines Limina's global source boundary for source coverage checks. `proof check` uses this boundary to decide which files must be covered by checker entries or an allowlist.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    source: {
      include: ['packages/**/src/**/*.{ts,tsx,vue}'],
      exclude: ['node_modules', 'dist', '.tsbuild', 'coverage'],
    },
  },
});
```

## include

- **Type:** `string[]`

`include` is the global source glob set that Limina should inspect. When it is omitted, Limina starts with a default glob set, then adds framework extensions from active checkers such as `**/*.vue` or `**/*.svelte`. It then applies the default exclude list.

::: details Default include glob set
`**/*.ts`, `**/*.d.ts`, `**/*.tsx`, `**/*.cts`, `**/*.d.cts`, `**/*.mts`, `**/*.d.mts`, `**/*.mjs`, and `**/*.json`.
:::

If every TypeScript, TSX, and Vue file under `packages/**/src` should be managed by Limina, put those globs in `include`. New files then automatically become part of source and coverage checks.

```js
export default defineConfig({
  config: {
    source: {
      include: ['packages/**/src/**/*.{ts,tsx,vue}'],
    },
  },
});
```

## exclude

- **Type:** `string[]`

`exclude` is the directory or glob set that should stay outside the managed source set. Use it for `dist`, `.tsbuild`, fixtures, generated caches, and other files that should not be treated as checked source. When `exclude` is omitted, Limina reads the workspace root `.gitignore` and always also excludes a fixed list of directories and config files.

::: details Always-excluded entries (in addition to root `.gitignore`)
TypeScript config files, known task-tool config/cache files, `dist`, `.git`, `.tsbuild`, `coverage`, and `node_modules`.
:::

For example, after `include` covers `packages/**/src/**/*.{ts,tsx,vue}`, adding this file makes it part of the source coverage boundary:

```ts
// packages/core/src/generated/runtime.ts
export const runtimeName = 'core';
```

If the file is not covered by a project reachable from a checker entry and is not listed in `proof.allowlist`, `limina proof check` reports it as uncovered source. If a fixture directory should stay outside the managed source set, exclude it explicitly instead of letting it escape by accident.

In a fuller example, the directory can look like this:

```text
packages/core/
  src/index.ts
  src/generated/runtime.ts
  tsconfig.lib.json
```

`config.source.include` covers `packages/**/src/**/*.{ts,tsx,vue}`, so `src/generated/runtime.ts` is considered checked source. When `pnpm exec limina proof check` runs, Limina collects source files matched by `include`, then checks whether each file is covered by a graph project, checker entry, or `proof.allowlist`.

If `runtime.ts` is not covered by any checker, the result is a proof check failure listing it as uncovered source. If it is actually a fixture or cache file, exclude that directory; if it is an intentional exception, add it to `proof.allowlist` with a reason.
