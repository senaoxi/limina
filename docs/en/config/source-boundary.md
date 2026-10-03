# Source Boundary

::: warning
`config.source` is the **managed source boundary** that source coverage checks use to decide which files must be covered by checker entries or an allowlist. It is different from the top-level `source` option, which configures source import authorization and `Knip`-driven source usage checks. For that option, see [Source Checks](./source-checks.md).
:::

`proof check` uses `config.source` to select files that must be covered by checker entries or an allowlist.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    source: {
      include: ['...', 'packages/**/src/**/*.vue'],
      exclude: ['...', 'packages/**/src/generated/**'],
    },
  },
});
```

## include

- **Type:** `string[]`

`include` is the global source `glob` set that Limina should inspect. Configured `include` and `exclude` must each be non-empty string arrays, and each may contain `...` at most once. When it is omitted, Limina uses the default TypeScript source glob set. When it is configured, it replaces that default set. Use the exact string `...` to expand the default include set at that position.

Patterns are relative to `config.rootDir` and may contain `../`. They filter source candidates already discovered from each activated package island; a pattern cannot make an unactivated directory or an owner-local boundary visible. Default discovery also runs for external activated packages.

::: details Default include glob set
`**/*.ts`, `**/*.tsx`, `**/*.d.ts`, `**/*.cts`, `**/*.d.cts`, `**/*.mts`, and `**/*.d.mts`.
:::

Checker extensions are not added automatically. If every default TypeScript source file and every `Vue` file under `packages/**/src` should be managed by Limina, expand the defaults and add the `Vue` glob explicitly. New matching files then automatically become part of source and coverage checks.

```js
export default defineConfig({
  config: {
    source: {
      include: ['...', 'packages/**/src/**/*.vue'],
    },
  },
});
```

## exclude

- **Type:** `string[]`

`exclude` is the directory or `glob` set that should stay outside the managed source set. Use it for fixtures, generated caches, and other files that should not be treated as checked source. When `exclude` is omitted, Limina uses the default exclude bundle.

When `exclude` is configured, it replaces the default exclude bundle and the root `.gitignore` is not used. Use the exact string `...` to expand the default exclude bundle, including root `.gitignore`, at that position. An explicit `exclude` array without `...` disables the default file-filter bundle. Structural region boundaries, fixed discovery ignores, and validated output roots still limit the candidate set. Root `.gitignore` rules are applied only to candidates inside `config.rootDir`; they never filter candidates from an external activated package.

::: details Default exclude bundle
`node_modules`, `bower_components`, `jspm_packages`, validated output roots from `package.entries` and currently visible `liminaOptions.outputs` declarations, and the root `.gitignore` for candidates inside `config.rootDir`.
:::

Declaring `liminaOptions.outputs: {}` already establishes `./dist` relative to that source config as an output root; an explicit `outDir` changes that path. Without an `outputs` declaration or a package-entry output, Limina does not infer a directory merely because it is named `dist`. Output paths remain scoped to the declaring config or package entry rather than becoming global directory-name excludes.

`liminaOptions.outputs.outDir` is relative to the source config that declares it. Limina reads it only from a structurally reachable `tsconfig` that is not already inside an unconditional package-entry output. The declaration remains active only while that `tsconfig` stays visible in the stable workspace output calculation.

For example, after `include` covers `packages/**/src/**/*.{ts,tsx,vue}`, adding this file makes it part of the source coverage boundary:

```ts
// packages/core/src/generated/runtime.ts
export const runtimeName = 'core';
```

If the file is not covered by a project reachable from a checker entry and is not listed in `proof.allowlist`, `limina proof check` reports it as uncovered source. Use `exclude` to keep a fixture directory outside the managed source set.

The example directory contains:

```text
packages/core/
  src/index.ts
  src/generated/runtime.ts
  tsconfig.lib.json
```

`config.source.include` covers `packages/**/src/**/*.{ts,tsx,vue}`, so `src/generated/runtime.ts` is considered checked source. When `pnpm exec limina proof check` runs, Limina collects source files matched by `include`, then checks whether each file is covered by a graph project, checker entry, or `proof.allowlist`.

If `runtime.ts` is not covered by any checker, the result is a proof check failure listing it as uncovered source. If it is actually a fixture or cache file, exclude that directory; if it is an intentional exception, add it to `proof.allowlist` with a reason.
