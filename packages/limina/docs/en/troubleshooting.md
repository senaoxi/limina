# Troubleshooting

## JSON imports report `TS6307` after adopting Limina

When a project only uses `tsc -p`, JSON files imported through `resolveJsonModule` do not need to appear explicitly in the source `tsconfig` `files` or `include` fields. For example:

```ts
import pkg from '../package.json' with { type: 'json' };
```

```jsonc
{
  "compilerOptions": {
    "resolveJsonModule": true,
  },
  "include": ["src"],
}
```

This configuration usually passes with `tsc -p`. The import adds the JSON file to the TypeScript program, but does not make it a root file selected by the source `tsconfig`.

Limina generates declaration build configurations from the source `tsconfig` root file set and writes that set as explicit `files`. If the source `tsconfig` does not include the imported JSON, the generated configuration does not include it either. Running `checker:build` then reports `TS6307`:

```text
packages/example/src/cli.ts:4:17 - error TS6307: File '<workspace>/packages/example/package.json' is not listed within the file list of project '<workspace>/.limina/tsconfig/checkers/typescript/projects/tsconfig.dts.json'. Projects must list all files or use an 'include' pattern.

4 import pkg from '../package.json' with { type: 'json' }
                  ~~~~~~~~~~~~~~~~~
```

Keep `resolveJsonModule: true` in the source `tsconfig` that owns the importing source file, and include the imported JSON explicitly:

```jsonc
{
  "compilerOptions": {
    "resolveJsonModule": true,
  },
  "include": ["src", "package.json"],
}
```

When the source scope imports several JSON files, a JSON glob can be used:

```jsonc
{
  "compilerOptions": {
    "resolveJsonModule": true,
  },
  "include": ["src", "**/*.json"],
  "exclude": ["dist", ".limina", "**/fixtures/**"],
}
```

`resolveJsonModule` enables TypeScript to resolve JSON modules. It does not make `include: ["src"]` match `.json` files. The imported JSON must also belong to the source `tsconfig` root file set so Limina can project it into the generated declaration configuration `files`.

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
