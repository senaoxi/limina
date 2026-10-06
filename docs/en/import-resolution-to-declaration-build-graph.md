# From Import Resolution to the Declaration Build Graph

Limina generates a declaration build graph from dependency facts under the current checker and tsconfig. An import can stop at an existing declaration boundary or form a candidate source relationship, becoming a project reference only after ownership, checker, and rule validation.

This page explains the decision process. If package dependencies, source imports, and `references` are still unfamiliar distinctions, start with [Why Imports Cannot Directly Become References](./why-import-is-not-references.md).

## How Limina Decides Whether an Import Needs a Project Reference

Consider an import in `app`:

```ts
import { createClient } from '@acme/core';
```

Limina first identifies the source leaf that owns this line, collects and resolves dependencies using that project's checker semantics, and then decides whether another project must participate in the declaration build. For native TypeScript dependencies, this preserves four separate facts:

| Fact                                                   | Question it answers                                                                                     | Why it cannot decide a reference on its own                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Resolution target                                      | Which file does the current checker resolve the specifier to, or is there no target?                    | The target may be an existing declaration, current-project source, or another project's source              |
| Compiler input admission                               | Did the original resolved target enter the current bounded TypeScript `Program`?                        | Being read by the compiler does not mean the current leaf owns it or that it actually supplies the types    |
| Type evidence (`TypeEvidence`)                         | Do types come from checker source, a concrete declaration, an ambient declaration, or are they missing? | The type source can differ from the original resolution path                                                |
| Compiler relation requirement (`referenceRequirement`) | Is a source-semantic or compiler-membership relationship still needed?                                  | A non-null requirement is only a candidate; a valid, build-capable declaration provider must still be found |

Here, `Program` is the TypeScript program context the checker uses to analyze a set of files. A “declaration provider” is a managed source leaf that supplies declaration output for this build relationship.

### Collect Dependencies with Source Provenance

Native TypeScript uses its owning toolchain's AST to collect static imports, re-exports, type imports, literal dynamic imports, and supported CommonJS forms. An import belongs first to the analysis scope of the leaf where it occurs. An import in a test config does not become a library config reference merely because both are in the same package.

Once Vue, Astro, or Svelte resolution semantics are established, collection uses the official generated TypeScript representation. Each generated dependency must map strictly back to user source before it can participate in graph inference. Synthetic dependencies that cannot map back to source remain observations and create no edges; damaged or ambiguous mappings fail analysis.

A specifier in the semantic representation can differ from the source text. For example, Vue's `<script src="./entry.ts">` may be reported as `./entry.js`, while file and line locations still point to the original source. See [Checker Configuration](./config/checkers.md) for toolchain requirements.

### Determine Whether a Compiler Relation Is Required

These conditions combine different facts. Do not read the table as a classifier based only on file extensions:

| Condition                                                                                                                                                  | Effect on a new source reference                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| The resolved target is `.d.ts`, `.d.mts`, or `.d.cts`                                                                                                      | Stops at the existing declaration boundary without inferring a source project reference                        |
| Actual types come from a concrete declaration                                                                                                              | Adds no source relationship, even if the original resolution still records a source path                       |
| A non-declaration source target exists, and type evidence is neither concrete nor ambient declaration evidence                                             | Retains a `source-semantic` requirement; this can also happen with `missing` type evidence                     |
| A local source target and ambient declaration evidence exist, and the target is not already covered by explicit compiler inputs or other accepted coverage | May retain a `compiler-membership` requirement                                                                 |
| No resolved target exists, but ambient declaration evidence does                                                                                           | Retains a typed semantic observation without proving that a physical runtime resource or virtual module exists |
| Neither a resolved target nor type evidence exists                                                                                                         | Retains an unresolved record; the relevant dependency comparison is incomplete and produces diagnostics        |

For example, if the recorded resolution path is still `core/src/index.ts` but actual type evidence comes from a concrete declaration file, that source path alone cannot justify adding a reference from `app`. Conversely, a source target with missing type evidence does not mean “no declaration-build requirement.” A requirement may remain, but missing evidence cannot be interpreted as available types.

The same distinction applies to ambient declarations. They can explain the type source without always replacing the need to admit local source into a compiler relationship. “Already covered” here means the target is a root input of the `Program`, an input of a resolved project reference, or a file the compiler identifies as an external library file. Entering the `Program` through an ordinary import alone does not satisfy this coverage condition.

### Validate the Target and Generate the Relationship

If a compiler relation is required, Limina checks:

1. Whether the target belongs uniquely to another managed source leaf.
2. Whether the target can provide declaration build output.
3. Whether both ends have the same final `tsc`, `tsgo`, or `vue-tsc` checker.
4. Whether graph rules allow the relationship.

When these conditions hold, Limina maps the source leaves to declaration configs under `.limina/tsconfig/checkers/<checker>/projects/` and writes generated `references`. Dependencies within one leaf do not produce self-references. External dependencies without managed source ownership do not acquire internal workspace references from this process either.

