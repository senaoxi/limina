# Troubleshooting

## Region exclusions

### `regions.exclude[...].kind is required`

Every exclusion must declare exactly one candidate kind: `workspace-package`, `package-scope`, or `pnpm-workspace`. Limina does not infer a kind from the path.

### `regions.exclude rule does not match a recognized governance root`

Check all three facts in the diagnostic:

1. `kind` matches the candidate type.
2. `include` selects the candidate's workspace-root-relative directory, not its package name or descriptor path.
3. The directory is not a fixed discovery ignore such as `node_modules`, `.git`, `.limina`, or a configured output directory.

For example, select a nested workspace at `packages/app/fixture/pnpm-workspace.yaml` with `kind: 'pnpm-workspace'` and `include: ['packages/app/fixture']`.

### `Multiple regions.exclude rules match the same governance root`

Make the patterns for that `kind` non-overlapping. Rule order does not choose a winning reason.

### `regions.exclude cannot exclude the root pnpm workspace`

The root `pnpm-workspace.yaml` defines the current governance origin. Run Limina from a different workspace root if that workspace should not be governed. To exclude only an activated root package, use `kind: 'workspace-package'` with `include: ['.']`.

### `Failed to inspect nested pnpm workspace region`

Use the reported `phase` to locate the failure:

- `manifest-validation`: repair YAML, pnpm workspace schema, or catalog configuration.
- `package-discovery`: repair package manifests, workspace discovery, or package identity.

If the nested workspace is intentionally invalid fixture data, exclude its root explicitly with `kind: 'pnpm-workspace'`. Limina applies that rule before reading the nested manifest and keeps the directory as a hard boundary.
