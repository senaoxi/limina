# Package Checks

Package checks run against built output directories.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  package: {
    entries: [
      {
        name: '@acme/core',
        outDir: 'packages/core/dist',
        checks: ['publint', 'attw', 'boundary'],
        publint: {
          level: 'warning',
        },
        attw: {
          profile: 'esm-only',
          ignoreRules: ['false-cjs'],
        },
        boundary: {
          environment: 'browser',
          ignoredExternalPackages: ['@acme/runtime-polyfill'],
        },
      },
    ],
  },
});
```

::: tip
Package checks validate the resolver and runtime behavior of the directory consumers install. Tarball and publish hygiene are handled separately by [Release Checks](./release-checks.md).
:::

## entries

- **Type:** `PackageEntry[]`

`entries` lists the built package outputs to check. Each entry is an independent output artifact: several entries may share a name, one source package may produce several entries, and an entry name does not have to equal a source package name. Limina does not infer or validate a source-to-output binding from this configuration.

`--package <name>` selects every configured entry with that name. Without `--package`, running from inside an activated package selects entries through the validated activated-package index; lexical paths outside `config.rootDir` remain selectable. A nearby unactivated `package.json` does not become a package selector.

## name

- **Type:** `string`

`name` is the selector name for this output artifact. The `CLI` uses it for `--package <name>`; duplicate names deliberately select multiple artifacts.

## outDir

- **Type:** `string`

`outDir` is relative to `config.rootDir` and points at the built package directory consumers actually install, usually `packages/*/dist`. It may contain `../` and target the output of an external activated package. That directory should contain the publish-ready `package.json`, `JavaScript`, and declarations. `README.md`, `LICENSE.md`, and `tarball` hygiene are checked by `limina release check`.

The output is unconditional during workspace discovery. It must be a dedicated strict descendant output directory: it cannot equal or contain `config.rootDir` or an activated package root, and it cannot overlap Limina's `.limina` namespace in either direction. Invalid output ownership fails `workspace:validate` before package selection or artifact work begins.

::: info
Each `outDir/package.json` must exist and look like a complete `npm` package manifest. Limina rejects `workspace:`, `link:`, `file:`, and `catalog:` specifiers in `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`, because built output should already contain the publish-ready manifest that consumers and `npm` receive.
:::

## checks

- **Type:** `Array<'publint' | 'attw' | 'boundary'>`
- **Default:** `['publint', 'attw', 'boundary']`

`checks` selects the tools to run:

- `publint`: consumer-facing package metadata and export issues;
- `attw`: type resolution through Are The Types Wrong;
- `boundary`: emitted `JavaScript` imports, runtime boundaries, and dependency boundaries.

`checks` selects the base tool set. `publint` and `attw` can also be `true`, `false`, or an object to override that tool: `false` disables it, while `true` or an object enables it with default or custom settings.

::: warning
`publint` and `@arethetypeswrong/core` are optional `peer dependency` packages of Limina. If the corresponding check is enabled but the package is not installed in the workspace running Limina, `package check` fails with a missing `peer dependency` error.
:::

## publint

- **Type:** `boolean | { strict?: boolean; level?: 'suggestion' | 'warning' | 'error' }`
- **Default:** `true`

`publint: true` enables publint with Limina's defaults. `publint: false` disables it for this package entry. The object form enables publint and customizes the options passed to publint.

### publint.strict

- **Type:** `boolean`
- **Default:** `true`

`publint.strict` controls publint's `strict` option. It is enabled by default.

### publint.level

- **Type:** `'suggestion' | 'warning' | 'error'`

`publint.level` controls the minimum message level reported by publint.

## attw

- **Type:** `boolean | { profile?: 'esm-only' | 'node16' | 'strict'; level?: 'warn' | 'error'; ignoreRules?: string[]; entrypoints?: string[]; includeEntrypoints?: string[]; excludeEntrypoints?: (string | RegExp)[]; entrypointsLegacy?: boolean }`
- **Default:** `true`

`attw: true` enables Are The Types Wrong with Limina's defaults. `attw: false` disables it for this package entry. The object form enables ATTW and customizes Limina filtering plus `checkPackage` entrypoint options.

### attw.profile

- **Type:** `'esm-only' | 'node16' | 'strict'`
- **Default:** `'esm-only'`

`attw.profile` controls the `Are The Types Wrong` profile. Common values are `esm-only`, `node16`, and `strict`.

### attw.level

- **Type:** `'warn' | 'error'`
- **Default:** `'error'`

`attw.level: 'warn'` logs remaining ATTW problems without failing the package check. The default `'error'` keeps the existing fail-on-problem behavior.

### attw.ignoreRules

- **Type:** `string[]`

`attw.ignoreRules` suppresses problem kinds by rule name, such as `false-cjs`, `cjs-resolves-to-esm`, `no-resolution`, or `named-exports`.

## boundary.environment

- **Type:** `'browser' | 'node' | (string & {}) | ((relativeFilePath: string) => 'browser' | 'node' | (string & {}))`

`boundary.environment` can be a string or a function receiving the emitted relative file path. Use `'browser'` when the whole package is browser output; return different environments by file path when one output contains both node and browser files.

## boundary.ignoredExternalPackages

- **Type:** `string[]`

`boundary.ignoredExternalPackages` declares the few external imports that are intentionally allowed even if they are not listed in the built package manifest.

For example, source typechecking can pass while the built output still contains problems:

```jsonc
// packages/core/dist/package.json
{
  "name": "@acme/core",
  "exports": "./index.js",
  "types": "./missing.d.ts",
}
```

```js
// packages/core/dist/index.js
import { readFileSync } from 'node:fs';
```

`limina package check --package @acme/core` checks `types`, exports, and runtime imports at the output layer. If the entry uses `boundary.environment: 'browser'`, the remaining `node:fs` import is reported as a browser package boundary problem.

::: details A fuller example
The directory can look like this:

```text
packages/core/
  src/index.ts
  dist/package.json
  dist/index.js
```

Source `src/index.ts` may already pass checker build/source execution, but consumers install `dist`. When `pnpm exec limina package check --package @acme/core` runs, Limina finds the entry whose `name` matches the CLI filter, then runs the configured `publint`, `attw`, and `boundary` checks inside `packages/core/dist`.

The result can include several output-layer failures: `attw` finds `types` pointing to `missing.d.ts`; `boundary` finds `node:fs` in a browser entry. Package checks validate resolver and runtime behavior for the package consumers receive, not only development-time source.
:::
