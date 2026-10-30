# Config File

Limina looks for a project config, such as `limina.config.mjs` or `limina.config.mts` beside `package.json`. Start with the defaults and add fields when you need to change checking scopes or rules:

`limina.config.mjs`:

```js
import { defineConfig } from 'limina';

export default defineConfig({});
```

An `.mts` or `.ts` config can itself enter the default source scope. If no project `tsconfig` covers it, adjust coverage or source scope as described in [Getting Started](../getting-started.md#minimal-manual-config).

A config module can export an object, a `Promise`, or a function that receives `{ command, mode }`. `defineConfig` provides type hints and preserves its input; Limina handles loading and validation. See the [configuration overview](./index.md) for each field's responsibility.

## Default checks {#default-governance}

The default `limina check` schedules five tasks: `graph:check`, `source:check`, `proof:check`, `checker:build`, and `checker:typecheck`. `scope` selects inputs and Checkers; top-level `graph`, `source`, and `proof` configure rules, exceptions, and optional capabilities. Omitting a domain does not disable its task. `package.entries` and `release` do not add default tasks.

Set `source.knip: true` to add Knip analysis. `false` retains source ownership, tsconfig governance, import boundaries, and package dependency authorization.

An exported `{}` schedules all five default tasks with default inputs and policies. It does not guarantee success: source within the governance boundary must still have valid ownership and checker coverage. If you configure `graph`, `source`, or `proof`, provide the required fields instead of an empty object:

- `graph` requires `rules`. Use `rules: {}` when there are no additional rules.
- `proof` requires `allowlist`. Use `allowlist: []` when there are no exceptions.
- `source` requires at least one of `knip`, `declarations`, or `importAuthority`. `declarations` requires `ambient`, and `importAuthority` requires `allow`; their empty forms are `ambient: []` and `allow: {}`. The object form of `knip` requires `root` or `workspaces`.

The `graph`, `source`, and `proof` domains and their nested fields do not accept an explicit `undefined`. Omit a field when you want its default. Unknown fields, invalid types, and empty domains fail at loading. Checks report paths, ownership, and coverage problems that require examining the workspace.

Config factories and Promises are evaluated before validation and task selection. To omit a field such as `source` conditionally, use an object spread rather than `source: undefined`. Compute dynamic values inside the factory, then return ordinary data.

::: details Configuration data constraints

`graph`, `source`, and `proof` must be own data properties. Top-level domains may be non-enumerable; nested fields must be enumerable data properties on plain objects or arrays. These domains reject accessors, proxies, inherited fields, and cycles. Validation preserves `false` and empty collections without filling defaults or stripping fields. Knip's `Symbol.toStringTag` string marker is metadata and cannot make an otherwise empty `knip` object valid.

:::

Every default governance task appears in the current plan. Failed required preparation marks dependent tasks as `blocked`; a planned framework check without targets remains `disabled`. Named pipelines record only their declared tasks and required preparation. `check --issues` reads the saved invocation without rerunning checks; a configuration error before a new attempt leaves the previous record historical. Standalone `graph check`, `source check`, and `proof check` also run without their top-level domain.

## Config Discovery and Governance Root {#governance-root}

Limina selects the config module first. Without `--config`, it searches upward from the current working directory, checking `limina.config.mts`, `limina.config.mjs`, `limina.config.ts`, and `limina.config.js` in that order in each directory. It then finds the nearest `package.json` above the selected config's directory to establish the governance root. If that nearest manifest is unreadable, not a regular file, invalid JSON, or not an object at the top level, loading fails there instead of skipping it.

Only that root's own workspace declarations determine membership. Without a declaration, the root package is the only package before region exclusions. An empty `{}` is sufficient: name, version, package manager, and lockfiles are all optional. Missing, ambiguous, or invalid package-manager metadata does not block governance that needs no package-manager semantics.

Within the selected root, `pnpm-workspace.yaml` takes precedence and can establish pnpm unless an explicit `packageManager` conflicts with it. `package.json#workspaces` requires an unambiguous npm, Yarn, or Bun identity: the root's `packageManager` takes precedence, otherwise same-directory lockfiles are used. Missing authority, ambiguity, or invalid declarations cause failure. A valid workspace remains a workspace even when its final membership contains only the root package.

Supported declaration forms are pnpm's `packages: string[]` (omission means no child packages), npm's `workspaces: string[]`, and the array or `{ packages: string[] }` form for Yarn and Bun. Package-manager adapters preserve their respective membership-selection and ignore rules. The package manager remains responsible for valid dependency catalogs, installability, version availability, and lockfile consistency.

In this documentation, `config.rootDir` means the governance root determined by the loader. It is a resolved runtime value, not a user-configurable field or TypeScript's `compilerOptions.rootDir`. Unless stated otherwise, paths in the Limina config are relative to this directory.

Once the same config is selected, invoking it from different directories preserves the same governance root. A repository root config governs its workspace; a child package config uses its nearest package manifest. The config module's directory need not itself be the package root. Explicit `--config` paths are relative to the command's current working directory.

```sh
pnpm exec limina --config ./limina.config.mts check
```

See [Regions](./regions.md) for workspace membership discovery and exclusion rules.

### Locating Issue Records

Read-only `check --issues` does not import the config, resolve package-manager membership, or run checks. An explicit `--config` is only a location anchor, so the module may already have been deleted or renamed; the nearest `package.json` above its directory must still exist and be valid. Without `--config`, an existing default config must be discoverable. Missing records do not trigger fallback to an ancestor workspace.

## Config Loader

- **Type:** `'native' | 'tsx'`
- **Default:** `'native'`
- **CLI:** `--config-loader native` or `--config-loader tsx`

The `native` loader imports the config directly through the current runtime and follows its module rules. An existing `limina.config.js` can therefore use CommonJS when Node treats it as CommonJS; `.mts` and `.mjs` use ESM. Use `tsx` when the config contains TypeScript syntax that the current runtime cannot import natively. The `tsx` loader uses `tsx/esm/api`, so install `tsx` in the adopting workspace first.

## `cache` {#cache}

- **Type:** `boolean | CacheOptions`
- **Default:** `true`

`cache` controls Limina's persistent analysis cache. Omission and `true` enable it, including automatic module dependency observation. `false` prevents restoring and publishing persistent analysis models, leaves existing snapshots in place, and keeps configuration loading, ordinary input observation and execution-time drift checks active. In-memory caches, checker build caches such as TypeScript/Vue `.tsbuildinfo`, issue records and other independent outputs retain their normal behavior.

Object form enables caching and requires `dependencies: string[]`. An empty array is valid; `{}` is invalid. Unknown fields such as `enabled` and `force` are rejected. `CacheOptions` is exported from `limina`.

`check` can read and publish eligible models. Standalone graph/source consumers keep their existing read-only permission; enabling `cache` does not grant every command publication authority. `limina check [pipeline] --force` skips restoration for this invocation and normally publishes the new eligible result. With `cache: false`, force has no additional effect on persistent analysis caching and does not enable writing. Force does not delete snapshots in this configuration, other configurations or other worktrees, and does not force checker rebuilds. It remains incompatible with `--issues`.

When a cache is valid, Limina can reuse saved analysis. Changed inputs cause affected parts to be analyzed again. Restoration still checks inputs such as type entries, source coverage, project references, and output configuration. Actual type diagnostics and builds are performed separately by the checker.

### `cache.dependencies` {#cache-dependencies}

- **Type:** `string[]` (required in object form)
- **Default:** no additional files with omitted `cache` or `cache: true`

With caching enabled, a warm run can reuse a validated analysis model; a cold run analyzes the current inputs again. Both evaluate the configuration in a fresh CLI process. Declare local files that affect configuration or checking but are read outside Node's module system.

For example, create a `rules.json` file beside the Limina config:

```json
{
  "browser": {
    "deny": {
      "deps": [{ "name": "node:*", "reason": "Browser code cannot depend on Node built-ins" }]
    }
  }
}
```

This `limina.config.mjs` reads the file with `fs.readFileSync()` and declares it as a cache dependency:

```js
import { defineConfig } from 'limina';
import { readFileSync } from 'node:fs';

const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8'));

export default defineConfig({
  cache: { dependencies: ['./rules.json'] },
  graph: { rules },
});
```

Merge these fields into any existing config. The `browser` rule only applies to source configs that use that label; see [Graph Rules](./graph-rules.md) for how to apply it.

A declared file need not be read by configuration code: policy files and manually maintained invalidation markers also participate in validity. `cache: { dependencies: [] }` enables caching without declaring extra files.

Paths are relative to the selected configuration file's directory, including when that directory differs from the governance root. Absolute paths and `../` are supported. Paths are normalized, duplicate declarations are merged, and symbolic link bindings are retained. A file already observed as a module keeps its module role. Declarations may name missing files; this does not make a direct `readFileSync()` call tolerate their absence. Missing inputs are tracked: creation, deletion, link retargeting, and changes to the declared set participate in cache invalidation. Directories, glob patterns, URLs, empty paths, and non-string entries are rejected; recursive watching and callbacks are unsupported.

Declared files share the configuration input snapshot. Equal file mtimes reuse the previous content hash; changed mtimes hash that file again. A touch with identical bytes can remain warm. Different bytes invalidate the entire configuration's previous analysis model even when the evaluated configuration values are unchanged. Restoring a file's old mtime and binding can conceal changes under this trust policy; use `--force` to rebuild the analysis snapshot when that trust does not hold.

Limina captures declarations after configuration evaluation and rereads observed bytes and checks bindings before analysis use and analysis-snapshot publication. These within-command checks compare captured bytes directly, independently of the cross-process mtime/hash shortcut. Drift aborts the command without replaying completed checker or write operations. This cannot prove that an earlier direct `fs` read saw the same bytes as dependency registration. Arrange external producers so files remain stable throughout configuration evaluation and checking.

### Automatic module observation and its limits

Each independent CLI process evaluates the current configuration. Synchronous Node runtime hooks observe actual ESM imports, executed `import(variable)`, CJS requests and `createRequire()` requests during that loading phase, including their original specifiers, resolved targets, conditions, attributes, file bindings and observable loader output. Changing the actual loaded modules or resolution relations invalidates prior analysis. An unexecuted dynamic import does not add a dependency or by itself prevent a warm run.

This mechanism covers reliably observable module-loading facts; it does not discover every JavaScript side effect. Declare JSON, YAML, text and other local files read outside the module system. Ordinary configurations can still use caching without an exhaustive JavaScript I/O audit. Unobserved source, opaque module schemes or otherwise incomplete loader evidence keep analysis cold. Native and tsx execution remain supported; tsx CommonJS paths whose extension hooks bypass source observation remain cold. Unrecognized custom Node startup `--require`, `--import`, `--loader` and corresponding `NODE_OPTIONS` overrides are rejected before evaluation because they can leave stale module-resolution state. Start without those overrides; for supported transformation use `pnpm exec limina --config-loader tsx check`.

A configuration factory may execute imports before returning data. Executable callbacks retained in the returned configuration and opaque values cannot obtain a stable effective configuration version, so they do not restore or publish a persistent analysis model. Loading after observation ends has no automatic dependency guarantee. The supported model is a fresh CLI process per command, not configuration hot updates in an embedding process.

`cache.dependencies` only describes files. Environment variables, network requests, clocks, random values and external services are outside its scope. The effective configuration version protects the values it actually represents, not hidden behavior. Keep such inputs explicit in the evaluated data when possible; use the existing cold/unknown behavior or `--force` when their validity cannot be established. Issue-only `check --issues` continues to query records without evaluating configuration.

## `mode`

- **Type:** `string`
- **Precedence:** `--mode` → `NODE_ENV` → `'default'`

`mode` passes an environment name to the config function; the function decides what changes. For example, `limina --mode ci check` passes `mode: 'ci'` without automatically enabling a set of CI rules.

## `command`

- **Type:** `'check' | 'graph' | 'package' | 'proof' | 'release' | 'source' | (string & {})`

`command` identifies the command family loading the config. The open string type also accommodates current values such as `build` and `migration`; it does not mean every value names a top-level command.

| Invocation                                                 | `command` received by the config function         |
| ---------------------------------------------------------- | ------------------------------------------------- |
| `check`, `check <name>`                                    | `'check'`                                         |
| `graph ...`, `source check`, `proof check`                 | `'graph'`, `'source'`, or `'proof'`, respectively |
| `package check`, `release check`                           | `'package'` or `'release'`, respectively          |
| `checker build`, `checker typecheck` without a config path | `'check'`                                         |
| `checker build <config>`, `build <config>`                 | `'build'`                                         |
| `limina-migrate`                                           | `'migration'`                                     |

Package output entries serve package and release checks, but `outDir` also participates in workspace output discovery and source filtering. Keep an entry during daily checks if its directory must be recognized as output then.

If the project does not need these outputs declared during daily checks, entries can instead be supplied by command family:

```ts
import { defineConfig } from 'limina';

export default defineConfig(({ command }) => ({
  ...(command === 'package' || command === 'release'
    ? {
        package: {
          entries: [{ name: '@acme/core', outDir: 'packages/core/dist' }],
        },
      }
    : {}),
}));
```

With this config, daily `check` runs do not receive these entries, while standalone `package check` and `release check` require the corresponding outputs to have been built.

A named pipeline loads the config once with `command: 'check'`. Its `package:check` and `release:check` steps do not reload the config under their own command families. To use package outputs in a pipeline, return the entries during that config evaluation. For example, supply entries when `mode === 'release'`, then run `limina --mode release check publish`. External commands do not cause config re-evaluation either.

## Public API

The public `limina` entry exports `defineConfig`, config and issue types, and validation error classes. `limina/internal/*` is for repository-internal use; its source exports are removed from published packages and are not consumer APIs.

## Configuration structure {#config-domains-migration}

`scope` selects governance regions, source, and checker entries. `graph`, `source`, `proof`, `package`, `release`, `pipelines`, `concurrency`, and `cache` are top-level fields. Configure them as needed; omitted fields use their respective defaults.

Paths do not all share the same base. Source and region selectors are relative to the governance root, `config.rootDir`, while `cache.dependencies` is relative to the config file. `package.entries[].outDir` participates in output discovery and source filtering even when package checks are not running. See the [configuration overview](./index.md) for what each field does.