Dependency declarations in `package.json` authorize package imports; they cannot replace this evidence. A package dependency, an existing file, or successful runtime resolution alone is insufficient to generate a declaration reference.

## Who Updates an Existing Declaration Target?

Suppose the public entry of `core` has both type and runtime branches:

```json [packages/core/package.json]
{
  "name": "@acme/core",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./src/index.ts"
    }
  }
}
```

When the consuming checker actually selects `dist/index.d.ts`, Limina treats it as existing declaration consumption. The `default` branch pointing to source does not change that type-resolution result. A handwritten `src/index.d.ts` follows the same rule.

This relationship does not trigger a source declaration build for `core`. The project's own build, watch, or release workflow must maintain the declaration file's existence, freshness, and consistency with runtime output.

## Declaration References and Framework Scheduling

Limina records two execution relationships separately:

| Edge type              | Purpose                                                                           | Written to generated `references`?             |
| ---------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| `declaration-provider` | An upstream project supplies declarations before a downstream build consumes them | Yes; both ends must use the same build checker |
| `framework-schedule`   | Orders checking or building of supported framework targets                        | No; it may cross checker identities            |

For example, when Astro source imports a Vue component and the Astro toolchain confirms the target, the relationship can schedule the target's Vue work before the consumer. It does not create a declaration project for the Astro leaf. Astro and Svelte checkers type-check per leaf without generating declarations. TypeScript code that needs independent declaration output should be split into a build-capable source config.

Pure framework-scheduling cycles can be handled as one scheduling component. Declaration project-reference cycles still fail because they cannot express an execution order between independent declaration projects.

### Why Checker Identity Propagates

Before generated paths and execution targets are created, build-capable configs connected through allowed compiler relationships, aggregator membership, or `implicitRefs`, and needing to share declaration caches, form a group. A single known checker identity propagates to the whole group. With no known identity, the ordinary TypeScript default is used. Multiple different identities cause graph preparation to fail. Successful declaration-provider edges record `cacheReuse: "reusable"`.

A known identity comes from ownership evidence such as named checker constraints or a confirmed framework. The ordinary TypeScript default is applied only if the whole group still has no known identity. An automatically discovered shared TypeScript leaf connected to a Vue leaf can therefore use `vue-tsc` with it. Explicitly fixing the shared leaf to `tsc` instead creates a conflict when the same group requires both `tsc` and `vue-tsc`.

Execution identity and resolution semantics are determined separately. An ordinary TypeScript project can be built by `vue-tsc` because it shares declaration caches with a Vue project while keeping its established TypeScript dependency semantics. Its dependencies are not reinterpreted as Vue.

## Runtime Resolution Cannot Repair a Checker Resolution Failure

Once a project's resolution semantics are established, a missing checker target remains missing. Oxc, workspace export resolution, file existence, resource suffixes, and virtual-module allowlists cannot supply a new target on the declaration-inference path.

During initial checker ownership inference, and only with `missing` type evidence, Oxc identifies eligible physical framework candidates. It is not a fallback resolver for a project whose semantics are already established. Separate physical-resource checks and runtime-oriented source checks do not generate declaration references in place of the checker either.

For an actually observed named workspace-package import, start by fixing type entries, `moduleResolution`, `paths`, `customConditions`, or the checker toolchain. A semantic observation with only ambient declaration evidence is a different case and does not establish that a runtime target exists.

## Relationships Static Analysis Cannot See

Code generation, route manifests, or plugin assembly can create declaration-build relationships that static analysis cannot currently observe. Add `liminaOptions.implicitRefs` with a reason to the source leaf in that case. It supplements the graph, but still requires valid targets, compatible checkers, and permitted rules; it does not supply missing resolution capabilities.

