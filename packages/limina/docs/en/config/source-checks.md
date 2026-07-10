# Source Checks

::: warning
The top-level `source` option configures two parts of `source:check`: `source.importAuthority` controls source import authorization, and `source.knip` controls `Knip`-driven unused workspace dependency and unused source module checks. It is different from `config.source`, which defines the global source boundary used by coverage proof. For that option, see [Source Boundary](./source-boundary.md).
:::

`source check` is mainly about making source imports explainable by package ownership and dependency declarations. Limina starts from the packages activated by the current `pnpm` workspace, including nameless workspace packages identified by path. Each workspace package root manifest is its source owner.

A nested `package.json` stops the current governed region by default, and a nested `pnpm-workspace.yaml` is always a hard boundary. With [`regions.extendNestedPackageScopes`](./regions.md#extendnestedpackagescopes), an eligible nameless nested manifest can remain inside the surrounding region: its source inherits the outer workspace owner and dependency authority, while the nested manifest remains the package scope for relative imports and `#imports`. [`regions.exclude`](./regions.md#exclude) can then remove recognized units or boundary roots from the current run. Imports into any stopped or excluded region are treated as cross-boundary access.

Its `Knip`-backed branch uses package entries instead of `include` / `exclude` to report unused workspace dependencies and unused source modules from Limina's workspace-package module sets.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: {
    importAuthority: {
      allow: {},
    },
    knip: {
      workspaces: {},
    },
  },
});
```

## importAuthority

`source.importAuthority` controls bare package imports that are not declared by the owning workspace package manifest.

Source import authorization is strict by default: the nearest `pnpm` workspace package that owns the importing file must declare the package in `dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies`. An owner-keyed grant can let that same source owner use dependency declarations from the workspace root `package.json` for selected packages. The root manifest must exist and must still declare the package in one of the same dependency sections.

Here, “source import” includes static imports, type imports, and re-exports collected by Limina. `Node` builtins, virtual modules, `URL` / `data` / `file` specifiers, and specifiers found only in comments are not treated as ordinary bare package dependencies.

Use `allow` when a workspace root dependency declaration is intentionally shared with a specific source owner:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: {
    importAuthority: {
      allow: {
        '@example/create-app': [
          {
            include: ['templates/react/**'],
            workspaceRootDependencies: ['react', 'react-dom'],
            reason: 'React template sources use dependencies declared by the workspace root.',
          },
        ],
      },
    },
  },
});
```

```ts
interface SourceImportAuthorityConfig {
  allow?: Record<string, SourceImportAuthorityWorkspaceRootGrant[]>;
}

interface SourceImportAuthorityWorkspaceRootGrant {
  include?: string[];
  workspaceRootDependencies: string[];
  reason: string;
}
```

`allow` keys must match source owner identities that remain in the current governed region after `regions` is applied. Named workspace packages use their package name, and nameless source owners use their workspace-root-relative package directory. `include` is optional and owner-root-relative; when omitted, the grant applies to all governed source modules owned by that source owner.

`workspaceRootDependencies` is not a direct import allowlist. It names package keys whose declarations may be read from the workspace root manifest when the owner grant and `include` scope match. Limina still requires the root manifest to declare the package, and it will not bypass an intermediate workspace package manifest between the source owner and the workspace root.

Prefer an owner manifest dependency whenever the import is part of that owner's actual runtime.

## knip

- **Type:** `boolean | SourceKnipCheckConfig`
- **Default:** `true`

`source.knip` controls the `Knip`-backed parts of `source:check`: unused workspace dependencies and unused source modules.

Use `knip: true` or omit the option to use Limina's generated default `Knip` config. Use `knip: false` to skip these `Knip`-backed checks. Use an object to configure Limina's semantic `Knip` rules by workspace package name:

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

`source.knip.workspaces` keys are named source owners that remain in the current governed region, such as `@acme/app`. Unknown or excluded package names fail `source check`. Nameless workspace packages can still be source owners, but they cannot be configured under `source.knip.workspaces` because there is no stable package name `key`.

`source.knip.workspaces[pkg]` only configures extra reachability and ignore rules. Package-specific `Knip tsconfig` selection comes from static direct `limina build <config>` scripts. If a package does not declare one, Limina runs Knip for that package without `--tsConfig`, so `Knip` uses its own default `tsconfig` behavior.

