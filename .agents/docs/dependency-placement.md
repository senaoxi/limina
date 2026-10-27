# Dependency placement and bundling

[English](./dependency-placement.md) | [简体中文](./zh/dependency-placement.md)

Follow [dependency admission](./dependency-admission.md) first. This page owns dependency fields and delivery boundaries; it does not relax admission gates or authorize unrelated dependency migrations. [Repository architecture](./architecture.md#limina-boundary) owns the package distribution structure.

For published Limina tools, prefer bundling dependencies that are private implementation details and can safely enter the delivered artifacts. Put these build inputs in `devDependencies`, even when their bundled code executes at runtime. Externalize dependencies whose installation, host compatibility, module identity, resources or public types must remain a consumer-visible contract. Neither package size nor a source import decides the field by itself.

## Read by change

Read the sections for each affected boundary; the introduction and acceptance section applies whenever a declaration or delivery contract changes.

| Change                                                             | Required context                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------- |
| Choose or change a manifest field                                  | [Field selection](#choose-the-field-from-the-delivery-contract) |
| Change bundling, package generation or an executable entry         | [Build and runtime boundaries](#build-and-runtime-boundaries)   |
| Retain or change third-party references in published `.d.ts` files | [Public declarations](#public-declarations)                     |
| Place a compiler, framework or other host dependency               | [Host ownership](#host-ownership)                               |
| Make an integration or installation optional                       | [Optional loading](#optional-loading)                           |
| Introduce or reclassify a dependency                               | [Introduction and acceptance](#introduction-and-acceptance)     |

## Choose the field from the delivery contract

| Dependency role                                                          | Declaration                                                         | Delivery requirement                                                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build, test, lint, documentation or other development-only tooling       | `devDependencies`                                                   | Consumers must not need the package to execute published entry points or resolve their declarations.                                                        |
| Safely bundled internal implementation                                   | `devDependencies`                                                   | Ship the needed code and assets; account for remaining external imports and public type references. Verify the production build actually includes them.     |
| Required external runtime implementation or declaration dependency       | `dependencies`                                                      | Installation must provide it; preserve its external references. Native binaries, package-relative assets or non-bundleable loading can justify this choice. |
| Required compatibility with a consumer-owned host, compiler or framework | `peerDependencies`                                                  | Declare the supported range, externalize it, and verify the intended host-resolution and instance contract.                                                 |
| User-selected optional host integration                                  | `peerDependencies` plus `peerDependenciesMeta[name].optional: true` | Keep unrelated capabilities usable without it; load and validate the integration only when needed.                                                          |
| Automatically provisioned but dispensable enhancement                    | `optionalDependencies`                                              | Define and validate behavior when installation is skipped or fails: a valid fallback or a clearly unavailable optional capability.                          |

A peer may also appear in `devDependencies` for repository development and tests; this does not remove the published peer contract or permit bundling a private replacement. Do not assume peers always require manual installation or that a peer declaration alone guarantees a singleton.

`bundleDependencies` / `bundledDependencies` packages dependencies into a publication tarball; it is not JavaScript module bundling. Introduce it only for an explicit distribution requirement, not as a substitute for this policy.

## Build and runtime boundaries

- **Inspect the actual build.** Read the affected package's manifest, JS and declaration bundler configuration, package-generation hooks and packed manifest. In the [core build](../../packages/limina/rolldown.config.ts), `dependencies`, `peerDependencies` and `optionalDependencies`, including their subpaths, feed both external rules. Inspect other packages independently, including the [migration build](../../packages/migrate/rolldown.config.ts). Field changes can change runtime and declaration output; they are not bookkeeping-only edits.
- **Bundle only when behavior survives.** Check dynamic imports, `require`, resolution relative to the original package, workers/subprocesses, native modules, WASM and data files. A successful bundler run does not establish that these paths work.
- **Account for what remains external.** Every remaining third-party import, including imports from bundled transitive code, needs an explicit delivery contract. Preserve license notices and the [bundled-code license gate](./license-policy.md).
- **Respect non-bundled entry points.** Classify private packages, repository scripts and `tsc`-only outputs according to who executes them. Repository-only tooling may use `devDependencies`; published entries that retain runtime imports need an external delivery contract unless a verified later build bundles them.

## Public declarations

Audit published `.d.ts` files separately from JS output. If they retain third-party type references, provide a suitable installed dependency/peer contract or safely inline the necessary declarations. `import type` and bundling JS do not remove a declaration dependency. Classify `@types/*` by actual consumer need, not by name.

Verify unaffected consumers can type-check when optional integrations are absent. `skipLibCheck` is not a missing-dependency fix. Use the existing [declaration output and consumer checks](./technology-stack.md) for their respective boundaries.

## Host ownership

Decide compiler/framework placement from Limina's existing [provider and resolution contracts](./semantics.md), not a rule that every compiler must be bundled or external. Preserve the consumer's selected version, instance identity and compatibility ranges; do not substitute a privately bundled compiler to simplify packaging.

## Optional loading

The package manager does not implement a fallback. Load optional integrations only when needed so unrelated entry points can start without them. Handle expected absence or explicitly supported load failures without masking arbitrary initialization errors, missing transitive dependencies or defects. When a requested check needs a missing tool, report the unavailable capability or failure; never turn a skipped required check into success.

Distinguish platform selection from dispensability. Upstream optional entries may distribute platform variants while still requiring one working backend on the selected platform. Inspect the loader before inferring a pure-JS fallback or reclassifying Limina's required dependency as optional.

## Introduction and acceptance

Declare each dependency in the workspace package that actually uses it. Follow the [workspace catalogs](../../pnpm-workspace.yaml) and [lockfile workflow](./development-workflow.md#editing-boundaries); catalog names do not determine manifest-field semantics. Do not rely on root hoisting, undeclared transitive dependencies or tools that happen to exist in a consumer workspace.

Before changing a declaration or delivery contract, record the owning package and use case, selected field, bundled/external treatment, public type exposure, host/version requirements and behavior when absent. Include material platform, installation, size and license costs in the existing [admission review](./dependency-admission.md#introduction-validation-and-decision-record) rather than creating a second process.

Within the authorized task scope, reuse existing build, declaration, package and packed-consumer checks. Validate affected JS/CLI entries, declaration resolution without the producer's development environment, external dependency completeness and applicable optional-dependency present/absent paths. Verify native/resource behavior on relevant supported environments. Update necessary manifests, catalogs, generated lockfiles, configuration and regression coverage together.

Report unexecuted checks and evidence gaps explicitly. This policy does not authorize dependency installation, reclassification of existing dependencies or expansion of an analysis-only task just to satisfy its acceptance steps.
