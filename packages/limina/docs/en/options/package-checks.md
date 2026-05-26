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

## `name`

`name` is the friendly name for this package entry. The CLI uses it for `--package <name>` and release cwd matching.

## `outDir`

`outDir` points at the built package directory consumers actually install, usually `packages/*/dist`. That directory should contain the publish-ready `package.json`, JavaScript, and declarations. Release-only files and tarball hygiene are checked by `limina release check`.

## `checks`

`checks` selects the tools to run:

- `publint`: consumer-facing package metadata and export issues;
- `attw`: type resolution through Are The Types Wrong;
- `boundary`: emitted JavaScript imports, runtime boundaries, and dependency boundaries.

## `publint.strict`

`publint.strict` controls whether publint runs in strict mode. It is enabled by default.

## `attw.profile`

`attw.profile` controls the Are The Types Wrong profile. Common values are `esm-only`, `node16`, and `strict`.

## `boundary.environment`

`boundary.environment` can be a string or a function receiving the emitted relative file path. Use `'browser'` when the whole package is browser output; return different environments by file path when one output contains both node and browser files.

## `boundary.ignoredExternalPackages`

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

In a fuller example, the directory can look like this:

```text
packages/core/
  src/index.ts
  dist/package.json
  dist/index.js
```

Source `src/index.ts` may already pass checker build/source execution, but consumers install `dist`. When `pnpm exec limina package check --package @acme/core` runs, Limina finds the entry whose `name` matches the CLI filter, then runs the configured `publint`, `attw`, and `boundary` checks inside `packages/core/dist`.

The result can include several output-layer failures: `attw` finds `types` pointing to `missing.d.ts`; `boundary` finds `node:fs` in a browser entry. Package checks validate resolver and runtime behavior for the package consumers receive, not only development-time source.

## Release checks

`limina release check` is separate from `package check`. It uses the same `package.entries` selection, packs the npm tarball, and verifies publish hygiene plus workspace publish dependency consistency against npm registry metadata. It rejects private outputs, missing README/license files, source map files, JavaScript `sourceMappingURL` directives, `workspace:`/`link:` leaks in packed manifests, and publish dependency ranges that do not cover local workspace versions. Without `--package`, it requires the nearest cwd `package.json#name` to match a configured entry. Pass `--package <name>` one or more times to skip cwd matching.
