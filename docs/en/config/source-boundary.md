# Source Boundary

`config.source` selects governed source files. `proof check` compares this set with checker entries, generated graph projects, and the allowlist to find missing files or inconsistent coverage. Top-level `source` instead configures import authorization, ambient declarations, and optional Knip checks; see [Source Checks](./source-checks.md).

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

## `include`

- **Type:** `string[]`

`include` is the global set of source globs Limina needs to check. Explicit `include` and `exclude` values must be non-empty arrays of non-empty strings, with at most one `...` in each array. When omitted, Limina uses the default TypeScript source globs. An explicit value replaces the defaults; use the exact string `...` where you want to expand the default set.

Patterns are relative to `config.rootDir` and may contain `../`. They only filter source candidates already discovered within each activated package's independent governance scope, or package island. Patterns cannot make inactive directories or paths behind an owner-local boundary visible. Default discovery also runs for external activated packages.

::: details Default `include` globs
`**/*.ts`, `**/*.tsx`, `**/*.d.ts`, `**/*.cts`, `**/*.d.cts`, `**/*.mts`, and `**/*.d.mts`.
:::

Checker extensions are not added automatically. To govern both the default TypeScript source and Vue files under `packages/**/src`, expand the defaults and explicitly add the Vue glob. New matching files then enter source and coverage-proof checks automatically.

## `exclude`

- **Type:** `string[]`

`exclude` lists directories or globs that stay outside the governed source set. Use it for fixtures, generated caches, and other files that should not be treated as checked source. When omitted, Limina uses the default exclusions.

An explicit `exclude` replaces the default set and stops using the root `.gitignore`. Use the exact string `...` where you want to expand the defaults, including the root `.gitignore`. An explicit array without `...` disables default file filters; structural region boundaries, fixed discovery ignores, and validated output roots still constrain the candidate set. The root `.gitignore` applies only to candidates inside `config.rootDir`, never to external activated packages.

::: details Default exclusions
`node_modules`, `bower_components`, `jspm_packages`, validated output roots from `package.entries` and currently visible `liminaOptions.outputs` declarations, and the root `.gitignore` for candidates inside `config.rootDir` only.
:::

Declaring `liminaOptions.outputs: {}` makes `./dist`, relative to that source config, an output root; an explicit `outDir` uses the specified path instead. Without an `outputs` declaration or a package output entry, Limina does not infer an output merely from the name `dist`. Output paths apply only to the declaring config or package entry, not to every directory with the same name.

`liminaOptions.outputs.outDir` is relative to the declaring source config. Limina reads it only from structurally reachable tsconfigs that are not already inside unconditional package-entry outputs. The declaration remains effective only while that tsconfig stays visible in the stable workspace output calculation.

## Review the tsconfig When Excluding Files

`config.source.exclude` changes only Limina's governed source set. It does not rewrite a checker's `files`, `include`, or files admitted through imports. If a checker or generated graph still covers those files, `proof check` can report `LIMINA_PROOF_SOURCE_BOUNDARY_MISMATCH`: the two sides describe different file sets.

For example, if `packages/core/src/generated/runtime.ts` is excluded from the source boundary but remains in the effective file set of `tsconfig.lib.json`, adding the exclusion alone does not resolve coverage. Choose according to the file's actual purpose:

- It is project source: keep it in `config.source` and assign it to one source leaf config.
- It is outside this run's governance: also adjust the relevant tsconfig coverage, and watch for imports that can bring it back into the checker.
- It remains governed but intentionally has no ordinary coverage: use a [proof allowlist](./proof-allowlist.md) entry with a reason.

A coverage allowlist explains uncovered files; it does not resolve checker coverage that remains outside the source boundary.
