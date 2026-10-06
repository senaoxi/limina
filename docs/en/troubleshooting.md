# Troubleshooting

Identify the failing task first, then follow its issue codes, source paths, and config paths. Start with the general guidance below; later sections address specific JSON root-file and governance-region problems.

## Identify the Failing Task

The current terminal output is the first clue. To revisit saved issues, use:

```sh
pnpm exec limina check --issues
pnpm exec limina check --issues --task source:check
```

`--issues` does not rerun checks. It reads persisted state from the selected governance root. If the latest registered attempt is incomplete, interrupted, or corrupt, it does not return older issues. Errors before attempt registration, such as config-loading failures, can leave the previous completed record available, so compare its timestamp with the current terminal error. See [issue queries](./cli.md#limina-check-pipeline) for scope and options.

| Failing task                      | Inspect first                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `workspace:validate`              | Governance root, package regions, duplicate package identities, and unsafe output directories                              |
| `graph:check`                     | Declaration providers, resolution of consumed entries, package dependency declarations, and graph rules                    |
| `source:check`                    | Source owner, cross-package relative imports, `#imports`, and bare-import authorization; usage findings if Knip is enabled |
| `proof:check`                     | Coverage of expected source, duplicate ownership, and agreement between source and checker configs                         |
| `checker:build`                   | Responsible build checker, config path, exit code, and raw logs                                                            |
| `checker:typecheck`               | Astro or Svelte checker dependencies, generated framework types, and source diagnostics                                    |
| `package:check` / `release:check` | Configured output directories, packed files, analyzers, and release dependencies                                           |

Fix structural issues before addressing checker errors that depend on them. This is troubleshooting guidance, not a strict task execution order. `disabled`, `blocked`, and `skipped` mean no applicable work, a failed prerequisite, or work not run; none means the corresponding check passed.

When changing source scope or rules, edit the user-maintained config and rerun the relevant command. Do not patch generated configs under `.limina/` by hand.

## JSON imports report `TS6307` after adopting Limina

A non-composite project using `tsc -p` may accept JSON imported through `resolveJsonModule` even when the JSON is not selected by source `files` or `include`. Composite projects can already enforce the root-file list when run directly. For example:

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

With `composite: false`, this configuration may pass `tsc -p`. The import adds JSON to the program, but the source `tsconfig` does not select it as a root file. Limina enables `composite` in the generated declaration config, which requires that root membership.

Limina generates declaration build configurations from the source `tsconfig` root file set and writes that set as explicit `files`. If the source `tsconfig` does not include the imported JSON, the generated configuration does not include it either. Running `checker:build` then reports `TS6307`:

```text
packages/example/src/cli.ts:4:17 - error TS6307: File '<workspace>/packages/example/package.json' is not listed within the file list of project '<workspace>/.limina/tsconfig/checkers/tsc/projects/packages/example/tsconfig.dts.json'. Projects must list all files or use an 'include' pattern.

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

`resolveJsonModule` enables TypeScript to resolve JSON modules. It does not make `include: ["src"]` match `.json` files. Include the imported JSON in the source `tsconfig` root file set so it appears in the generated declaration config's `files`.

## Region exclusions

### `regions.exclude[...].kind is required`

Every exclusion must declare one kind: `workspace-package`, `package-scope`, or `tsconfig`. Limina does not infer the kind from the path. The first two select candidate root directories; `tsconfig` selects exact config-root-relative `tsconfig.json` or `tsconfig.*.json` file paths, without globs, and keeps the package activated.

### `regions.exclude[...] does not match an exact governance candidate.` {#regions-exclude-rule-does-not-match-a-recognized-governance-root}

The diagnostic is `regions.exclude[index] does not match an exact governance candidate.`, where `index` identifies the unmatched rule. Check all three facts:

1. `kind` matches the candidate type.
2. For `workspace-package` or `package-scope`, `include` selects the candidate's config-root-relative lexical directory, including `../` when needed, not its package name or descriptor path.
3. The directory is not a fixed discovery ignore such as `node_modules`, `.git`, `.limina`, or a configured output directory.

For example, select an activated package rooted at `packages/legacy-app` with `kind: 'workspace-package'` and `include: ['packages/legacy-app']`.

### `Multiple regions.exclude rules match` {#multiple-regions-exclude-rules-match-the-same-governance-root}

The diagnostic lists the candidate kind and path after `Multiple regions.exclude rules match`. Make the patterns for that `kind` non-overlapping. Rule order does not choose a winning reason.

Nested workspace roots do not need exclusion rules. They automatically stop the current owner's traversal, and activated packages below them start independent package-island jobs.
