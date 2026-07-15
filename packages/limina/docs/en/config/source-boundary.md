# Source Boundary

::: warning
`config.source` is the **managed source boundary** that source coverage checks use to decide which files must be covered by checker entries or an allowlist. It is different from the top-level `source` option, which configures source import authorization and `Knip`-driven source usage checks. For that option, see [Source Checks](./source-checks.md).
:::

`config.source` defines Limina's global source boundary for source coverage checks. `proof check` uses this boundary to decide which files must be covered by checker entries or an allowlist.

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

`include` is the global source `glob` set that Limina should inspect. When it is omitted, Limina uses the default TypeScript source glob set. When it is configured, it replaces that default set. Use the exact string `...` to expand the default include set at that position.

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

When `exclude` is configured, it replaces the default exclude bundle and the root `.gitignore` is not used. Use the exact string `...` to expand the default exclude bundle, including root `.gitignore`, at that position. An explicit `exclude` array without `...` disables every default exclude entry. Root `.gitignore` rules are applied only to candidates inside `config.rootDir`; they never filter candidates from an external activated package.

::: details Default exclude bundle
`node_modules`, `bower_components`, `jspm_packages`, paths corresponding to explicit `liminaOptions.outputs.outDir` declarations in currently visible source configs, and the root `.gitignore` for candidates inside `config.rootDir`.
:::

Only explicitly declared `liminaOptions.outputs.outDir` paths are part of this bundle. Limina does not infer `./dist` as a source exclude unless that source config declares it, and an output directory name is scoped to the config that declares it rather than expanded as a global directory-name exclude.

`liminaOptions.outputs.outDir` is relative to the source config that declares it. Limina reads it only from a structurally reachable `tsconfig` that is not already inside an unconditional package-entry output. The declaration remains active only while that `tsconfig` stays visible in the stable workspace output calculation.

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
