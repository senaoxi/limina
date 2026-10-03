# From Import Resolution to a Declaration Build Graph

`tsc -b` uses `references` to determine project build relationships in a monorepo.

Deciding whether a `tsconfig` needs a project reference requires distinguishing package imports, consumption of `dist/index.d.ts` through `exports.types`, test-only imports, and runtime cycles. These relationships can have different effects on declaration builds.

Incorrect `references` affect TypeScript build ordering, incremental caches, and upstream declaration consumption. Missing references may omit declaration build dependencies; extra references may add unnecessary build dependencies or introduce project-reference cycles.

Within the user-declared source type configurations, Limina uses the current checker and `tsconfig` to identify the type provider for each import. It then validates whether the relationship should become a generated `reference`, remain declaration-file consumption, or produce a diagnostic. Imports and `package.json` dependencies do not directly become build references.

This page follows an import through declaration build graph inference and explains why the current implementation does not minimize references based on the final `.d.ts` output.

## Why Manually Maintaining the Reference Graph Is Error-Prone

Consider a normal import:

```ts
import { createClient } from '@acme/core';
```

For TypeScript declaration builds, determine which type provider the current `tsconfig` uses for this import:

```text
Where does the current tsconfig obtain the type declarations for createClient?
```

In a monorepo, this import can correspond to different relationships.

TypeScript may resolve it to `packages/core/dist/index.d.ts`. In that case, the current project is consuming an existing declaration file, not another source project.

TypeScript may also resolve it to `packages/core/src/index.ts`. In that case, the current project may need another source scope to produce declaration output first.

It may resolve to an external package declaration or a `Node` built-in module. Such relationships usually do not belong to internal workspace `references`.

If TypeScript cannot resolve the import under the current configuration, the type entry, `tsconfig` settings, or package boundary may need to be fixed.

A generated reference requires evidence about the type provider under the current checker and `tsconfig` semantics. An import statement or resolved file alone is insufficient.

When maintaining `references` manually, users have to keep making these boundary decisions. The larger the repository and the more `tsconfig` files it contains, the easier it is to run into problems such as:

```text
Treating package.json dependencies as TypeScript references
Treating .d.ts consumption as source project references
Ignoring file ownership differences between test, script, and source configs
Missing real declaration build edges that are not visible through static imports
Pulling runtime cycles into the TypeScript project-reference graph
```

Limina repeats these checks when generating the reference graph.

## How Limina Decides Whether an Import Needs a Project Reference

To infer references, Limina collects imports, identifies providers, and validates their relationships:

```text
Source file
  -> collect import/export module specifiers
  -> determine the TypeScript declaration provider
  -> map the result to project references, declaration-file consumption, or diagnostics
```

The first step only collects statically identifiable module specifiers from source code, such as static imports, re-exports, type-only imports, module strings in dynamic imports, and some statically recognizable `CommonJS` forms. At this stage, Limina only records source facts: which file contains the import, what kind of import it is, and which module specifier it uses. It does not decide whether the import is valid, and it does not decide whether a `reference` should be generated.

For locked Vue, Astro, and Svelte sources, this first step runs against the official generated TypeScript representation rather than a lightweight framework collector. Limina enumerates generated dependencies with the owning toolchain's TypeScript instance, proves source provenance through strict reverse mapping, and records the generated semantic spelling. For example, source `<script src="./entry.ts">` may be reported as `./entry.js`; the file and line still identify the original framework source. Synthetic dependencies without a source projection remain non-edge observations.

The second step records the checker/toolchain target and existing `TypeEvidence`, then keeps the compiler relation requirement separate. Native TypeScript facts also record whether the original target entered the bounded Program. Physical resolution, Program admission, and actual type provision are different facts; none alone grants a generated reference.

