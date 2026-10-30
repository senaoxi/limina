# Troubleshooting

When something fails, start with the task name, issue code, file path, and config path. This page begins with general troubleshooting, then covers common issues such as JSON imports and region exclusions.

## Identify the Failing Task

The current terminal output is the first clue. To revisit saved issues, use:

```sh
pnpm exec limina check --issues
pnpm exec limina check --issues --task source:check
```

`--issues` does not rerun checks. It reads saved records from the selected governance root. If the latest registered attempt is incomplete, interrupted, or corrupt, it does not return older issues. Errors before attempt registration, such as config-loading failures, can leave the previous completed record available, so compare its timestamp with the current terminal error. See [issue queries](./cli.md#limina-check-pipeline) for scope and options.

A successful query can still show issues from a failed check, and a query reporting no snapshot can also exit successfully. For a CI check, use `limina check` and inspect its task statuses.

| Failing task                      | Inspect first                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `workspace:validate`              | Governance root, package regions, duplicate package identities, and unsafe output directories                              |
| `graph:check`                     | Declaration providers, resolution of consumed entries, package dependency declarations, and graph rules                    |
| `source:check`                    | Source owner, cross-package relative imports, `#imports`, and bare-import authorization; usage findings if Knip is enabled |
| `proof:check`                     | Coverage of expected source, duplicate ownership, and agreement between source and checker configs                         |
| `checker:build`                   | Responsible build checker, config path, exit code, and raw logs                                                            |
| `checker:typecheck`               | Astro or Svelte checker dependencies, generated framework types, and source diagnostics                                    |
| `package:check` / `release:check` | Configured output directories, packed files, analyzers, and release dependencies                                           |

Fix structural problems before addressing checker errors that depend on them. This is troubleshooting guidance, not a strict task execution order. `disabled`, `blocked`, and `skipped` mean no applicable work, a failed prerequisite, or work not run. None means the corresponding check passed.

When changing source scope or rules, edit the config you maintain and rerun the relevant command. Do not patch generated configs under `.limina/` by hand.

## Common issues

### A new file reports `LIMINA_PROOF_UNCOVERED_SOURCE_FILE`

The file is in the source scope expected to be checked but does not have the required coverage. Run `pnpm exec limina check --issues --task proof:check --verbose` to see the file and candidate configs, then decide based on its purpose:

- If an existing config should check it, inspect that `tsconfig`'s `files`, `include`, and `exclude` and add the file to an appropriate source config.
- If it needs a separate type environment, create a source config and let a selected `tsconfig.json` entry reach it through an aggregator reference.
- If it should not be governed in this run, adjust [`scope.source`](./config/source-boundary.md) and check whether a checker still includes it.
- If it remains in scope but is intentionally not covered, use a reasoned [allowlist](./config/proof-allowlist.md) entry for that specific file.

For example, `limina.config.mts` itself matches the default TypeScript source scope. If the project's `tsconfig` only includes `src`, the config may be uncovered. [Getting Started](./getting-started.md#see-how-a-check-finds-an-omission) has a complete example.

### A relative import crosses a package boundary

`LIMINA_SOURCE_RELATIVE_IMPORT_ESCAPES_SCOPE` means a relative source import crosses the nearest `package.json` package boundary. Inspect the importing file, target, and both manifests in the report. If the code uses another package, expose a public entry in the provider, declare the dependency in the consumer's `package.json`, and import by package name. See [Source Checks](./built-in-tasks.md#relative-imports-must-not-cross-package-boundaries) for details.

### A package import is not authorized

`LIMINA_SOURCE_PACKAGE_IMPORT_UNAUTHORIZED` means the import cannot be explained by the owning package's dependency declarations or an applicable grant. Inspect the package name and manifest path, and prefer declaring the dependency in the package that uses it. If you intentionally share a root dependency, see [import authorization](./config/source-checks.md#importauthority) and configure a limited grant as needed.

### A framework checker is missing dependencies or source coverage

Use the error to check whether the Vue, Astro, or Svelte checker and its dependencies are available in the corresponding execution scope. Astro also needs framework types generated ahead of time.

Automatic checker discovery does not add `.vue`, `.astro`, or `.svelte` to Limina's default source scope. For example, if a `tsconfig` includes Vue components but `scope.source` does not, `proof:check` may report `LIMINA_PROOF_SOURCE_BOUNDARY_MISMATCH`. Adjust the source scope and framework `tsconfig` to match your project. See [Getting Started](./getting-started.md#using-vue-astro-or-svelte) and [Framework Prerequisites](./config/checkers.md#framework-prerequisites) for examples and dependencies.

### A checker build fails without source diagnostics {#checker-build-diagnostics}

The `limina check` summary or saved issue may identify a failed checker and exit code without showing the compiler's diagnostic. To run the applicable internal declaration builds again and inspect their output, use:

```sh
pnpm exec limina checker build
```

This command reruns the build checkers and may update generated files and caches under `.limina/`. It does not build production artifacts. If workspace or graph preparation fails first, resolve that error before investigating checker output.

### pnpm rejects installation at the workspace root

If installing the local build at a pnpm workspace root reports `ERR_PNPM_ADDING_TO_ROOT`, and the dependency should be installed at the root, add `-w`. For example, when the source directory is a sibling of the workspace, use `pnpm add -D -w file:../limina/packages/limina/dist`. To install in a child package instead, run the command there or use the package manager's filter to select it.

## JSON imports report `TS6307` after adopting Limina

If the TypeScript output from `checker:build` reports that an imported JSON file is not listed in the project, first inspect the `tsconfig` responsible for the importing source.

For example, a single-package ESM project has these files:

`src/index.ts`:

```ts
import settings from './settings.json' with { type: 'json' };

export const name = settings.name;
```

`src/settings.json`:

```json
{ "name": "demo" }
```

`tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "types": [],
    "resolveJsonModule": true,
  },
  "include": ["src/**/*.ts"],
}
```

Here `resolveJsonModule` allows TypeScript to resolve the import, but `include` selects only `.ts` files. Ordinary `tsc -p` may pass. Limina's generated declaration-build config enables `composite` and uses an explicit file list, so this layout may report `TS6307` for the JSON file. The result also depends on file location, output paths, and the TypeScript version; not every JSON import triggers this error.

For this example, add the JSON to the source `tsconfig`'s `include`, retaining the other compiler options:

`tsconfig.json`:

```jsonc
{
  "include": ["src/**/*.ts", "src/settings.json"],
}
```

The default `scope.source` does not include JSON. If `proof:check` reports `LIMINA_PROOF_SOURCE_BOUNDARY_MISMATCH` after the file is added to `tsconfig`, include it in Limina's source scope too. Add this to the Limina config at the project root:

`limina.config.mjs`:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  scope: {
    source: {
      include: ['...', 'src/settings.json'],
    },
  },
});
```

Merge this field into an existing Limina config. `...` retains the default TypeScript source patterns; the JSON path is relative to the project root determined by the Limina config. Run `pnpm exec limina check` again. If there are multiple JSON files, add paths or patterns that fit the project.

## Region exclusions

### `scope.regions.exclude[...].kind is required`

Every exclusion must declare one kind: `workspace-package`, `package-scope`, or `tsconfig`. Limina does not infer the kind from the path. The first two select candidate root directories; `tsconfig` selects exact config-root-relative `tsconfig.json` or `tsconfig.*.json` paths, without globs, and keeps the package activated.

### `scope.regions.exclude[...] does not match an exact governance candidate.` {#regions-exclude-rule-does-not-match-a-recognized-governance-root}

The diagnostic is `scope.regions.exclude[index] does not match an exact governance candidate.`, where `index` identifies the unmatched rule. Check:

1. `kind` matches the candidate type.
2. For `workspace-package` or `package-scope`, `include` selects the candidate root directory relative to `config.rootDir`, including `../` when needed, not its package name or config path.
3. The directory is not a fixed discovery ignore such as `node_modules`, `.git`, `.limina`, or a configured output directory.

For example, select an activated package rooted at `packages/legacy-app` with `kind: 'workspace-package'` and `include: ['packages/legacy-app']`.

### `Multiple scope.regions.exclude rules match` {#multiple-regions-exclude-rules-match-the-same-governance-root}

The diagnostic lists the candidate kind and path after `Multiple scope.regions.exclude rules match`. Make the patterns for that `kind` non-overlapping. Rule order does not choose a winning reason.

Nested workspace roots do not need exclusion rules. They automatically stop the current package's traversal, and activated packages below them start independent governance tasks.
