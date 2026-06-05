# Source Checks

::: warning
This page documents the top-level `source` option — the **Knip-driven dependency and module reachability checks** run by `source:check`. It is different from `config.source`, which defines the governed-file boundary used by proof coverage. For that option, see [Source Boundary](./source-boundary.md).
:::

`source check` owns package authority and ordinary typecheck ownership checks. Its unused workspace dependency branch is Knip-backed and uses package entries instead of `include` / `exclude`. In `strict: true`, `source check` also uses Knip to report unused source modules from Limina's package owner module sets.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  strict: true,
  source: {
    additionalEntries: [],
    tsconfigOwnership: { ignore: [] },
    unusedDependencies: { ignore: [] },
    unusedModules: { ignore: [] },
  },
});
```

## additionalEntries

- **Type:** `Array<{ owner: string; files: string[]; reason: string }>`

`source check` builds an entry-reachable graph for package-owned source modules. For owners with `package.json#exports`, default entries come from package `exports`, `bin`, scripts, and Knip-supported plugin entries.

For package owners without `package.json#exports`, Limina treats the whole governed source module set as an application-style entry surface. It generates a temporary entry for dependency analysis and skips unused-file coverage for that owner, because every known source module is intentionally part of the application surface.

Some source modules are legitimate entries without being package exports. For example, test runners may load `*.spec.ts` files directly. Add `source.additionalEntries` owner-scoped globs for test runners, local tooling, or build steps that should not become package exports:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  strict: true,
  source: {
    additionalEntries: [
      {
        owner: '@acme/app',
        files: ['packages/app/src/**/*.spec.ts'],
        reason: 'Vitest loads spec modules directly.',
      },
    ],
  },
});
```

Additional entry configs must use a named package owner, positive workspace-root-relative glob patterns inside that owner directory, and a non-empty reason.

## tsconfigOwnership.ignore

- **Type:** `Array<{ owner: string; files: string[]; reason: string }>`

`source check` expects the nearest bare `tsconfig.json` for each governed module to identify one ordinary typecheck owner. The nearest `tsconfig.json` may include the module directly, or it may reach exactly one ordinary typecheck config through transitive `references`.

Limina only follows ordinary typecheck configs in this search. It does not treat `tsconfig*.dts.json`, `tsconfig*.build.json`, `tsconfig*.base.json`, or `tsconfig*.check.json` as ownership configs.

Tests and fixtures may be loaded by tools in ways that do not fit this local tsconfig shape. Keep those modules governed, but skip only this ownership rule with a scoped ignore:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: {
    tsconfigOwnership: {
      ignore: [
        {
          owner: '@acme/app',
          files: ['packages/app/src/**/*.spec.ts'],
          reason: 'Vitest loads test modules directly.',
        },
      ],
    },
  },
});
```

Ignore entries must use a named package owner, positive workspace-root-relative glob patterns inside that owner directory, and a non-empty reason. They only skip nearest-`tsconfig.json` owner resolution; package ownership, import authority, proof coverage, and unused-module checks still run.

## unusedDependencies.ignore

- **Type:** `Array<{ importer: string; dependency: string; reason: string }>`

`source check` verifies that workspace packages declared in `package.json` are reachable from the importing package's public entry graph. This applies to every workspace package, including the workspace root.

Limina delegates this unused dependency analysis to Knip. It scans dependency names in `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`. If the dependency name matches a package from the pnpm workspace, Limina expects Knip to prove the dependency is reachable from package entries such as package `exports`, package `bin` entries, scripts, or Knip-supported tool/plugin entries.

For package owners with `package.json#exports`, those exports become Knip entries. If a package owner has no `package.json#exports` field, Limina treats it as an application-style owner: it generates a temporary Knip entry that imports the full owner source module set, so dependency usage may be proven by any module governed by that package.json. An import that exists only in an unreachable dead file no longer proves a dependency is used for exported package owners; in strict mode, that dead file itself is also reported as an unused source module. Separately, `source check` still verifies ordinary typecheck config ownership for `tsconfig*.json` files excluding `tsconfig*.dts.json`, `tsconfig*.build.json`, `tsconfig*.base.json`, and `tsconfig*.check.json`.

For dependencies used by generated code, runtime strings, or another path Knip cannot see, add an ignore entry:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: {
    unusedDependencies: {
      ignore: [
        {
          importer: '@acme/app',
          dependency: '@acme/runtime',
          reason: 'Loaded by generated code outside the entry-reachable graph.',
        },
      ],
    },
  },
});
```

Ignore entries must name existing workspace packages and a dependency pair that is still declared in the importer package manifest. If the dependency is intentionally retained, keep the reason close to the config; if it is no longer needed, remove the dependency instead.

## unusedModules.ignore

- **Type:** `Array<{ owner: string; file: string; reason: string }>`

::: info
This is a `strict: true` feature. `source check` enables unused source module detection automatically when `strict: true`.
:::

Use an ignore entry only when a strict-mode source module is intentionally retained but not visible to Knip:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  strict: true,
  source: {
    unusedModules: {
      ignore: [
        {
          owner: '@acme/app',
          file: 'packages/app/src/generated/runtime.ts',
          reason: 'Generated runtime module loaded by the framework.',
        },
      ],
    },
  },
});
```

Ignore entries must use a named package owner, a workspace-root-relative file path that stays inside the repository, and a non-empty reason. The file must belong to that owner's source module set known to Limina.