| Resolution / type evidence                                                      | Compiler relation and resulting interpretation                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Physical `.d.ts` / `.d.cts` / `.d.mts`, or actual concrete declaration provider | No new source relationship, even if the original resolution also records source.                                   |
| Source within the current config                                                | No cross-project reference.                                                                                        |
| Source in another managed config with a non-null requirement                    | Candidate declaration relationship; still requires ownership, checker capability, identity, and policy validation. |
| Ambient types plus local source outside covered compiler inputs                 | May require `compiler-membership`; ambient evidence does not universally suppress references.                      |
| Source target without a current type provider                                   | May retain a `source-semantic` requirement; missing evidence is not proof of type provision.                       |
| External dependency without a governed source owner                             | No internal workspace project reference.                                                                           |
| No target, ambient module evidence                                              | Typed `semantic-only` observation; this does not prove a physical runtime resource or virtual module exists.       |
| No target and missing evidence                                                  | Unresolved observation; dependency comparison becomes incomplete and records diagnostics.                          |

The third step validates the candidate relationship. For a permitted declaration relationship to another managed source config with the same final build checker, Limina maps the source config to its generated `.dts.json` and adds that project reference. Astro/Svelte relationships can instead become framework scheduling edges. A same-config target produces no self-reference.

This is also where Limina differs from a general-purpose module resolver. After framework authority is locked, a checker miss cannot be rescued by Oxc, workspace export resolution, file existence, resource-extension heuristics, or a virtual-module allowlist. Classification may continue from checker/type evidence, but resolution cannot invent a new target. In this declaration-inference path, Oxc is used only for missing-only pending-ownership bootstrap. Separate physical-resource and runtime-oriented source checks do not grant a locked checker a new semantic target.

## Cases That Matter When Generating the Reference Graph

Reference generation checks whether an import requires declaration output from another source scope. The following cases affect that decision.

### A package.json dependency does not imply a project reference

A package-level workspace dependency only means that the package is allowed to use another package:

```json
{
  "dependencies": {
    "@acme/core": "workspace:*"
  }
}
```

This does not imply that the current `tsconfig` should reference `@acme/core`. If the files owned by the current `tsconfig` do not import `@acme/core`, or if the import does not resolve to a managed source scope of `@acme/core`, Limina should not generate a project reference merely because a package-level dependency exists.

`package.json` dependencies are better suited for checking whether cross-package usage has a dependency declaration. `references` express declaration build ordering. These two concepts are related, but they are not interchangeable.

### An import outside the current tsconfig ownership does not affect the current declaration graph

A single package may contain multiple `tsconfig` files:

```text
packages/app/
  tsconfig.lib.json
  tsconfig.test.json
  tsconfig.scripts.json
```

If a test file owned by `tsconfig.test.json` imports `@acme/core`, that does not mean `tsconfig.lib.json` also needs to reference `@acme/core`. Limina only considers the actual file set owned by the current source type configuration when generating the reference graph.

Before deciding whether a project reference is needed, the first question is which `tsconfig` owns the file where the import appears.

### Resolving to an existing declaration file does not create a source project reference

If TypeScript resolves an import to:

```text
packages/core/dist/index.d.ts
```

or:

```text
packages/core/src/index.d.ts
```

Limina treats it as declaration-file consumption. Even if the package belongs to the current workspace, Limina does not reverse-engineer the source `tsconfig` behind that declaration file and add a source project reference.

The meaning of this edge is:

```text
The current project consumes an existing declaration file.
The freshness of that declaration file is maintained by the provider's own build, watch, CI, or release workflow.
```

Limina does not automatically build or refresh a `.d.ts` file just because another project consumes it.

### Resolving to source inside the current scope does not require a cross-project reference

If an import resolves to a source file owned by the current `tsconfig`, it is an internal dependency of the current scope and does not require a project reference.

For example:

```text
packages/app/src/index.ts
packages/app/src/client.ts
packages/app/tsconfig.lib.json
```

If `index.ts` imports `client.ts`, and both files are owned by `tsconfig.lib.json`, no cross-project reference is needed. The current `tsconfig` handles that relationship itself.

