# Config File

Limina normally reads `limina.config.mts` beside the project's `package.json`. Start with the defaults and add fields when you need to change checking scopes or rules:

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  config: {},
});
```

A config module can export an object, a `Promise`, or a function that receives `{ command, mode }`. `defineConfig` provides type hints and preserves its input; Limina handles loading and validation. See the [configuration overview](./index.md) for each field's responsibility.

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

Output entries needed only for standalone package and release checks can be supplied by command family:

```ts
import { defineConfig } from 'limina';

export default defineConfig(({ command }) => ({
  package:
    command === 'package' || command === 'release'
      ? {
          entries: [{ name: '@acme/core', outDir: 'packages/core/dist' }],
        }
      : undefined,
}));
```

With this config, daily `check` runs do not receive these entries, while standalone `package check` and `release check` require the corresponding outputs to have been built.

A named pipeline loads the config once with `command: 'check'`. Its `package:check` and `release:check` steps do not reload the config under their own command families. To use package outputs in a pipeline, return the entries during that config evaluation. For example, supply entries when `mode === 'release'`, then run `limina --mode release check publish`. External commands do not cause config re-evaluation either.

## Public API

The public `limina` entry exports `defineConfig`, config and issue types, and validation error classes. `limina/internal/*` is for repository-internal use; its source exports are removed from published packages and are not consumer APIs.
