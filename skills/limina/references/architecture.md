# Architecture and ownership

Read this when a fix depends on project references, dependency meaning, or which
checker owns a file. Start with the target's source and config, not a guessed
repository layout.

## Governance roots and regions

Config discovery walks ancestors independently of workspace classification. The
nearest manifest above the selected config establishes its root. A
`pnpm-workspace.yaml` or supported `package.json#workspaces` declaration makes it
a workspace; otherwise it is a single-package root. Package manager metadata and
same-root lockfiles resolve workspace capabilities. npm, Yarn, Bun, and pnpm
support does not imply that every manager-specific capability is interchangeable.

Nested manifests and nested workspace declarations affect owner boundaries.
`scope.regions` controls explicit exclusions and nested package-scope extension.
Neither checker selectors nor `../` paths grant authority over unactivated owners.
Inspect the region and resolved target when diagnosing a boundary failure.

## Source entries, leaves, and generated files

| Surface                              | Role                                                   | What to edit                                                |
| ------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------- |
| Default `tsconfig.json` entry        | Selected by auto discovery or a named checker scope    | Include/files, supported solution membership, source policy |
| Referenced terminal `tsconfig*.json` | Owns source compiler semantics                         | Source options and justified `liminaOptions`                |
| Default solution `tsconfig.json`     | Organizes reachable configs                            | Ordinary solution `references`                              |
| `.limina` checker/build files        | Derived graph, declarations, caches, and evidence      | Regenerate with Limina; do not patch                        |
| Source `package.json`                | Package identity, import authorization, source exports | Actual source dependency contract                           |
| Built `package.json`                 | Consumer entry points and publish dependencies         | Build generator/template, then rebuild                      |

Only default configs can be direct checker entries. A named terminal config can
be a solution member, but a named config is not a supported intermediate solution.
Do not add ordinary source-to-source `references` indiscriminately: source edges
are inferred; solution membership and extra implicit relations have distinct roles.

`liminaOptions.graphRules` activates labels from `graph.rules`.
`liminaOptions.implicitRefs` adds relations that static evidence cannot establish,
using `{ path, reason }` relative to the declaring config. Do not duplicate an
already inferred edge. `liminaOptions.outputs` declares managed artifact options
(`rootDir`, `outDir`, `target`, `declarationMap`) on source configs; it is separate
from `package.entries[].outDir`, which locates a built package. Internal markers
such as `generated`, `checker`, and `sourceConfig` are not source-authoring knobs.

## Authorization is separate from resolution

First inspect the importing package's manifest authorization. Then inspect the
checker-supported resolution result and ownership of the target. A local protocol
such as `workspace:`, `link:`, or `file:` does not by itself make an import a source
edge. Source manifests may legitimately use these protocols; publish-ready output
manifests must resolve them to supported publish dependencies.

A governed source target can require a generated declaration reference. A target
consumed as declarations or built artifacts does not become a source reference
just because the package is local. Managed-output attribution and checker evidence
also matter: the suffix `.d.ts` alone is not enough to classify every edge.
Inspect `graph export --view all` and the reported evidence before changing refs.

Keep source exports when the project intentionally consumes source, and output
exports when it intentionally consumes built artifacts. Do not rewrite manifests
to a universal layout. A custom export condition such as `source` only participates
when the effective resolver conditions select it.

The semantic provider interprets dependencies; the final checker owner executes
the target. These can differ. A TypeScript leaf built by `vue-tsc` can retain
TypeScript dependency semantics. Framework parser/toolchain failures are not
permission to substitute a generic import regex or silently skip the file.

## Source map

These are paths relative to a **matching Limina source checkout**, not paths
relative to the installed skill. Use the accompanying checkout or retrieve the
corresponding revision from [senaoxi/limina](https://github.com/senaoxi/limina).
Do not assume the latest branch describes an older installed package.

| Question                                       | Source owner                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Version, Node and peer support, public exports | `packages/limina/package.json`, `packages/limina/src/index.ts`                                                                        |
| Commands and flags                             | `packages/limina/src/cli/factory.ts`, `packages/limina/src/cli/register/`                                                             |
| Config loading and public schema               | `packages/limina/src/config/loader.ts`, `loader-paths.ts`, `root-types.ts`, `schema/` in that directory                               |
| Root selection and workspace classification    | `packages/limina/src/utils/governance-manifest.ts`, `workspace-root.ts` in that directory                                             |
| Checker names, toolchain, and ownership        | `packages/limina/src/config/pipeline-checker-types.ts`, `packages/limina/src/checker/`, `packages/limina/src/core/build-graph/`       |
| Source dependency evidence                     | `packages/limina/src/core/import-graph/`, `packages/limina/src/core/import-analysis/`, `packages/limina/src/core/framework-semantic/` |
| Source tsconfig declarations                   | `packages/limina/schemas/tsconfig-schema.json` and its runtime consumers                                                              |
| Pipeline parsing and ordering                  | `packages/limina/src/pipeline/steps.ts`, `plan.ts`, `command-runner.ts` in that directory                                             |
| Package selection and checks                   | `packages/limina/src/package-check/entry/`, `packages/limina/src/package-check/release/`                                              |
| Issue query freshness                          | `packages/limina/src/cli/issue-query.ts`, `packages/limina/src/source-check/snapshot/check-attempt-query.ts`                          |
| Init and optional skill installation           | `packages/limina/src/commands/init/`                                                                                                  |
| Migration transaction and verification         | `packages/migrate/src/`                                                                                                               |

Use the source repository's `.agents/docs/README.md` for its maintenance context
when available. Source/tests establish behavior; records and this skill help find
it. Do not make installed-skill operation depend on those repository files being
present, and do not treat internal source routes as consumer imports.