### Resolving to another managed source scope may require a project reference

A target in another managed source scope is a candidate. A generated declaration reference also requires a non-null compiler relation requirement, a build-capable provider, the same final checker identity, and permission under the graph rules. Concrete declaration evidence can stop the source relationship even when a source target was recorded.

For example:

```text
packages/app/src/index.ts
  -> packages/core/src/index.ts

packages/app/tsconfig.lib.json
packages/core/tsconfig.lib.json
```

If a source file owned by `packages/app/tsconfig.lib.json` imports `@acme/core`, TypeScript resolves it to `packages/core/src/index.ts`, and the relationship satisfies those conditions, Limina maps the `core` source configuration to its generated `.dts.json` and adds a project reference from the generated declaration configuration for `app`.

This project reference expresses a declaration build dependency. It is not a package publishing relationship, and it is not a runtime bundling relationship.

### Real edges that are invisible to static imports must be explicit

Some dependency relationships do not appear directly in source-level `import/export` statements. Examples include code generation, route manifests, plugin registration, runtime manifests, or framework conventions that become real module connections only after another build step.

Limina does not infer these declaration build edges from strings, manifests, or project conventions.

If such a relationship is truly part of the declaration build graph, it should be expressed explicitly through `liminaOptions.implicitRefs`. Its meaning is: this edge cannot be proven from static import records, but the user explicitly declares it as a declaration build dependency for the current source scope.

`implicitRefs` declares relationships not visible through static imports. Each relationship remains subject to graph rules; it is not an import allowlist or a policy bypass.

### Runtime resolution does not imply a valid checker provider

A runtime resolver finding a file does not establish a type provider under the current checker and `tsconfig`. For an observed named workspace import, graph check reports `Unresolved workspace import` when the consuming checker has no target. A semantic-only ambient observation is a separate case and does not prove a physical runtime target exists.

Check type entries, `moduleResolution`, `exports.types`, `paths`, `baseUrl`, `customConditions`, and checker configuration. The fix is to supply the required checker evidence; a runtime-only result cannot repair a locked semantic miss.

### Declaration providers require one checker identity

Before generating paths or execution targets, Limina joins build-capable configs connected by accepted compiler relations, solution closures, or `implicitRefs`. One existing checker identity colors the component; an uncolored component uses the ordinary TypeScript fallback. Conflicting `tsc`, `tsgo`, or `vue-tsc` identities fail preparation. A successful `declaration-provider` edge has the same checker on both ends and `cacheReuse: "reusable"`.

Semantic authority freezes before this build coloring. An ordinary TypeScript project can therefore execute through `vue-tsc` without reinterpreting its dependencies using Vue semantics.

Keep the execution relations separate:

```text
declaration-provider
  -> generated TypeScript reference, same build checker identity

framework-schedule
  -> execution ordering, may cross checker identities, no generated reference
```

Astro and Svelte leaves do not produce declaration projects. Scheduling a provider does not prove that it supplies consumable declarations. Existing concrete `.d.ts` files remain declaration-consumption boundaries and do not acquire a new source reference through output attribution.

### Generated references must not form project-reference cycles

Runtime module systems allow certain forms of cyclic dependencies, but TypeScript project references express build ordering. Generated declaration `references` must be orderable by build-mode checkers.

If two source scopes import each other, Limina may generate relationships such as:

```text
packages/a/tsconfig.dts.json -> packages/b/tsconfig.dts.json
packages/b/tsconfig.dts.json -> packages/a/tsconfig.dts.json
```

This graph cannot provide a stable declaration build order. Limina’s graph check treats actual `references` between generated declaration projects as a directed graph and reports a cycle when it finds a multi-node strongly connected component or a self-reference.

Source modules may still contain cycles within one project. Cycles between generated declaration references need to be resolved, for example by merging tightly coupled source scopes, extracting shared contracts, moving runtime wiring to a higher-level entry, or using an explicitly maintained declaration boundary.

