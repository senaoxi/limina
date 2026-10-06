# Source Checks

Top-level `source` configures source import authorization, ambient declaration roles, and optional source-usage analysis. By default, `source check` checks imports against the source-owning package and its dependency declarations. Empty `allow` or `knip` objects are not needed to enable that check.

| Field                         | Purpose                                                                      | When omitted                                                            |
| ----------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `source.importAuthority`      | Grant selected source access to dependencies declared by the governance root | Bare package dependencies must be declared by the source-owning package |
| `source.declarations.ambient` | Mark ambient declaration roles that need explicit management                 | No additional explicit ambient declaration authorization                |
| `source.knip`                 | Check unused workspace dependencies and unused source modules                | Disabled; enabling it requires `knip` to be installed                   |

These fields do not select the global source set. File scope is determined by [`config.source`](./source-boundary.md).

## Package Ownership and Discovery Scope

Limina discovers source within the independent governance scope of each validated, activated package, including external and unnamed packages. The package root manifest determines source ownership and dependency authorization. Source selectors relative to `config.rootDir` may contain `../`, but only filter discovered candidates; they cannot add inactive directories to governance.

By default, a nested `package.json` stops traversal by the outer package. With [`regions.extendNestedPackageScopes`](./regions.md#extendnestedpackagescopes), eligible unnamed nested scopes can remain in the outer region. Their source uses the outer package's dependency declarations, while the nested manifest still defines the package scope for relative imports and `#imports`. See [Regions](./regions.md) for the full rules on nested workspace boundaries and exclusions.

## Resource module imports

`source:check` validates imported physical resources such as CSS, SVG, YAML, and text files without treating them as TypeScript source projects. A resource import is valid only when both of these statements are true:

1. the runtime resolver or filesystem confirms that the physical resource exists; and
2. the current checker project can see type evidence for that import.

Type evidence may come from a checker source file, a concrete declaration file such as `button.d.css.ts`, or an ambient module declaration included by the current project. An ambient declaration does not prove that the resource exists. Conversely, an existing resource without a visible concrete or ambient declaration is not type-complete.

Limina reports these cases from `source:check` only:

| Rule                                            | Meaning                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `LIMINA_SOURCE_RESOURCE_MODULE_NOT_FOUND`       | The physical resource does not exist. This takes precedence over types.       |
| `LIMINA_SOURCE_RESOURCE_MODULE_TYPE_UNDECLARED` | The resource exists, but the current checker project has no type declaration. |

Resource imports do not become declaration providers, provider edges, or project references, and a missing resource does not stop `graph prepare`. Existing TypeScript, JavaScript, JSON, and framework source resolution continues through the configured checker.

A module specifier is checked exactly as written. For `./foo.svg?raw` or `./foo.svg#fragment`, Limina does not remove the query or fragment to inspect `./foo.svg`; the complete specifier is handed to the configured checker, and only the checker's own result decides whether types exist. Such an import is therefore not reported as a missing or undeclared resource on the basis of its suffix. For `package.json#imports` resources such as `#assets/logo.svg`, the physical lookup preserves the complete mapping key. Matching type evidence and package import authority are still required. A successful physical lookup does not establish checker support for every key spelling or the presence of a bundler transformer, and Limina currently provides no way to declare host-specific query semantics.

Virtual and framework-injected module runtime behavior remains unsupported; an ambient declaration alone does not make such a runtime module valid, and Limina does not report it as a missing physical resource.

Vue resource type evidence uses the same supported semantic adapter combinations as graph analysis. See [Vue checker compatibility](./checkers.md#vue-semantic-import-analysis) for versions. Incompatible combinations are reported as toolchain problems, not as missing resource type declarations.

## importAuthority

`source.importAuthority` controls bare package imports that are not declared by the owning workspace package manifest.

Source import authorization is strict by default: the validated source owner manifest must declare the package in `dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies`. An owner-keyed grant can let that same source owner use dependency declarations from the governance root `package.json` for selected packages. The root manifest must declare the package in one of the same dependency sections.

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

`allow` keys must match source owner identities that remain in the current governed region after `regions` is applied. Named workspace packages use their package name, and nameless source owners use their config-root-relative lexical package directory, including `../` when needed. `include` is optional and config-root-relative; it may contain `../` but can only filter governed source owned by the keyed owner. When omitted, the grant applies to all governed source modules owned by that source owner.

`workspaceRootDependencies` is not a direct import allowlist. It names package keys whose declarations may be read from the workspace root manifest when the owner grant and `include` scope match. Limina still requires the root manifest to declare the package, if an intermediate workspace package between the source owner and the root declares that same dependency, the root grant cannot bypass that declaration.

For imports used at runtime by the source owner, prefer declaring the dependency in that owner's manifest.

## declarations.ambient

`source.declarations.ambient` explicitly identifies declaration files that provide an ambient TypeScript role instead of an ordinary package-owned declaration API.

```ts
interface SourceAmbientDeclarationConfig {
  include: string[];
  allowSharedAcrossOwners?: boolean;
  allowTripleSlashReferences?: boolean;
  reason: string;
}

interface SourceDeclarationsConfig {
  ambient?: SourceAmbientDeclarationConfig[];
}
```

Each `include` list contains config-root-relative patterns and may use `../` for an external activated package. These patterns only filter files already discovered from validated package islands; they cannot make an unactivated path or a path behind an owner-local boundary visible. Every rule must match at least one declaration file, and one physical file cannot match multiple rules.

A matched file must have an ambient declaration shape. Managed output declarations, package public declaration entries, and ordinary external declaration modules with imports or exports cannot be reclassified as ambient declarations.

`allowSharedAcrossOwners` defaults to `false`. Set it to `true` only when multiple source owners intentionally consume the same ambient declaration. `allowTripleSlashReferences` also defaults to `false`; it authorizes `/// <reference path="...">` access to a matched declaration, but does not authorize ordinary imports, package dependencies, or `/// <reference types>`.

```js
export default defineConfig({
  source: {
    declarations: {
      ambient: [
        {
          include: ['../shared-types/globals.d.ts'],
          allowSharedAcrossOwners: true,
          reason: 'Applications share the host-provided global declarations.',
        },
      ],
    },
  },
});
```

## knip

- **Type:** `boolean | SourceKnipCheckConfig`
- **Default:** disabled (`source.knip` omitted or set to `false`)

`source.knip` controls the `Knip`-backed parts of `source:check`: unused workspace dependencies and unused source modules.

::: warning
`knip` is an optional peer dependency of Limina. If `source.knip` is enabled but `knip` is not installed in the workspace running Limina, `source check` fails with a missing peer dependency error before source analysis starts. When `source.knip` is disabled, Limina does not resolve or run Knip. Install and verify `knip` explicitly in CI when unused-dependency and unused-module coverage is required.
:::

Use `knip: true` to use Limina's generated default `Knip` config. Use `knip: false` or omit the option to disable these `Knip`-backed checks. Object form enables the checks and must declare `root` or `workspaces` (or both). Use `{ root: {} }` for the governance root package, or `{ workspaces: {} }` when no extra rules are needed:

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
  root?: SourceKnipWorkspaceConfig;
  workspaces?: Record<string, SourceKnipWorkspaceConfig>;
}
```

`source.knip` accepts only `true`, `false`, or the object form above. An empty object, `null`, arrays, scalars, unknown fields, and a non-object `root` or `workspaces` value are invalid configuration.

`source.knip.root` is the only way to configure the governance root package, in both single-package projects and workspaces. It works with or without a package name. Root entries, ignores, build-script inference, multiple tsconfig groups, and findings retain that package's validated ownership. The package must already be active: `root` cannot reactivate an excluded root.

`source.knip.workspaces` keys name active, non-root workspace packages, such as `@acme/app`. Unknown or excluded names fail `source check`. The keys `"."` and the root package's name are rejected even when `root` is absent. Migrate an existing `workspaces[rootPackageName]` block to `root`, preserving its fields. Relative directory keys are not public addressing: Limina maps validated owners to Knip's internal `"."`, relative workspace directories, and analysis targets. It never edits `package.json#workspaces` for this adaptation. Unnamed non-root packages remain owners but have no public name key.

`source.knip.root` and `source.knip.workspaces[pkg]` only configure extra reachability and ignore rules. Package-specific `Knip tsconfig` selection comes from static direct `limina build <config>` scripts. If a package does not declare one, Limina runs Knip for that package without `--tsConfig`, so `Knip` uses its own default `tsconfig` behavior.

A static package script can override that default and give Limina a package-specific `Knip tsconfig` source:

```json
{
  "scripts": {
    "build": "limina build tsconfig.json"
  }
}
```

The `<config>` path is resolved from the package directory. It must be a `JSON` file inside the workspace. Managed scripts must point at a Limina-managed config whose output build module exists. Raw package-script configs must use `--raw --preset <tsc|tsgo|vue-tsc>`, stay inside the owning package directory, and never point at generated `.limina` configs. Limina supports only direct static forms such as `limina build tsconfig.json`, `limina build tsconfig.dts.json --raw --preset tsgo`, `pnpm limina build tsconfig.json`, and `pnpm exec limina build tsconfig.json`. Dynamic Shell scripts such as `limina build $CONFIG` are reported as unsupported. Single-package support does not expand this parser's invocation syntax to npm, Yarn, or Bun wrappers; direct `limina build` remains available in those projects.

Limina disables `Knip`'s implicit `index` / `main` / `cli` entry guessing by writing `entry: []` for governed owner workspaces. Default reachability still includes package manifest entries (`exports`, `main`, `module`, `browser`, `bin`, `types`, `typings`), `Knip` plugin-discovered entries, package scripts, and Limina-generated virtual entries for application-style owners.

When package entries point at build artifacts, `Knip` may need a `tsconfig` with enough `rootDir` / `outDir` information to map those artifacts back to source files. In managed mode, declare that layout with `liminaOptions.outputs` on the source leaf and point a static `limina build <config>` package script at the managed source or aggregator config. For a package-local hand-authored build `tsconfig`, use `limina build <config> --raw --preset <checker>`.

In this example, `package.json` exposes the built files, and the selected source tsconfig describes their source tree. `@example/utils` exposes:

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

With a matching source/output layout, `utils/dist/src/env.js` can correspond to `utils/src/env.ts`. Limina's managed artifact-to-source entries require a selected generated Knip config, a referenced generated output project with explicit `rootDir` / `outDir`, a manifest target inside that output root, and a candidate already in the owner's checked source module set. Directory options alone do not guarantee that every artifact entry becomes reachable; raw/default configs also depend on Knip's own resolution.

Together with the earlier `"build": "limina build tsconfig.json"` package script, this lets Limina select the config for package-entry analysis.

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

### root.entry / workspaces[pkg].entry

- **Type:** `Array<{ files: string[]; reason: string }>`

Use `entry` to add package-owned source roots beyond package exports. For example, test runners may load `*.spec.ts` files directly.

Entry configs must use positive `glob` patterns relative to `config.rootDir`, stay inside the package directory addressed by `root` or `workspaces[pkg]`, and provide a non-empty `reason`. External activated packages use `../`; patterns still only filter the corresponding owner's discovered source modules.

### root.ignoreDependencies / workspaces[pkg].ignoreDependencies

- **Type:** `Array<{ dep: string; reason: string }>`

`source check` verifies that workspace packages declared in `package.json` are reachable from the importing package's public entry graph. This applies to every workspace package, including the workspace root.

For dependencies used by generated code, runtime strings, or another path `Knip` cannot see, add an ignore entry with a reason: use `source.knip.root` for the governance root package and `source.knip.workspaces[pkg]` for a named non-root package.

Ignore entries must name an existing workspace package in `dep` and a dependency pair still declared in the importer manifest addressed by `root` or `workspaces[pkg]`. If the dependency is intentionally retained, keep the reason close to the config; if it is no longer needed, remove the dependency instead.

### root.ignoreFiles / workspaces[pkg].ignoreFiles

- **Type:** `Array<{ file: string; reason: string }>`

Use `ignoreFiles` only when a source module is intentionally retained but not visible to `Knip`.

Ignore entries must use a config-root-relative file path and a non-empty reason. The path may contain `../`, but the file must belong to the known source module set of the package addressed by `root` or `workspaces[pkg]`.
