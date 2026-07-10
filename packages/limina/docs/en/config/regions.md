# Regions

`regions` defines which package scopes belong to the current Limina run. It is a structural boundary: it decides where package ownership, checker discovery, source analysis, generated graphs, and dependency authority apply.

::: warning
`regions.exclude` does not replace `config.source.exclude` or checker-level `exclude`. Use those options to omit files from a known governed unit. Use `regions` only when an entire recognized package scope or workspace boundary must stay outside the current run.
:::

```ts
interface RegionsConfig {
  extendNestedPackageScopes?: boolean;
  exclude?: RegionExcludeConfig[];
}

interface RegionExcludeConfig {
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
        include: ['packages/app/fixtures'],
        reason: 'Fixtures are checked by their own validation workflow.',
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

`regions.exclude` is applied after Limina recognizes the default units, eligible extended package scopes, and stopped boundaries. Each `include` entry contains workspace-root-relative glob patterns, and each entry must provide a non-empty `reason`.

An exclude pattern may match only a recognized root:

- an activated workspace package root;
- an extended nested package-scope root;
- a nested package-scope boundary root that was not extended; or
- a nested workspace root.

It cannot point at an arbitrary ordinary directory. Each exclude entry must match at least one recognized root; a pattern that matches no recognized root is a configuration error. If more than one entry matches the same root, the first matching entry supplies its reason.

If the workspace root itself is an activated package, use `.` or a pattern matching its root `package.json` to select it. Excluding that root package does not exclude the other activated workspace packages.

Excluding a governed unit removes that root and its descendants from the current run. Package ownership, dependency authority, checker discovery, and source analysis do not continue inside it. Excluding an already-stopped package or workspace boundary records why that boundary is intentional; it does not make the boundary governable.

A nested `pnpm-workspace.yaml` remains a hard boundary in every case. `exclude` cannot merge its workspace into the current region.

Imports from governed source into an excluded or otherwise stopped region are treated as cross-boundary access. Diagnostics identify the boundary root and include the configured reason when one is available. If the intent is only to omit selected files while keeping the containing package governed, use a file-level source or checker exclusion instead.