## Why the Reference Graph Is Not Tree-Shaken

Two modules may call each other at runtime without referencing each other in their final `.d.ts` files. Limina can still generate a reference cycle from their source relationships.

The reference graph here is the declaration project-reference graph generated through TypeScript `references`. Minimizing it by emitted `.d.ts` dependencies would require a separate analysis beyond source-level provider relationships.

A future analysis of emitted declarations might remove edges used only by runtime implementation and some project-reference cycles caused by implementation coupling. Such an analysis would need to confirm which dependencies remain in the final declaration output.

For example:

```ts
import { initCore } from '@acme/core';

export function startApp() {
  initCore();
}
```

The final declaration may only be:

```ts
export declare function startApp(): void;
```

Here, `@acme/core` does not appear in the exported declaration. A minimization algorithm targeting the final `.d.ts` output could theoretically remove this edge.

Consider another example where the exported type is explicitly narrowed:

```ts
import { createClient } from '@acme/core';

export interface ClientInfo {
  id: string;
}

export function createInfo(): ClientInfo {
  const client = createClient();
  return { id: client.id };
}
```

If the final `.d.ts` only exposes `ClientInfo` and does not reference types from `@acme/core`, this source dependency may not need to appear in the minimal reference graph.

Reliable edge removal would require analyzing whether the final `.d.ts` generated by the current `tsconfig` still references the target declaration provider. Source-level `import` syntax alone cannot establish that.

Many type relationships only become visible after declaration emit.

For example, an exported value may leak an upstream type through inference:

```ts
import { createClient } from '@acme/core';

export const client = createClient();
```

The final declaration may become:

```ts
export declare const client: import('@acme/core').Client;
```

In this case, `@acme/core` is still part of the final declaration output and cannot be removed.

Exported functions have a similar issue:

```ts
import { createClient } from '@acme/core';

export function createAppClient() {
  return createClient();
}
```

If the return type is not explicitly narrowed, TypeScript may expose a type from `@acme/core` in the emitted `.d.ts`. The source code may look like it only uses an implementation dependency, but the final declaration still needs the upstream type.

Re-exports, public or protected `class` members, generic constraints, conditional types, mapped types, and entry-point forwarding can also bring upstream types into declaration output. Removing edges would therefore require semantic analysis of that output, rather than classification by apparent implementation-only imports.

The current reference-inference path reads source dependency facts and explicit `implicitRefs`; it does not analyze emitted `.d.ts` to remove edges. The declaration-output analysis described here is a possible future design, not implemented behavior or a performance guarantee.

If Limina were to run reference graph tree-shaking by default in this model, it would need to handle several additional problems:

- how to efficiently obtain or simulate the final declaration output of each source `tsconfig`;
- how to distinguish TypeScript’s raw `.d.ts` output, framework-checker output, declaration bundler output, and package public API shape;
- how to avoid removing real project references based on stale `.d.ts` output;
- how to reuse previous declaration-output analysis when source files change frequently, instead of rerunning full semantic analysis on every check;
- how to explain removed edges, especially when they still exist in the source import graph.

Those questions are outside the current reference generation path. Limina collects facts from owned source inputs under frozen semantic authority, validates compiler relation requirements and checker ownership, adds explicit supplemental edges, generates `references`, and checks the resulting declaration graph.

This trade-off means the reference graph may be broader than the final declaration output. Some runtime implementation dependencies may participate in generated `references` even if they do not appear in the final `.d.ts`.

The most direct effect is that the dependency scope of incremental declaration builds may be broader. If source code in A resolves to a managed source scope in B, Limina may generate an A -> B declaration build reference. Even if A’s final `.d.ts` does not reference B, changes in B may still affect A’s build ordering and incremental check path. This is a more conservative build graph, not the minimal dependency graph of the final declaration output.

