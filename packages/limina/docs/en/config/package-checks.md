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
        attw: {
          profile: 'esm-only',
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

`entries` lists the built package outputs to check. Each entry describes one package directory and the tools to run against it.

## name

- **Type:** `string`

`name` is the friendly name for this package entry. The CLI uses it for `--package <name>` and release cwd matching.

## outDir

- **Type:** `string`

`outDir` points at the built package directory consumers actually install, usually `packages/*/dist`. That directory should contain the publish-ready `package.json`, JavaScript, and declarations. Release-only files and tarball hygiene are checked by `limina release check`.

::: info
When top-level `strict: true` is enabled, each `outDir/package.json` must exist and look like a complete npm package manifest. Limina also rejects `workspace:`, `link:`, `file:`, and `catalog:` specifiers in `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`, because built output should already contain the publish-ready manifest that consumers and npm receive.
:::

## checks

- **Type:** `Array<'publint' | 'attw' | 'boundary'>`
- **Default:** `['publint', 'attw', 'boundary']`

`checks` selects the tools to run:

- `publint`: consumer-facing package metadata and export issues;
- `attw`: type resolution through Are The Types Wrong;
- `boundary`: emitted JavaScript imports, runtime boundaries, and dependency boundaries.

## publint.strict

- **Type:** `boolean`
- **Default:** `true`

`publint.strict` controls whether publint runs in strict mode. It is enabled by default.

## attw.profile

- **Type:** `'esm-only' | 'node16' | 'strict'`
- **Default:** `'esm-only'`

`attw.profile` controls the Are The Types Wrong profile. Common values are `esm-only`, `node16`, and `strict`.

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
