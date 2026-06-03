# Source Coverage

Source settings define Limina's global source boundary for coverage proof. `proof check` uses this boundary to decide which files must be covered by checker entries or an allowlist. `source check` owns package authority and ordinary typecheck ownership checks separately; its unused workspace dependency branch is Knip-backed and uses package entries instead of `include` / `exclude`. In `strict: true`, `source check` also uses Knip to report unused source modules from Limina's package owner module sets.

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

`include` is the global source glob set that Limina should inspect. When it is omitted, Limina starts with `**/*.ts`, `**/*.d.ts`, `**/*.tsx`, `**/*.cts`, `**/*.d.cts`, `**/*.mts`, `**/*.d.mts`, `**/*.mjs`, and `**/*.json`, then adds framework extensions from active checkers such as `**/*.vue` or `**/*.svelte`. It then applies the default exclude list.

If every TypeScript, TSX, and Vue file under `packages/**/src` should be governed, put those globs in `include`. New files then automatically become part of source and proof checks.

## `exclude`

`exclude` is the directory or glob set that should stay outside source governance. Use it for `dist`, `.tsbuild`, fixtures, generated caches, and other files that should not be treated as governed source. When `exclude` is omitted, Limina reads the workspace root `.gitignore` and always also excludes `nx.json`, `project.json`, `tsconfig.json`, `**/tsconfig.*.json`, `dist`, `.nx`, `.git`, `.tsbuild`, `coverage`, and `node_modules`.

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

`source check` verifies that workspace packages declared in `package.json` are reachable from the importing package's public entry graph. This applies to every workspace package, including the workspace root.

Limina delegates this unused dependency analysis to Knip. It scans dependency names in `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`. If the dependency name matches a package from the pnpm workspace, Limina expects Knip to prove the dependency is reachable from package entries such as source-facing `exports`, package `bin` entries, scripts, or Knip-supported tool/plugin entries.

Because the source manifest best practice is to expose source entries directly, those exports naturally become Knip entries. If a package owner has no `package.json#exports` field, Limina treats it as an application-style owner: it generates a temporary Knip entry that imports the full owner source module set, so dependency usage may be proven by any module governed by that package.json. An import that exists only in an unreachable dead file no longer proves a dependency is used for exported package owners; in strict mode, that dead file itself is also reported as an unused source module. Separately, `source check` still verifies ordinary typecheck config ownership for `tsconfig*.json` files excluding `tsconfig*.dts.json`, `tsconfig*.build.json`, `tsconfig*.base.json`, and `tsconfig*.check.json`.

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

## `additionalEntries`

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

## `unusedModules.ignore`

`source check` enables unused source module detection automatically when `strict: true`. Use an ignore entry only when a strict-mode source module is intentionally retained but not visible to Knip:

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