Another effect is that cyclic dependencies may be surfaced earlier. Two source scopes may only call each other at runtime, and their final declarations may not reference each other. But in Limina’s current generated graph, those source imports may still form a generated project-reference cycle. This diagnostic does not necessarily mean that the final `.d.ts` files cyclically reference each other. It means the source-level declaration provider relationship crosses independent `tsconfig` boundaries and cannot be stably ordered as a TypeScript project-reference graph.

In the current implementation, an owned source import with a validated compiler relation requirement can generate a declaration reference even when its types do not appear in the final declaration output. Users should not fix this by manually deleting the generated project reference. If the edge comes from a real source import, deleting the generated reference only makes the generated graph inconsistent with the source facts.

Depending on the source relationship, possible changes include:

- adding explicit public API types to control declaration type leakage; this alone does not remove a reference inferred from the remaining source import;
- moving tightly coupled source scopes into the same source `tsconfig`, so the cycle stays inside a project boundary;
- extracting shared types, protocols, or abstractions into a lower-level `contracts` or `shared` module;
- moving startup, registration, or plugin wiring code to a higher-level entry point;
- if one side is intentionally a declaration boundary, exposing types through explicitly maintained `.d.ts` files and keeping them fresh through the provider’s own build workflow.

These changes adjust source relationships or declaration boundaries. Limina then generates references from the updated source facts; it still does not minimize the graph by emitted `.d.ts` dependencies.

## How Graph Check Uses This Classification

Graph check calculates the declaration build graph in memory and compares it against the source import facts. It does not write checker files under `.limina`; `graph prepare` and execution paths that need generated checker configs materialize the same graph on disk.

For `references` completeness checks, graph check also uses declaration provider classification:

- If an import resolves to `.d.ts`, `.d.cts`, or `.d.mts`, graph check does not require a source project reference.
- If a dependency has a non-null declaration relation requirement and reaches a valid source provider, graph check verifies the expected project reference.
- If TypeScript cannot confirm the declaration provider, graph check does not add a project reference from Oxc’s runtime resolution result.
- Extra-reference checks apply to reachable declaration projects with files. They skip generated checker roots, expected edges, targets outside the reachable project set, references within the same generated checker namespace, and allowed references. A remaining edge may be reported as extra.
- If generated declaration projects form a cycle, graph check reports a project-reference cycle.

Graph check is not limited to declaration provider logic. Checks related to package entries, runtime resolution, dependency declarations, and boundary rules may still use other resolution results as evidence. This section only describes the main path for `references` inference and `references` completeness checks.

## Common Cases

### Consuming existing declaration files

If a workspace package exposes declarations through `exports.types`:

```json
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

When another package imports `@acme/core`, and TypeScript under the current `tsconfig` resolves the import to `dist/index.d.ts`, Limina does not generate a project reference to the source `tsconfig` of `@acme/core`.

This does not mean Limina will build or refresh `dist/index.d.ts`. If a package chooses to consume build output, that output must still be maintained by its own build, watch, CI, or release workflow.

### Depending on another source scope

If TypeScript resolves an import to a source file owned by another source scope:

```text
packages/core/src/index.ts
```

and that file needs to provide type declarations through the target `tsconfig`’s declaration output, Limina makes the current generated declaration configuration reference the target generated `.dts.json`.

This project reference expresses a declaration build dependency. It is not a package publishing relationship, and it is not a runtime bundling relationship.

### Using handwritten declaration files

If TypeScript resolves to a handwritten declaration file under the source directory:

```text
packages/core/src/index.d.ts
```

Limina treats it as an existing declaration file. Even if the file is located under `src`, Limina does not infer a source project reference from it.

### Runtime-only dependencies

If an import only serves runtime implementation and the final declaration output does not reference the target package’s types, it may theoretically not belong to the minimal reference graph. Limina currently does not remove such an edge based on the final `.d.ts`.

If such an edge causes a project-reference cycle, it usually means the source implementation relationship crosses a type build boundary. The fix is not to manually delete the generated project reference, but to revisit source boundaries, exported types, and runtime wiring.

## Understanding Common Diagnostics

### Unresolved workspace import

This diagnostic applies to an observed import of a named workspace package when the consuming checker has no target. It does not report a comparison between Oxc and TypeScript.

Check package type entries, `tsconfig` module resolution settings, path aliases, and checker configuration first. Ambient-only semantic observations and unobserved generated dependencies are not treated as unresolved workspace consumptions by this check.

### Workspace source import uses package export without a type entry

This diagnostic means that governed workspace source imports enter a package through `package.json#exports`, but the entry does not provide a stable TypeScript type entry or checker source entry.