A static package script can override that default and give Limina a package-specific `Knip tsconfig` source:

```json
{
  "scripts": {
    "build": "limina build tsconfig.json"
  }
}
```

The `<config>` path is resolved from the package directory. It must be a `JSON` file inside the workspace. Managed scripts must point at a Limina-managed config whose output build module exists. Raw package-script configs must use `--raw --preset <tsc|tsgo|vue-tsc>`, stay inside the owning package directory, and never point at generated `.limina` configs. Limina supports only direct static forms such as `limina build tsconfig.json`, `limina build tsconfig.dts.json --raw --preset tsgo`, `pnpm limina build tsconfig.json`, and `pnpm exec limina build tsconfig.json`. Dynamic Shell scripts such as `limina build $CONFIG` are reported as unsupported.

::: warning
`knip` is an optional peer dependency of Limina. If `source.knip` is enabled but `knip` is not installed in the workspace running Limina, `source check` fails with a missing peer dependency error.
:::

Limina disables `Knip`'s implicit `index` / `main` / `cli` entry guessing by writing `entry: []` for governed owner workspaces. Default reachability still includes package manifest entries (`exports`, `main`, `module`, `browser`, `bin`, `types`, `typings`), `Knip` plugin-discovered entries, package scripts, and Limina-generated virtual entries for application-style owners.

When package entries point at build artifacts, `Knip` may need a `tsconfig` with enough `rootDir` / `outDir` information to map those artifacts back to source files. In managed mode, declare that layout with `liminaOptions.outputs` on the source leaf and point a static `limina build <config>` package script at the managed source or aggregator config. For a package-local hand-authored build `tsconfig`, use `limina build <config> --raw --preset <checker>`.

This is a general package design pattern: `package.json` describes the built files that consumers import, while the selected source tsconfig describes the source tree that writes those files. For example, `@docs-islands/utils` can expose only built files:

```json
{
  "exports": {
    "./env": "./dist/src/env.js"
  }
}
```

Then the source leaf can describe the source-to-output layout:

```json
{
  "liminaOptions": {
    "outputs": {
      "rootDir": ".",
      "outDir": "./dist"
    }
  },
  "compilerOptions": {
    "module": "ESNext"
  },
  "include": ["src/**/*.ts"]
}
```

As long as the `Knip tsconfig`, whether `Knip`'s default or Limina's derived one, explains the source and output directories, such as `rootDir: "."` and `outDir: "./dist"`, `Knip` can map `utils/dist/src/env.js` back to `utils/src/env.ts`. The source module is then considered reachable from the package entry.

Expose that intent through a static package script:

```json
{
  "scripts": {
    "build": "limina build tsconfig.json"
  }
}
```

If the derived `Knip tsconfig` does not clearly describe `outDir` / `rootDir`, `Knip` can see the `dist` entry but may not find the source module behind it. That source file may be reported as unused. Prefer fixing `liminaOptions.outputs` or using an explicit raw `limina build <config> --raw --preset <checker>` package-local config over adding tool-only package export conditions just to satisfy `Knip`.

Limina also determines `Knip`'s `project` file set automatically from checked source modules. Users do not configure `project`.

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

Entry configs must use positive workspace-root-relative `glob` patterns inside the keyed package directory and a non-empty reason.

### workspaces[pkg].ignoreDependencies

- **Type:** `Array<{ dep: string; reason: string }>`

`source check` verifies that workspace packages declared in `package.json` are reachable from the importing package's public entry graph. This applies to every workspace package, including the workspace root.

For dependencies used by generated code, runtime strings, or another path `Knip` cannot see, add an ignore entry under the importing package key.

Ignore entries must name an existing workspace package in `dep` and a dependency pair still declared in the keyed importer package manifest. If the dependency is intentionally retained, keep the reason close to the config; if it is no longer needed, remove the dependency instead.

### workspaces[pkg].ignoreFiles

- **Type:** `Array<{ file: string; reason: string }>`

Use `ignoreFiles` only when a source module is intentionally retained but not visible to `Knip`.

Ignore entries must use a workspace-root-relative file path that stays inside the repository and a non-empty reason. The file must belong to the keyed package's source module set known to Limina.
