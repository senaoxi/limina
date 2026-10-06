# Regions

`regions` determines which packages and nested package scopes belong to the current run. Establish package scope here first, then use `config.source` to select files within it and `config.checkers` to select checker entries.

::: warning
`regions.exclude` does not replace `config.source.exclude`. Package kinds remove package authority; checker `exclude` only changes entry selection. Use the exact `tsconfig` kind to isolate a config before output declarations are read, while leaving its package activated. It does not hide source files or make incoming references valid; migration must also prune those relations.
:::

```ts
interface RegionsConfig {
  extendNestedPackageScopes?: boolean;
  exclude?: RegionExcludeConfig[];
}

interface RegionExcludeConfig {
  kind: 'workspace-package' | 'package-scope' | 'tsconfig';
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

The selected config's nearest `package.json` fixes the governance root. At that root, a workspace declaration supplies raw membership through its manager adapter; without one, the raw set is `[rootPackage]`. See [Config Discovery and Governance Root](./config-file.md#governance-root). It validates `workspace-package` exclusion rules against that complete raw set and applies them before constructing the activated package index. Each remaining package is a separate package island, and its root `package.json` is the owner manifest for source ownership and dependency authorization. An activated package may be outside `config.rootDir`; reports keep its lexical display path, such as `../shared`, while ownership and collision checks use its canonical physical directory.

Workspace package discovery follows the selected manager's policy. Its traversal always excludes the following directory names:

| Manager | Hard ignores                         |
| ------- | ------------------------------------ |
| pnpm    | `node_modules`, `bower_components`   |
| npm     | `node_modules`                       |
| Yarn    | `node_modules`, `.git`, `.yarn`      |
| Bun     | `node_modules`, `.git`, `CMakeFiles` |

`test` and `tests` are ordinary candidate directories when matched. Glob selection is manager-specific: for example, later positive patterns can re-include packages in npm and Bun, while pnpm and Yarn retain exclusions. An exact exclusion of a package need not exclude its descendants; declare subtree exclusions when that is intended. Root manifests are included independently of the globs, and names are optional.

Limina uses `packageManager` to identify the package manager and applies the selection policy above. The version suffix does not select historical discovery behavior, including behavior later corrected upstream. Projects requiring exact workspace-membership parity with a historical release need to check the resulting raw package set; Limina does not guarantee that parity.

These supported discovery rules do not certify the manager's full configuration. Limina keeps the hard ignores above even where a manager version accepts an explicit metadata-directory shortcut.

Inside each base unit, boundaries work as follows:

- A nested `package.json` stops governance at that directory by default.
- A nested workspace root (`pnpm-workspace.yaml` or `package.json` with its own `workspaces`) always stops traversal for the current package island.
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

Before source, proof, graph, checker, package, release, or artifact-producing work starts, `workspace:validate` builds this activated package index. It rejects structural ambiguity before owner lookup is constructed:

- a non-root package that remains activated after `workspace-package` exclusions and also declares another workspace root reports `LIMINA_WORKSPACE_REGION_OVERLAP`;
- two lexical package roots that resolve to the same physical directory report `LIMINA_WORKSPACE_PACKAGE_IDENTITY_CONFLICT`;
- unsafe output ownership and non-stable output visibility report `LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID` or `LIMINA_WORKSPACE_OUTPUT_CYCLE`.

Migration uses the same package authority checks and inventories configs for normalization or isolation. Discovery recovery is limited to recoverable `outputs` input errors; it uses trusted initial candidates and rereads input topology before and after writing. These are workspace validation errors. Invalid package regions do not participate in ownership, source discovery, generated graphs, migration, package selection, release selection, or artifact generation.

## extendNestedPackageScopes

- **Type:** `boolean`
- **Default:** `false`

Set `regions.extendNestedPackageScopes` to `true` when a nested `package.json` is a package scope used for resolution, but its source should remain governed by the surrounding workspace package.

A nested `package.json` can be extended only when all of these conditions hold:

1. The current workspace declaration does not identify its directory as a workspace package.
2. The manifest does not have its own `name` field.
3. The directory is not inside a nested workspace boundary.

The `name` check is based on the presence of the field, not whether its value is useful. For example, `"name": ""` and `"name": null` still prevent extension.

Extension is local to the current region. Limina may continue through several consecutive eligible package scopes, but it stops at the first ineligible nested manifest or nested workspace boundary. It cannot use this option to absorb an unrelated directory outside the activated workspace packages.

An extended package scope does not become a new source owner. Its source continues to use the surrounding workspace package's owner manifest and dependency declarations. The nested manifest still remains the nearest package scope for relative-import boundaries and `package.json#imports` resolution.

## exclude

- **Type:** `RegionExcludeConfig[]`
- **Default:** `[]`

Every rule requires `kind`, a non-empty `include` array, and a non-empty `reason`. There is no kind inference or legacy kind-less form.