See [Edges Invisible to Static Import Analysis](./why-import-is-not-references.md#edges-invisible-to-static-import-analysis-must-be-declared-explicitly) for a configuration example. Users still maintain aggregator membership `references`; the relationships added here are declaration relationships between source leaves.

## Why the Reference Graph Is Not Pruned

**The current implementation does not analyze final `.d.ts` output to remove references.** The generated graph uses validated source compiler relationships and explicit `implicitRefs`, so it can be wider than the final declaration-file dependency graph.

For example, this import appears only in a function implementation:

```ts
import { initCore } from '@acme/core';

export function startApp() {
  initCore();
}
```

The final declaration may contain only:

```ts
export declare function startApp(): void;
```

But the checker still needs to understand the source relationship before emitting that declaration. Whether an import is marked `type` or appears in an export statement alone cannot determine its effect on declarations. Type inference can expose a type used in an implementation through a public interface:

```ts
import { createClient } from '@acme/core';

export const client = createClient();
```

Its declaration may contain `import('@acme/core').Client`. Re-exports, class members, generic constraints, and conditional types can also retain upstream types. Reliable pruning would require separate analysis of declaration semantics, output provenance and freshness, and differences between frameworks and declaration bundlers. That capability is not currently provided.

This tradeoff has two direct effects: upstream source changes may affect a wider incremental checking scope, and runtime cycles between leaves may become generated reference cycles even when absent from final declarations. Narrowing public API types can help control declaration leakage, but does not automatically remove references still derived from source relationships.

Resolving these cycles requires changes to source or declaration boundaries, not manual deletion of `.limina` references. See [cycle handling](./why-import-is-not-references.md#runtime-cycles-are-not-project-reference-cycles) for merging tightly coupled scopes within a package, extracting shared contracts, and moving runtime assembly to a higher-level entry.

## How Graph Check Uses These Decisions

Graph check computes the declaration build graph in memory and checks it against source import facts; it does not write checker files under `.limina`. `graph prepare` and execution paths that need generated checker configs materialize the same graph on disk.

Reference-completeness checking also uses declaration-provider classification:

- An import resolving to `.d.ts`, `.d.cts`, or `.d.mts` does not require a source project reference.
- A dependency with a non-null declaration relationship requirement that reaches a valid source provider is checked for its corresponding project reference.
- If TypeScript cannot confirm a declaration provider, graph check does not add a project reference from Oxc's runtime resolution result.
- Extra-reference checks cover reachable declaration projects with files. They skip generated checker roots, expected edges, targets outside the reachable project set, references within the same generated checker namespace, and allowed references. Remaining references may be reported as extra.
- Cycles between generated declaration projects are reported as project-reference cycles.

Valid generated references within one checker are among those skipped, so this extra-reference check does not prove that every edge in the current generated graph is minimal. The extra-reference diagnostic applies only to reachable declaration targets left after filtering. Do not edit generated files to trigger or suppress it.

Graph check also covers more than declaration providers. Checks involving package entries, runtime resolution, dependency declarations, and boundary rules may use other resolution results as evidence. This section concerns reference inference and reference-completeness checking.

## Understanding Common Diagnostics

### Unresolved workspace import {#unresolved-workspace-import}

`Unresolved workspace import` applies to an actually observed named workspace-package import for which the consuming checker has no resolved target. It does not report an Oxc-versus-TypeScript comparison.

Start with package type entries, tsconfig module-resolution options, path aliases, and checker configuration. Semantic observations with only ambient declaration evidence and unobserved generated dependencies are not treated as unresolved workspace consumption.

### Workspace source import uses package export without a type entry {#workspace-source-import-uses-package-export-without-a-type-entry}

`Workspace source import uses package export without a type entry` means governed workspace source imports a package entry through `package.json#exports`, but that entry lacks a stable TypeScript type entry or checker source entry.

For an entry intended for source governance, add a type-declaration branch or import a stable public type entry. If it is only a runtime resource, avoid using it as a type-dependency entry for governed source.

### Missing project reference for workspace import {#missing-project-reference-for-workspace-import}

`Missing project reference for workspace import` means a static import reaches another source provider that needs declaration output, but the current generated declaration config has no corresponding project reference.

First check that both sides belong to the intended checker scopes and that each default `tsconfig.json` has been selected by automatic discovery or a named checker scope. Explicit `include` is not required. Named terminal configs such as `tsconfig.lib.json` and `tsconfig.test.json` must be reachable through the effective `references` closure of a selected entry. Placing those leaf paths directly in `include` is rejected.

For example, once a root `tsconfig.json` is automatically discovered or explicitly selected, membership references can include named leaves:

```json [tsconfig.json]
{
  "files": [],
  "references": [
    { "path": "./packages/app/tsconfig.lib.json" },
    { "path": "./packages/app/tsconfig.test.json" }
  ]
}
```

```sh
pnpm exec limina graph prepare
pnpm exec limina graph check
```

A chain through another default aggregator is also supported: `tsconfig.json → packages/app/tsconfig.json → tsconfig.lib.json`. Intermediate aggregators must use the default `tsconfig.json` name. Do not maintain build references by hand in terminal source configs; Limina derives their declaration references from provider evidence. See [Checker Configuration](./config/checkers.md) for selection and closure rules. If the diagnostic remains, regeneration is no substitute for inspecting the actual provider evidence.

### Extra project reference not proven by static imports {#extra-project-reference-not-proven-by-static-imports}

`Extra project reference not proven by static imports` means a reference remains unproven after the scoped extra-reference checks described above.

If it is a real declaration relationship that source analysis cannot see, express it through `implicitRefs` in the source leaf. `graph.rules.<label>.allow.refs` only explains an existing extra reference; it does not create one. Otherwise, correct the source relationship and regenerate. Configs in `.limina` remain tool-maintained.

### Generated project reference cycle {#generated-project-reference-cycle}

`Generated project reference cycle` means generated declaration-project `references` form a cycle. It may come from mutually dependent source declaration relationships or explicit `implicitRefs`. Successful `declaration-provider` edges share the same final checker identity; conflicting build-checker identities fail preparation.

Check whether source boundaries in the cycle are too fine-grained, whether shared types belong in a lower-level module, or whether runtime assembly belongs in a higher-level entry. See [Runtime Cycles Are Not Project Reference Cycles](./why-import-is-not-references.md#runtime-cycles-are-not-project-reference-cycles) for complete repair examples.
