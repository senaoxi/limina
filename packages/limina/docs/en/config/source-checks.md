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
    knip: {
      workspaces: {},
    },
    tsconfigOwnership: { ignore: [] },
  },
});
```

## knip

- **Type:** `boolean | SourceKnipCheckConfig`
- **Default:** `true`

`source.knip` controls the Knip-backed parts of `source:check`: unused workspace dependencies and, in `strict: true`, unused source modules.

Use `knip: true` or omit the option to use Limina's generated default Knip config. Use `knip: false` to skip these Knip-backed checks. Use an object to configure Limina's semantic Knip rules by workspace package name:

```ts
interface SourceKnipEntryConfig {
  files: string[];
  reason: string;
}

interface SourceKnipIgnoredDependencyConfig {
  dep: string;
  reason: string;
}

interface SourceKnipIgnoredFileConfig {
  file: string;
  reason: string;
}

interface SourceKnipWorkspaceConfig {
  entry?: SourceKnipEntryConfig[];
  ignoreDependencies?: SourceKnipIgnoredDependencyConfig[];
  ignoreFiles?: SourceKnipIgnoredFileConfig[];
}

interface SourceKnipCheckConfig {
  workspaces?: Record<string, SourceKnipWorkspaceConfig>;
}
```

`source.knip.workspaces` keys are package names discovered from the pnpm workspace, such as `@acme/app`. Unknown package names fail `source check`.

::: warning
`knip` is an optional peer dependency of Limina. If `source.knip` is enabled but `knip` is not installed in the workspace running Limina, `source check` fails with a missing peer dependency error.
:::

Limina disables Knip's implicit `index` / `main` / `cli` entry guessing by writing `entry: []` for governed owner workspaces. Default reachability still includes package manifest entries (`exports`, `main`, `module`, `browser`, `bin`, `types`, `typings`), Knip plugin-discovered entries, package scripts, and Limina-generated virtual entries for application-style owners.

When a workspace root has `tsconfig.build.json`, Limina also asks Knip to use that file as the TypeScript graph entry for the workspace. This does not add extra source entries by itself. Instead, it tells Knip how to walk from package entries that point at build artifacts back to the source files that produced them.

This is a general package design pattern: `package.json` describes the built files that consumers import, while `tsconfig.build.json` describes the build graph that tools can use to map artifacts back to source. For example, `@docs-islands/utils` can expose only built files:

```json
{
  "exports": {
    "./env": "./dist/src/env.js"
  }
}
```

Then `utils/tsconfig.build.json` can point at the build config that writes `dist`:

```json
{
  "files": [],
  "references": [
    {
      "path": "./tsconfig.lib.dts.json"
    }
  ]
}
```

As long as the referenced config explains the source and output directories, such as `rootDir: "."` and `outDir: "./dist"`, Knip can map `utils/dist/src/env.js` back to `utils/src/env.ts`. The source module is then considered reachable from the package entry even without an `exports.source` condition.

If `tsconfig.build.json` does not reference the config that actually writes `dist`, or the referenced config does not clearly describe `outDir` / `rootDir`, Knip can see the `dist` entry but cannot find the source module behind it. In `strict: true`, that source file may be reported as unused. Prefer fixing the build reference graph over adding a tool-only `source` condition to `package.json` just to satisfy Knip.

Limina also determines Knip's `project` file set automatically from governed source modules. Users do not configure `project`.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  strict: true,
  source: {
    knip: {
      workspaces: {
        '@acme/app': {
          entry: [
            {
              files: ['packages/app/src/**/*.spec.ts'],
              reason: 'Vitest loads spec modules directly.',
            },
          ],
          ignoreDependencies: [
            {
              dep: '@acme/runtime',
              reason: 'Loaded by generated code outside the entry graph.',
            },
          ],
          ignoreFiles: [
            {
              file: 'packages/app/src/generated/runtime.ts',
              reason: 'Generated runtime module loaded by the framework.',
            },
          ],
        },
      },
    },
  },
});
```

### workspaces[pkg].entry

- **Type:** `Array<{ files: string[]; reason: string }>`

Use `entry` for package-owned source modules that are legitimate direct roots without being package exports. For example, test runners may load `*.spec.ts` files directly.

Entry configs must use positive workspace-root-relative glob patterns inside the keyed package directory and a non-empty reason.

### workspaces[pkg].ignoreDependencies

- **Type:** `Array<{ dep: string; reason: string }>`

`source check` verifies that workspace packages declared in `package.json` are reachable from the importing package's public entry graph. This applies to every workspace package, including the workspace root.

For dependencies used by generated code, runtime strings, or another path Knip cannot see, add an ignore entry under the importing package key.

Ignore entries must name an existing workspace package in `dep` and a dependency pair still declared in the keyed importer package manifest. If the dependency is intentionally retained, keep the reason close to the config; if it is no longer needed, remove the dependency instead.

### workspaces[pkg].ignoreFiles

- **Type:** `Array<{ file: string; reason: string }>`

::: info
This is a `strict: true` feature. `source check` enables unused source module detection automatically when `strict: true`.
:::

Use `ignoreFiles` only when a strict-mode source module is intentionally retained but not visible to Knip.

Ignore entries must use a workspace-root-relative file path that stays inside the repository and a non-empty reason. The file must belong to the keyed package's source module set known to Limina.

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