If this entry is intended for source governance, add a type declaration branch or import through a stable public type entry. If it is only a runtime resource, avoid using it as a type dependency entry for governed source code.

### Missing project reference for workspace import

This diagnostic means that a static import reaches another source provider that needs declaration output, but the current generated declaration configuration does not contain the corresponding project reference.

Check that each side is governed by its intended checker and that its default `tsconfig.json` entry is selected by `checker.include`. Named terminal configs such as `tsconfig.lib.json` and `tsconfig.test.json` must be reachable through the selected entry’s effective `references` closure; selecting those leaf paths directly with `include` is rejected.

For example, select the root entry with `include: ['tsconfig.json']` and let it include the named leaves:

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

A chain through another default solution (`tsconfig.json → packages/app/tsconfig.json → tsconfig.lib.json`) is also supported. An intermediate solution must use the default `tsconfig.json` name. Keep terminal source configs free of hand-maintained build references; Limina derives their declaration references from provider evidence. See [checker configuration](./config/checkers.md) for selection and closure rules. Regeneration does not replace checking the actual provider evidence if the diagnostic remains.

### Extra project reference not proven by static imports

This diagnostic reports a reference that remains after the bounded extra-reference checks described above.

If it represents a real declaration relationship invisible to source analysis, record the source leaf relationship through `implicitRefs` or document the allowed reference with `graph.rules.<label>.allow.refs`. Otherwise, remove the incorrect source relationship and regenerate. Keep the generated `.limina` configs tool-owned.

### Generated project reference cycle

This diagnostic means that generated declaration project `references` form a cycle. The cycle may come from mutual source-derived declaration relationships or explicit `implicitRefs`. Successful declaration-provider edges use one final checker identity; conflicting build identities fail preparation.

First check whether the source boundaries in the cycle are too fine-grained, whether shared types should be moved lower, whether runtime wiring should be moved upward, or whether one side should become an explicitly maintained declaration boundary.

## Recommended Mental Model

Limina uses import records and resolution results as evidence to build a declaration build graph and an architecture check graph for a monorepo.

Each tool is responsible for a different part:

```text
TypeScript syntax AST and scanner
  -> collect source-authored import, export, import-type, and CommonJS evidence

Checker-semantic TypeScript resolver
  -> determine declaration providers under the current checker and tsconfig

Oxc resolver
  -> qualify physical framework candidates only during pending ownership discovery

Limina graph model
  -> map declaration providers to project references, declaration-file consumption, or diagnostics
```

When using these results, distinguish the following cases.

First, a file being resolvable at runtime does not mean the declaration build should reference the `tsconfig` that owns that source file.

Second, resolving to `.d.ts` does not mean Limina will automatically build that declaration file. It only means current project-reference inference does not need to treat that edge as a source-provider project reference.

Once a project has a locked semantic authority, an unresolved checker-semantic import remains unresolved. Oxc does not provide a fallback target or declaration-provider evidence for that import.

Third, source-level `import` relationships may be more conservative than the minimal dependency relation of the final `.d.ts`. Limina currently generates references from validated source-level provider relationships and does not minimize them based on final declaration output.
