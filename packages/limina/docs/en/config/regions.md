# Regions

`regions` defines which package scopes belong to the current Limina run. It is a structural boundary: it decides where package ownership, checker discovery, source analysis, generated graphs, and dependency authority apply.

::: warning
`regions.exclude` does not replace `config.source.exclude`. Checker-level `exclude` is still required for individual checker entries inside an activated region. Paths belonging to an excluded or inaccessible region are outside checker `include` discovery by construction, so do not duplicate those paths in checker `exclude`. Use `regions` when an entire recognized package scope or workspace boundary must stay outside the current run.
:::

```ts
interface RegionsConfig {
  extendNestedPackageScopes?: boolean;
  exclude?: RegionExcludeConfig[];
}

interface RegionExcludeConfig {
  kind: 'workspace-package' | 'package-scope' | 'pnpm-workspace';
  include: string[];
  reason: string;
}
```

```js
import { defineConfig } from 'limina';

export default defineConfig({
  regions: {
    extendNestedPackageScopes: true,
    exclude: [
      {
        kind: 'pnpm-workspace',
        include: ['packages/app/fixtures/workspace-a'],
        reason: 'This fixture workspace is validated independently.',
      },
    ],
  },
});
```

## Default Governed Region

Limina starts from the packages activated by the nearest `pnpm-workspace.yaml` at the Limina workspace root. Each activated workspace package is a base governed unit, and its root `package.json` is the owner manifest for source ownership and dependency authorization.

Inside each base unit, boundaries work as follows:

- A nested `package.json` stops governance at that directory by default.
- A nested `pnpm-workspace.yaml` always starts a hard workspace boundary. Limina never continues the current region through it.
- A directory that is not inside an activated workspace package is not part of the current region merely because it is below the workspace root.

For example, with the default configuration:

```text
packages/app/                         governed; packages/app/package.json owns it
packages/app/src/                     governed by the same owner
packages/app/fixtures/package.json    nested package-scope boundary
packages/app/fixtures/src/            outside the current region
packages/app/vendor/pnpm-workspace.yaml  hard workspace boundary
packages/app/vendor/pkg/              outside the current region
```

Automatic checker discovery does not descend into stopped boundaries. If an explicitly selected source config owns or includes files across one of those boundaries, Limina reports the boundary violation instead of silently widening the region.

## extendNestedPackageScopes

- **Type:** `boolean`
- **Default:** `false`

Set `regions.extendNestedPackageScopes` to `true` when a nested `package.json` is a package scope used for resolution, but its source should remain governed by the surrounding workspace package.

A nested `package.json` can be extended only when all of these conditions hold:

1. None of the discovered `pnpm-workspace.yaml` files identifies its directory as a workspace package.
2. The manifest does not have its own `name` field.
3. The directory is not inside a nested workspace boundary.

The `name` check is based on the presence of the field, not whether its value is useful. For example, `"name": ""` and `"name": null` still prevent extension.

Extension is local to the current region. Limina may continue through several consecutive eligible package scopes, but it stops at the first ineligible nested manifest or nested workspace boundary. It cannot use this option to absorb an unrelated directory outside the activated workspace packages.

An extended package scope does not become a new source owner. Its source continues to use the surrounding workspace package's owner manifest and dependency declarations. The nested manifest still remains the nearest package scope for relative-import boundaries and `package.json#imports` resolution.

## exclude

- **Type:** `RegionExcludeConfig[]`
- **Default:** `[]`

Every rule requires `kind`, a non-empty `include` array, and a non-empty `reason`. There is no kind inference or legacy kind-less form.

`include` patterns match only workspace-root-relative candidate root directories. They do not match package names, `package.json` paths, `pnpm-workspace.yaml` paths, or arbitrary files. For a manifest at `packages/app/fixtures/workspace-a/pnpm-workspace.yaml`, select the root with `packages/app/fixtures/workspace-a` or a root glob such as `packages/**/fixtures/**`; `**/pnpm-workspace.yaml` does not select it.

Each kind has one candidate set:

- `workspace-package` selects packages activated by the root `pnpm-workspace.yaml`. It removes the package from ownership, dependency authority, checker discovery, and generated graphs. Use `include: ['.']` to exclude only the root package when it is an activated workspace package; this does not exclude the root workspace or other activated packages.
- `package-scope` selects nested `package.json` roots. It covers both eligible extended scopes and scopes where governance already stops. An excluded scope and all descendants stay outside the current run.
- `pnpm-workspace` selects directories containing nested `pnpm-workspace.yaml` files. Limina applies this exclusion before reading the nested manifest or discovering its packages. The excluded directory remains a hard boundary. The root `pnpm-workspace.yaml` defines the governance origin and cannot be excluded.

A rule is matched only against candidates of the same kind. The same directory may therefore be both a `workspace-package` and a `pnpm-workspace` candidate without the two identities being merged.

After discovery, every rule must have matched at least one candidate of its declared kind. Descriptor paths, fixed discovery ignores such as `node_modules`, `.git`, `.limina`, and configured output directories, and paths belonging only to another kind cannot satisfy a rule. Multiple rules may not match the same candidate; make their patterns non-overlapping instead of relying on array order.

Nested workspaces that are not excluded are inspected strictly. Invalid YAML, invalid pnpm workspace or catalog configuration, unreadable package manifests, package-discovery failures, and missing package identity stop the run. Repair the nested workspace or add a deliberate `pnpm-workspace` exclusion for its root.

Imports from governed source into an excluded or otherwise stopped region are treated as cross-boundary access. Checker entry `references` follow the same structural boundary: checker `exclude` does not make a cross-region reference valid and does not hide an existing ordinary source config reached from an effective entry. Diagnostics identify the boundary root and include the configured reason when one is available; when no registered boundary owns the path, the diagnostic states that no current-run activated workspace package owns it. If the intent is only to omit selected files while keeping the containing package governed, use a file-level source exclusion or checker entry exclusion instead.
