# Troubleshooting

## Region exclusions

### `regions.exclude[...].kind is required`

Every exclusion must declare exactly one candidate kind: `workspace-package` or `package-scope`. Limina does not infer a kind from the path.

### `regions.exclude rule does not match a recognized governance root`

Check all three facts in the diagnostic:

1. `kind` matches the candidate type.
2. `include` selects the candidate's config-root-relative lexical directory, including `../` when needed, not its package name or descriptor path.
3. The directory is not a fixed discovery ignore such as `node_modules`, `.git`, `.limina`, or a configured output directory.

For example, select an activated package rooted at `packages/legacy-app` with `kind: 'workspace-package'` and `include: ['packages/legacy-app']`.

### `Multiple regions.exclude rules match the same governance root`

Make the patterns for that `kind` non-overlapping. Rule order does not choose a winning reason.

Nested `pnpm-workspace.yaml` files do not need exclusion rules. They automatically stop the current owner's traversal, and activated packages below them start independent package-island jobs.