For `workspace-package` and `package-scope`, `include` patterns match only config-root-relative lexical candidate root directories. They may use `../` for activated packages outside `config.rootDir`. They do not match package names, `package.json` paths, `pnpm-workspace.yaml` paths, canonical filesystem paths, or arbitrary files. For a package or package-scope root at `packages/app/fixtures/local`, select the root with `packages/app/fixtures/local` or a root glob such as `packages/**/fixtures/**`; `**/package.json` does not select it.

Each package kind has one candidate set:

- `workspace-package` selects exact package-root candidates from the complete raw membership of the selected governance root, including a single-package root. Limina validates these rules before overlap checks, then removes each matched package from ownership, dependency authority, source and checker discovery, and generated graphs. A matched parent does not cascade to unmatched activated descendants; match every descendant explicitly when that is intended. Use `include: ['.']` to exclude only the root package when it is activated; this does not exclude the workspace or other activated packages. Explicit `package.entries` remain independent artifact entries and are not deleted by this rule.
- `package-scope` selects nested `package.json` roots. It covers both eligible extended scopes and scopes where governance already stops. After exclusion, governance by the current outer package stops at that root and discovers no files below it. An independently activated workspace package beneath the boundary still starts governance from its own root; use a separate `workspace-package` exclusion to remove it from the run.

A rule is matched only against candidates of the same kind. A directory that is both an activated package and a nested package scope therefore keeps those identities separate.

Every package-kind rule must match at least one candidate of its declared kind. `workspace-package` rules are validated against the complete raw package candidate set before activation and overlap validation. `package-scope` rules are validated after nested descriptor and output visibility stabilizes. Descriptor paths, fixed discovery ignores such as `node_modules`, `.git`, `.limina`, and configured output directories, and paths belonging only to another kind cannot satisfy a rule. Multiple rules may not match the same candidate; make their patterns non-overlapping instead of relying on array order.

### Exact tsconfig exclusion

`kind: 'tsconfig'` takes exact config-root-relative `tsconfig.json` or `tsconfig.*.json` file paths. It accepts `../` but not directory/glob selectors. Matching uses the projected canonical file identity, before output declarations and descriptor stability. It removes only matching config descriptors; package activation and source-file authority remain unchanged. Missing excluded files remain harmless, so deleting an isolated broken file does not invalidate its exclusion. Package-kind candidate-match and overlap rules do not apply to this kind.

```js
regions: {
  exclude: [{
    kind: 'tsconfig',
    include: ['packages/app/tools/tsconfig.json'],
    reason: 'This config cannot be parsed; its incoming memberships were pruned.',
  }],
}
```

The example does not exclude `packages/app`, sibling configs, or files under `tools`. A surviving solution reference to the excluded file is still an input problem. See [migration](../cli.md#limina-migration) for persistence and dynamic-config limitations.

## Path Coordinates and Output Safety

Public paths use one coordinate system per field:

- source selectors and all `regions` selectors are relative to `config.rootDir` and may contain `../`;
- `package.entries[].outDir` is relative to `config.rootDir` and may point into an external activated package;
- `liminaOptions.outputs.outDir` is relative to the source `tsconfig` that declares it;
- issue paths are relative to `config.rootDir`, including `../` when needed;
- Limina-generated persistent artifacts stay inside the trusted `.limina` namespace. External package artifacts use an internal `external/<stable-id>/...` segment instead of copying `../` into a generated path.

Package-entry outputs are unconditional output roots. A `tsconfig` output participates only while that `tsconfig` remains structurally visible in its package island and outside unconditional outputs. Limina iterates descriptor visibility and output roots until they stabilize; self-output and mutually hiding output cycles are configuration errors.

Every declared output must be a dedicated directory. It may be a strict descendant such as `packages/app/dist`, `packages/app/generated`, or `../shared/dist`, but it cannot equal or contain `config.rootDir` or an activated package root, and it cannot overlap `.limina` in either direction. Here, activated package roots are the effective set after `workspace-package` exclusions: an excluded raw package root alone does not reserve an output path, while any unmatched activated descendant still protects its own root. Limina validates both lexical and canonical identities before the output can remove any descriptor from discovery.

Nested workspace roots are automatic owner-local boundaries, not public exclusion candidates. The parent island records the boundary but does not read or validate the nested workspace context. If packages below that boundary are activated by the raw workspace membership, each starts its own package-island job independently.

Imports from governed source into an excluded or otherwise stopped region are treated as cross-boundary access. Checker entry `references` follow the same structural boundary: checker `exclude` does not make a cross-region reference valid and does not hide an existing ordinary source config reached from an effective entry. Diagnostics identify the boundary root and include the configured reason when one is available; when no registered boundary owns the path, the diagnostic states that no current-run activated workspace package owns it. Use `config.source.exclude` to filter expected source files while keeping their package governed. A checker entry exclusion changes direct entry discovery; it does not filter source files or cut an established membership closure.
