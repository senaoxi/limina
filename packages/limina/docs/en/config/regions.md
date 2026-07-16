# Regions

`regions` defines which package scopes belong to the current Limina run. It is a structural boundary: it decides where package ownership, checker discovery, source analysis, generated graphs, and dependency authority apply.

::: warning
`regions.exclude` does not replace `config.source.exclude`. Checker-level `exclude` is still required for individual checker entries inside an activated region. Paths belonging to an excluded or inaccessible region are outside checker `include` discovery by construction, so do not duplicate those paths in checker `exclude`. Use `regions` when an entire activated package or recognized package scope must stay outside the current run.
:::

```ts
interface RegionsConfig {
  extendNestedPackageScopes?: boolean;
  exclude?: RegionExcludeConfig[];
}

interface RegionExcludeConfig {
  kind: 'workspace-package' | 'package-scope';
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
        kind: 'workspace-package',
        include: ['packages/legacy-app'],
        reason: 'This package is governed by a separate Limina run.',
      },
    ],
  },
});
```

## Default Governed Region

Limina starts from the raw package membership declared by the nearest `pnpm-workspace.yaml`. It validates `workspace-package` exclusion rules against that complete raw set and applies them before constructing the activated package index. Each remaining package is a separate package island, and its root `package.json` is the owner manifest for source ownership and dependency authorization. An activated package may be outside `config.rootDir`; reports keep its lexical display path, such as `../shared`, while ownership and collision checks use its canonical physical directory.

Inside each base unit, boundaries work as follows:

- A nested `package.json` stops governance at that directory by default.
- A nested `pnpm-workspace.yaml` always stops traversal for the current package island.
- An activated child package is not traversed by its activated parent. Limina starts a separate discovery job from the child root instead.
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

An ancestor boundary never prevents an activated descendant package from starting its own island. Visibility is therefore owner-local: a parent cannot read descriptors behind its nested workspace or activated-child boundary, while a separately activated descendant can still govern its own files. Default source and automatic checker discovery run once per package island, including external activated packages.

Before any source, proof, graph, checker, migration, package, release, or artifact-producing work starts, `workspace:validate` builds this activated package index. It rejects structural ambiguity before owner lookup is constructed:

- a non-root package that remains activated after `workspace-package` exclusions and also contains its own `pnpm-workspace.yaml` reports `LIMINA_WORKSPACE_REGION_OVERLAP`;
- two lexical package roots that resolve to the same physical directory report `LIMINA_WORKSPACE_PACKAGE_IDENTITY_CONFLICT`;
- unsafe output ownership and non-stable output visibility report `LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID` or `LIMINA_WORKSPACE_OUTPUT_CYCLE`.

These are workspace validation errors. Invalid package regions do not participate in ownership, source discovery, generated graphs, migration, package selection, release selection, or artifact generation.

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

`include` patterns match only config-root-relative lexical candidate root directories. They may use `../` for activated packages outside `config.rootDir`. They do not match package names, `package.json` paths, `pnpm-workspace.yaml` paths, canonical filesystem paths, or arbitrary files. For a package or package-scope root at `packages/app/fixtures/local`, select the root with `packages/app/fixtures/local` or a root glob such as `packages/**/fixtures/**`; `**/package.json` does not select it.

Each of the two kinds has one candidate set:

- `workspace-package` selects exact package-root candidates from the complete raw membership activated by the root `pnpm-workspace.yaml`. Limina validates these rules before overlap checks, then removes each matched package from ownership, dependency authority, source and checker discovery, and generated graphs. A matched parent does not cascade to unmatched activated descendants; match every descendant explicitly when that is intended. Use `include: ['.']` to exclude only the root package when it is activated; this does not exclude the workspace or other activated packages. Explicit `package.entries` remain independent artifact entries and are not deleted by this rule.
- `package-scope` selects nested `package.json` roots. It covers both eligible extended scopes and scopes where governance already stops. An excluded scope and all descendants stay outside the current run.

A rule is matched only against candidates of the same kind. A directory that is both an activated package and a nested package scope therefore keeps those identities separate.

Every rule must match at least one candidate of its declared kind. `workspace-package` rules are validated against the complete raw package candidate set before activation and overlap validation. `package-scope` rules are validated after nested descriptor and output visibility stabilizes. Descriptor paths, fixed discovery ignores such as `node_modules`, `.git`, `.limina`, and configured output directories, and paths belonging only to another kind cannot satisfy a rule. Multiple rules may not match the same candidate; make their patterns non-overlapping instead of relying on array order.

## Path Coordinates and Output Safety

Public paths use one coordinate system per field:

- source selectors and all `regions` selectors are relative to `config.rootDir` and may contain `../`;
- `package.entries[].outDir` is relative to `config.rootDir` and may point into an external activated package;
- `liminaOptions.outputs.outDir` is relative to the source `tsconfig` that declares it;
- issue paths are relative to `config.rootDir`, including `../` when needed;
- Limina-generated persistent artifacts stay inside the trusted `.limina` namespace. External package artifacts use an internal `external/<stable-id>/...` segment instead of copying `../` into a generated path.

Package-entry outputs are unconditional output roots. A `tsconfig` output participates only while that `tsconfig` remains structurally visible in its package island and outside unconditional outputs. Limina iterates descriptor visibility and output roots until they stabilize; self-output and mutually hiding output cycles are configuration errors.

Every declared output must be a dedicated directory. It may be a strict descendant such as `packages/app/dist`, `packages/app/generated`, or `../shared/dist`, but it cannot equal or contain `config.rootDir` or an activated package root, and it cannot overlap `.limina` in either direction. Here, activated package roots are the effective set after `workspace-package` exclusions: an excluded raw package root alone does not reserve an output path, while any unmatched activated descendant still protects its own root. Limina validates both lexical and canonical identities before the output can remove any descriptor from discovery.

Nested `pnpm-workspace.yaml` files are automatic owner-local boundaries, not public exclusion candidates. The parent island records the boundary but does not read or validate the nested workspace context. If packages below that boundary are activated by the raw workspace membership, each starts its own package-island job independently.

Imports from governed source into an excluded or otherwise stopped region are treated as cross-boundary access. Checker entry `references` follow the same structural boundary: checker `exclude` does not make a cross-region reference valid and does not hide an existing ordinary source config reached from an effective entry. Diagnostics identify the boundary root and include the configured reason when one is available; when no registered boundary owns the path, the diagnostic states that no current-run activated workspace package owns it. If the intent is only to omit selected files while keeping the containing package governed, use a file-level source exclusion or checker entry exclusion instead.
