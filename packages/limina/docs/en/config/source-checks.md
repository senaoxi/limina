# Source Checks

::: warning
This page documents the top-level `source` option — the **Knip-driven dependency and module reachability checks** run by `source:check`. It is different from `config.source`, which defines the governed-file boundary used by proof coverage. For that option, see [Source Boundary](./source-boundary.md).
:::

`source check` owns package authority and ordinary typecheck ownership checks. Limina treats pnpm workspace packages as source owners, including nameless workspace packages identified by path. Nested `package.json` files still affect package resolution and form package scopes for relative-import boundaries, but they do not split a source owner unless pnpm reports them as workspace packages.

Its Knip-backed branch uses package entries instead of `include` / `exclude` to report unused workspace dependencies and unused source modules from Limina's source owner module sets.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: {
    importAuthority: {
      allow: [],
    },
    knip: {
      workspaces: {},
    },
  },
});
```

## importAuthority

`source.importAuthority` controls bare package imports that are not declared by the source owner manifest.

Runtime imports are strict by default: the nearest pnpm workspace source owner `package.json` must declare the package in `dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies`. A rule with `packages` lets Limina also check the workspace root `package.json` for the matched package name. The root manifest must exist and must still declare that package in one of the same dependency sections.

For files whose dependencies are intentionally supplied somewhere else, add an explicit allow rule:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: {
    importAuthority: {
      allow: [
        {
          files: ['packages/create-app/templates/react/**'],
          specifiers: ['react', 'react-dom'],
          reason: 'Template files declare these dependencies in generated apps.',
        },
      ],
    },
  },
});
```

```ts
interface SourceImportAuthorityAllowRule {
  files: string[];
  packages?: string[];
  specifiers?: string[];
  owner?: string;
  reason: string;
}

interface SourceImportAuthorityConfig {
  allow?: SourceImportAuthorityAllowRule[];
}
```

`files` are workspace-root-relative globs. `packages` match package names such as `react` or `@components/shared`; when they match, the workspace root `package.json` becomes an additional dependency declaration candidate for that package. `specifiers` match full import specifiers such as `react/jsx-runtime`; use them for true exceptions where no manifest should declare the import. Glob syntax is supported for all three. `owner` is optional; when present it matches a named source owner by package name, or a nameless source owner by workspace-root-relative package directory.

Use this for source that is intentionally not governed by the importing owner manifest, such as project templates or documentation aliases. Prefer a manifest dependency whenever the import is part of the owner's real runtime.

## knip

- **Type:** `boolean | SourceKnipCheckConfig`
- **Default:** `true`

`source.knip` controls the Knip-backed parts of `source:check`: unused workspace dependencies and unused source modules.

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

`source.knip.workspaces` keys are package names discovered from the pnpm workspace, such as `@acme/app`. Unknown package names fail `source check`. Nameless workspace packages can still be source owners, but they cannot be configured under `source.knip.workspaces` because there is no stable package name key.

`source.knip.workspaces[pkg]` only configures extra reachability and ignore rules. It does not accept `tsConfig`. If a package does not declare a static `limina checker build <config>` script, Limina runs Knip for that package without `--tsConfig`, so Knip uses its own default tsconfig behavior.

A static package script can override that default and give Limina a package-specific Knip tsconfig source:

```json
{
  "scripts": {
    "build:types": "limina checker build tsconfig.dts.json --preset tsgo"
  }
}
```

The `<config>` path is resolved from the package directory. It must be a JSON file inside the workspace. Raw package-script configs must stay inside the owning package directory, and generated `.limina` configs are not valid script inputs. Limina supports static forms such as `limina checker build tsconfig.dts.json --preset tsgo`, `limina checker build tsconfig.json --preset vue-tsc`, `pnpm limina checker build tsconfig.dts.json`, and `pnpm exec limina checker build tsconfig.dts.json`. Dynamic shell scripts such as `limina checker build $CONFIG` are reported as unsupported instead of silently falling back to Knip defaults.

::: warning
`knip` is an optional peer dependency of Limina. If `source.knip` is enabled but `knip` is not installed in the workspace running Limina, `source check` fails with a missing peer dependency error.
:::

Limina disables Knip's implicit `index` / `main` / `cli` entry guessing by writing `entry: []` for governed owner workspaces. Default reachability still includes package manifest entries (`exports`, `main`, `module`, `browser`, `bin`, `types`, `typings`), Knip plugin-discovered entries, package scripts, and Limina-generated virtual entries for application-style owners.

When package entries point at build artifacts, Knip may need a tsconfig with enough `rootDir` / `outDir` information to map those artifacts back to source files. In that case, point a static `limina checker build <config>` package script at the config that describes emitted artifact layout.

This is a general package design pattern: `package.json` describes the built files that consumers import, while the selected source tsconfig describes the source tree that writes those files. For example, `@docs-islands/utils` can expose only built files:

```json
{
  "exports": {
    "./env": "./dist/src/env.js"
  }
}
```

Then a package-local JSON build config such as `utils/tsconfig.dts.json` can describe the source-to-output layout:

```json
{
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "./dist"
  },
  "include": ["src/**/*.ts"]
}
```

As long as the Knip tsconfig, whether Knip's default or Limina's derived one, explains the source and output directories, such as `rootDir: "."` and `outDir: "./dist"`, Knip can map `utils/dist/src/env.js` back to `utils/src/env.ts`. The source module is then considered reachable from the package entry.

Expose that intent through a static package script:

```json
{
  "scripts": {
    "build:types": "limina checker build tsconfig.dts.json --preset tsgo"
  }
}
```

If the derived Knip tsconfig does not clearly describe `outDir` / `rootDir`, Knip can see the `dist` entry but may not find the source module behind it. That source file may be reported as unused. Prefer pointing `limina checker build <config>` at the right package-local JSON config over adding tool-only package export conditions just to satisfy Knip.

Limina also determines Knip's `project` file set automatically from checked source modules. Users do not configure `project`.

```js
import { defineConfig } from 'limina';

export default defineConfig({
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

Use `ignoreFiles` only when a source module is intentionally retained but not visible to Knip.

Ignore entries must use a workspace-root-relative file path that stays inside the repository and a non-empty reason. The file must belong to the keyed package's source module set known to Limina.
