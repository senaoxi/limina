# Source Coverage

Source settings define Limina's global source boundary. `source check` uses this boundary for source-owned validations, and `proof check` uses the same boundary for coverage proof.

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

## `include`

`include` is the global source glob set that Limina should inspect. When it is omitted, Limina derives source files from active checker extensions and applies the default exclude list.

If every TypeScript, TSX, and Vue file under `packages/**/src` should be governed, put those globs in `include`. New files then automatically become part of source and proof checks.

## `exclude`

`exclude` is the directory or glob set that should stay outside source governance. Use it for `dist`, `.tsbuild`, fixtures, generated caches, and other files that should not be treated as governed source.

For example, after `include` covers `packages/**/src/**/*.{ts,tsx,vue}`, adding this file makes it part of the proof boundary:

```ts
// packages/core/src/generated/runtime.ts
export const runtimeName = 'core';
```

If the file is not covered by a project reachable from a checker entry and is not listed in `proof.allowlist`, `limina proof check` reports it as uncovered source. If a fixture directory should stay outside governance, exclude it explicitly instead of letting it escape by accident.

In a fuller example, the directory can look like this:

```text
packages/core/
  src/index.ts
  src/generated/runtime.ts
  tsconfig.lib.dts.json
  tsconfig.lib.json
```

`config.source.include` covers `packages/**/src/**/*.{ts,tsx,vue}`, so `src/generated/runtime.ts` is considered governed source. When `pnpm exec limina proof check` runs, Limina collects source files matched by `include`, then checks whether each file is covered by a graph project, checker entry, or `proof.allowlist`.

If `runtime.ts` is not covered by any checker, the result is a proof check failure listing it as uncovered source. If it is actually a fixture or cache file, exclude that directory; if it is an intentional exception, add it to `proof.allowlist` with a reason.

## `unusedDependencies.ignore`

`source check` verifies that workspace packages declared in `package.json` are used by source owned by that package. This applies to every workspace package, including the workspace root.

Limina scans dependency names in `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`. If the dependency name matches a package from the pnpm workspace, Limina expects the importer package to use it through a static source import such as `import`, `export ... from`, `import type`, or dynamic `import()`.

The source scope comes from the global `config.source.include` / `config.source.exclude` boundary. Each matched source file belongs to its nearest `package.json`, and workspace dependency usage is counted only from source owned by the importer package. Separately, `source check` verifies ordinary typecheck config ownership for `tsconfig*.json` files excluding `tsconfig*.dts.json`, `tsconfig*.build.json`, `tsconfig*.base.json`, and `tsconfig*.check.json`.

For dependencies used by generated code, config files, scripts, or runtime strings that static import analysis cannot see, add an ignore entry:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    source: {
      unusedDependencies: {
        ignore: [
          {
            importer: '@acme/app',
            dependency: '@acme/runtime',
            reason: 'Loaded by generated code outside static source imports.',
          },
        ],
      },
    },
  },
});
```

Ignore entries must name existing workspace packages and a dependency pair that is still declared in the importer package manifest. If the dependency is intentionally retained, keep the reason close to the config; if it is no longer needed, remove the dependency instead.
