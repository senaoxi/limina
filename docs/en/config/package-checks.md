# Package Checks

Package checks run against the output directories consumers actually install. Build the project first, then select outputs through `package.entries`:

```sh
pnpm build
pnpm exec limina package check --package @acme/core
```

The example below shows a full configuration. If you provide only `name` and `outDir`, all three tools are enabled by default. publint and ATTW must be installed separately and are skipped when absent; see [tool selection](#checks).

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
Package checks analyze metadata and types in the packed artifact, and scan import boundaries in the configured output directory. Results cover the analyzers that ran and the files scanned; they do not prove every runtime or consumer environment. [Release Checks](./release-checks.md) inspect required files and release content separately.
:::

## entries

- **Type:** `PackageEntry[]`

`entries` lists the built package outputs to check. Each entry is an independent output artifact: several entries may share a name, one source package may produce several entries, and an entry name does not have to equal a source package name. Limina does not infer or validate a source-to-output binding from this configuration.

`--package <name>` selects every configured entry with that name. Without it, the validated activated-package index resolves cwd, including lexical paths outside `config.rootDir`. A named activated cwd owner selects all entries of that name when a match exists; otherwise `package check` falls back to all configured entries. An unnamed owner or a cwd outside an activated package also selects all entries. A nearby unactivated `package.json` is not a selector. `release check` requires a matching named cwd owner instead of falling back.

## name

- **Type:** `string`

`name` is the selector name for this output artifact. The `CLI` uses it for `--package <name>`; duplicate names select multiple artifacts.

## outDir

- **Type:** `string`

`outDir` is relative to `config.rootDir` and points at the built package directory consumers actually install, usually `packages/*/dist`. It may contain `../` and target the output of an external activated package. That directory should contain the publish-ready `package.json`, `JavaScript`, and declarations. `limina release check` inspects `README.md`, `LICENSE.md`, and the tarball's release content.

The output is unconditional during workspace discovery. It must be a dedicated output directory: it cannot equal or contain `config.rootDir` or an activated package root, and it cannot overlap Limina's `.limina` namespace in either direction. Invalid output ownership fails `workspace:validate` before package selection or artifact work begins.

::: info
Each `outDir/package.json` must exist and parse as an object with a non-empty name. Built-in manifest checks reject local `workspace:`, `link:`, `file:`, and `catalog:` specifiers in `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`. Optional analyzers perform additional metadata and resolution checks; the built-in checks alone do not validate a complete npm manifest.
:::

Limina also rejects an `exports` root that mixes subpath keys (such as `"."` or `"./foo"`) with condition keys (such as `"import"`). These declaration checks run independently of the selected optional tools. They do not resolve or enumerate all export targets.

Missing export targets in the packed artifact are delegated to publint. If publint is disabled or skipped, target existence has not been checked; passing the remaining checks does not establish a complete publish contract. ATTW checks runtime/type compatibility, without deciding which entries should be public or changing consumer graph results. Package checks do not automatically select every workspace package or expand ATTW entrypoints.

## checks

- **Type:** `Array<'publint' | 'attw' | 'boundary'>`
- **Default:** `['publint', 'attw', 'boundary']`

`checks` selects the tools to run:

- `publint`: consumer-facing package metadata and export issues;
- `attw`: type resolution through Are The Types Wrong;
- `boundary`: emitted `JavaScript` imports, runtime boundaries, and dependency boundaries.

`checks` sets the base tool set. Omitting `publint` or `attw` preserves that set; explicit `false` removes the tool, while explicit `true` or an object adds it. CLI `--tool` filters the resulting enabled set and cannot re-enable a disabled tool. Entries with no enabled checks after filtering are not run; if none remain, `package check` fails.

::: warning
`publint` and `@arethetypeswrong/core` are optional `peer dependency` packages of Limina. If an enabled analyzer is not installed, Limina marks that analyzer as `skipped` and continues the other package checks. A skipped optional analyzer alone does not make `package check` exit non-zero, including when it was selected with `--tool`. Install and verify both packages explicitly in CI when their coverage is required.
:::

Only an absent analyzer package is skipped. If the package is installed but its entry, initialization, syntax or transitive dependencies fail to load, package checking fails and preserves the loading error. Limina determines package presence using the same ESM origin and conditions as the analyzer import.

## publint

- **Type:** `boolean | { strict?: boolean; level?: 'suggestion' | 'warning' | 'error' }`
- **When omitted:** enabled according to `checks`

`publint: true` enables publint with Limina's defaults. `publint: false` disables it for this package entry. The object form enables publint and customizes the options passed to publint.

For example, `checks: ['boundary']` with `publint` omitted runs only the boundary check; adding `publint: true` enables publint as well. `attw` follows the same rule.

### publint.strict

- **Type:** `boolean`
- **Default:** `true`

`publint.strict` controls publint's `strict` option. It is enabled by default.

### publint.level

- **Type:** `'suggestion' | 'warning' | 'error'`

`publint.level` controls the minimum message level requested from publint. Any returned messages at that level make this check fail, including warnings or suggestions; this is a reporting threshold, not a warning-only exit policy.

## attw

- **Type:** `boolean | { profile?: 'esm-only' | 'node16' | 'strict'; level?: 'warn' | 'error'; ignoreRules?: string[]; entrypoints?: string[]; includeEntrypoints?: string[]; excludeEntrypoints?: (string | RegExp)[]; entrypointsLegacy?: boolean }`
- **When omitted:** enabled according to `checks`

`attw: true` enables Are The Types Wrong with Limina's defaults. `attw: false` disables it for this package entry. The object form enables ATTW and customizes Limina filtering plus `checkPackage` entrypoint options.

### attw.profile

- **Type:** `'esm-only' | 'node16' | 'strict'`
- **Default:** `'esm-only'`

`attw.profile` controls the `Are The Types Wrong` profile. Common values are `esm-only`, `node16`, and `strict`.

### attw.level

- **Type:** `'warn' | 'error'`
- **Default:** `'error'`

`attw.level: 'warn'` reports remaining filtered ATTW problems as warnings without failing the check. The default `'error'` fails on those problems. This setting does not suppress the hard failure when ATTW finds no package types, or failures to load or execute the analyzer.

### attw.ignoreRules

- **Type:** `string[]`

`attw.ignoreRules` suppresses problem kinds by rule name, such as `false-cjs`, `cjs-resolves-to-esm`, `no-resolution`, or `named-exports`.

### attw Entrypoint Options

These fields are passed directly to ATTW's `checkPackage`. Use `'.'` for the root entry and, for example, `'./client'` for a subpath:

| Field                | Type                   | Effect                                                                                                                       |
| -------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `entrypoints`        | `string[]`             | Specifies the complete entrypoint set, disables automatic discovery, and overrides the inclusion and exclusion options below |
| `includeEntrypoints` | `string[]`             | Adds entries to those discovered automatically                                                                               |
| `excludeEntrypoints` | `(string \| RegExp)[]` | Excludes matching entries from checking                                                                                      |
| `entrypointsLegacy`  | `boolean`              | Lets ATTW infer legacy entries from published files when no other entries have been discovered or configured                 |

The exact discovery and filtering behavior depends on the installed supported ATTW version. Set `entrypoints` directly when you need explicit coverage. Limina does not expand it to all workspace packages or all exported files.

## boundary.environment

- **Type:** `'browser' | 'node' | (string & {}) | ((relativeFilePath: string) => 'browser' | 'node' | (string & {}))`

`boundary.environment` may be a string or a function of the output-relative file path. Without it, files below `node/` or `plugin/` use `'node'`; all others use `'browser'`. Only the exact `'node'` result permits Node built-ins; a custom environment string does not.

The boundary scan reads `.js`, `.mjs`, and `.cjs` throughout `outDir`, including files not selected for packing. It checks concrete module specifiers returned by `es-module-lexer`; CommonJS `require`, computed dynamic imports, and `import.meta` do not establish covered imports. It does not validate the existence of every relative output import.

## boundary.ignoredExternalPackages

- **Type:** `string[]`

`boundary.ignoredExternalPackages` allows listed external package imports without a declaration in the built package manifest.

## Example: Source Passes, but Output Still Has Problems

Suppose the build leaves an incorrect type entry and a Node import in browser output:

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

After running `limina package check --package @acme/core` on this output, enabled publint / ATTW analyzers that actually run can report type-entry problems; exact diagnostics depend on the tool versions and checked entries. Independently, `boundary.environment: 'browser'` reports the `node:fs` import.

If publint is disabled or skipped because it is missing, export-target existence remains unchecked. Passing the boundary scan cannot replace type-resolution checks; inspect the execution status of every tool.
