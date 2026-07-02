# From Import Resolution to a Declaration Build Graph

When adopting `tsc -b` in a monorepo, the hardest part is often not enabling `composite` or `declaration`. The harder part is maintaining `references`.

If one package imports another package, should the current `tsconfig` add a project reference? If a workspace package already exposes `dist/index.d.ts` through `exports.types`, should consumers still reference its source project? If an import only appears in a test configuration, should the production source configuration also reference it? If two packages call each other at runtime, but their final `.d.ts` files do not reference each other, should that count as a declaration build dependency?

These decisions are easy to get wrong when maintained by hand. Incorrect `references` affect TypeScript build ordering, incremental cache behavior, and upstream declaration consumption. Missing references may omit real declaration build dependencies. Extra references may make the graph unnecessarily broad, or even introduce project-reference cycles.

Limina addresses this problem by inferring which source scopes need declaration build references, based on the source type configurations declared by the user and the TypeScript resolution result under the current checker and `tsconfig`. It does not simply copy `import` statements into `references`, and it does not treat `package.json` dependencies as the build graph. Instead, it first determines which provider supplies the type declarations for an import, and then decides whether the edge should become a generated `reference`, remain a declaration-file consumption edge, or be reported as a diagnostic issue.

This page does not cover quick start usage, complete configuration reference, or full troubleshooting. It focuses on one path: how Limina turns a module import into an auditable declaration build graph edge, and why the current implementation does not tree-shake the reference graph according to the minimal dependency relation of the final `.d.ts` output.

## Why Manually Maintaining the Reference Graph Is Error-Prone

Consider a normal import:

```ts
import { createClient } from '@acme/core';
```

If we only look at the source code, this import appears to mean that the current project depends on `@acme/core`. For TypeScript declaration builds, however, the more important question is not “where is the runtime code loaded from?” but:

```text
Where does the current tsconfig obtain the type declarations for createClient?
```

In a monorepo, this import can correspond to different relationships.

TypeScript may resolve it to `packages/core/dist/index.d.ts`. In that case, the current project is consuming an existing declaration file, not another source project.

TypeScript may also resolve it to `packages/core/src/index.ts`. In that case, the current project may need another source scope to produce declaration output first.

It may resolve to an external package declaration or a `Node` built-in module. Such relationships usually do not belong to internal workspace `references`.

If TypeScript cannot resolve the import under the current configuration, the type entry, `tsconfig` settings, or package boundary may need to be fixed.

Therefore, “there is an import” is not enough to decide anything. “It resolved to a file” is also not enough. What matters for `references` is which provider supplies the type declarations under the current checker and `tsconfig` semantics.

When maintaining `references` manually, users have to keep making these boundary decisions. The larger the repository and the more `tsconfig` files it contains, the easier it is to run into problems such as:

```text
Treating package.json dependencies as TypeScript references
Treating .d.ts consumption as source project references
Ignoring file ownership differences between test, script, and source configs
Missing real declaration build edges that are not visible through static imports
Pulling runtime cycles into the TypeScript project-reference graph
```

Limina’s automatic reference graph generation is intended to make these decisions repeatable.

## How Limina Decides Whether an Import Needs a Project Reference

Limina’s decision process can be understood in three steps:

```text
Source file
  -> collect import/export module specifiers
  -> determine the TypeScript declaration provider
  -> map the result to project references, declaration-file consumption, or diagnostics
```

The first step only collects statically identifiable module specifiers from source code, such as static imports, re-exports, type-only imports, module strings in dynamic imports, and some statically recognizable `CommonJS` forms. At this stage, Limina only records source facts: which file contains the import, what kind of import it is, and which module specifier it uses. It does not decide whether the import is valid, and it does not decide whether a `reference` should be generated.

If the project configures import collection for `Vue` files, Limina can collect imports from `<script>` content. This is still only import collection. It is not Vue compilation, and it does not replace type checking by tools such as `vue-tsc`.

The second step asks TypeScript, under the current checker and `tsconfig` context, where the type entry for the import resolves. The result can be roughly classified as follows:

| TypeScript type resolution result                      | Limina interpretation                                | Generate declaration project reference? |
| ------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------- |
| `.d.ts` / `.d.cts` / `.d.mts`                          | Existing declaration file                            | No                                      |
| Source file within the current scope                   | Owned by the current scope                           | No                                      |
| Source file in another Limina-managed source scope     | Requires another scope to produce declaration output | Yes                                     |
| External package declaration or external package entry | External dependency                                  | No                                      |
| Unresolved                                             | Declaration provider cannot be determined            | No, and report diagnostics              |

The third step enters Limina’s generated graph. If the declaration provider is another managed source scope, Limina maps the target source `tsconfig` to the corresponding generated `.dts.json`, and then adds that `.dts.json` to the current generated declaration configuration’s `references`.

This is also where Limina differs from a general-purpose module resolver. `Oxc` can help Limina collect imports and provide runtime resolution clues for diagnostics, but the declaration `references` generated under `.limina` are not determined by Oxc’s resolution result. The reference graph is determined by the TypeScript declaration provider under the current checker and `tsconfig`.

## Cases That Matter When Generating the Reference Graph

The hard part of generating `references` is not determining whether an import exists. The hard part is determining whether that import requires the current declaration build to consume declaration output from another source scope. The following cases directly affect the generated reference graph.

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

### Resolving to another managed source scope creates a project reference

An edge enters the reference graph when the import resolves to another source scope and the target source file is owned by another Limina-managed source `tsconfig`.

For example:

```text
packages/app/src/index.ts
  -> packages/core/src/index.ts

packages/app/tsconfig.lib.json
packages/core/tsconfig.lib.json
```

If a source file owned by `packages/app/tsconfig.lib.json` imports `@acme/core`, and TypeScript resolves that import to `packages/core/src/index.ts`, Limina maps the `core` source configuration to its generated `.dts.json` and adds a project reference from the generated declaration configuration for `app`.

This project reference expresses a declaration build dependency. It is not a package publishing relationship, and it is not a runtime bundling relationship.

### Real edges that are invisible to static imports must be explicit

Some dependency relationships do not appear directly in source-level `import/export` statements. Examples include code generation, route manifests, plugin registration, runtime manifests, or framework conventions that become real module connections only after another build step.

Limina does not guess these edges from strings, manifests, or project conventions. If it guessed incorrectly, generated `references` would become an unreliable build graph.

If such a relationship is truly part of the declaration build graph, it should be expressed explicitly through `liminaOptions.implicitRefs`. Its meaning is: this edge cannot be proven from static import records, but the user explicitly declares it as a declaration build dependency for the current source scope.

`implicitRefs` is not a whitelist and not an escape hatch from graph rules. It supplements real edges that are not visible through static imports. Later graph rules may still decide whether such an edge is allowed.

### Runtime resolution does not imply a valid TypeScript declaration provider

Sometimes the runtime resolution view can find a file, but TypeScript under the current checker and `tsconfig` cannot confirm a usable declaration provider. Diagnostics such as the following usually indicate this situation:

```text
Oxc can resolve this specifier, but TypeScript cannot
```

This does not mean Oxc resolved incorrectly, and it does not mean Limina should add a project reference based on Oxc’s result. It means runtime resolution and type resolution are not aligned.

Typical things to check include type entries, `moduleResolution`, `exports.types`, `paths`, `baseUrl`, `customConditions`, and checker configuration. The fix is to make TypeScript confirm the declaration provider, not to make Limina guess a build edge from runtime resolution.

### Cross-checker source providers must remain consumable

A monorepo may contain both ordinary `tsc` projects and framework-checker projects. Some source scopes may only be handled by a specific checker, for example because they contain framework files or special file extensions.

In this case, Limina can record cross-checker declaration provider relationships in the generated declaration graph and add consumable target declaration projects to the actual `references`.

It is useful to distinguish two kinds of information:

```text
Actual project reference
  -> a real project-reference edge in the TypeScript build graph

Declaration provider edge
  -> a cross-checker declaration provider relationship recorded by Limina for explanation and scheduling
```

The generated reference graph uses only the `references` actually written to generated declaration configurations as build-ordering edges. Declaration provider edges help explain cross-checker relationships, but they are not additional DAG input.

### Generated references must not form project-reference cycles

Runtime module systems allow certain forms of cyclic dependencies, but TypeScript project references express build ordering. Generated declaration `references` must be orderable by build-mode checkers.

If two source scopes import each other, Limina may generate relationships such as:

```text
packages/a/tsconfig.dts.json -> packages/b/tsconfig.dts.json
packages/b/tsconfig.dts.json -> packages/a/tsconfig.dts.json
```

This graph cannot provide a stable declaration build order. Limina’s graph check treats actual `references` between generated declaration projects as a directed graph and reports a cycle when it finds a multi-node strongly connected component or a self-reference.

This does not mean source code can never contain cyclic dependencies. It means this kind of cycle should not cross a TypeScript project-reference boundary. Common fixes include merging tightly coupled source scopes, extracting shared contracts, moving runtime wiring to a higher-level entry, or using an explicitly maintained declaration boundary.

## Why the Reference Graph Is Not Tree-Shaken

The previous section explained that runtime cycles can become generated `references` cycles when they cross TypeScript project-reference boundaries. A natural question is: if two modules only call each other at runtime, and the final `.d.ts` files do not reference each other, why does Limina not simply remove those edges from the reference graph?

The reference graph here means the declaration project-reference graph that Limina generates through TypeScript `references`. The question is whether this graph should follow source-level declaration provider relationships, or whether it should be further minimized according to the final `.d.ts` dependency relation.

Tree-shaking the reference graph is a reasonable optimization direction. It could make the generated reference graph closer to the final declaration output, reduce edges that only serve runtime implementation details, and potentially reduce some project-reference cycles caused by implementation coupling.

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

The difficulty is not whether the edge can theoretically be removed. The difficulty is whether the removal criterion is reliable. Reference graph tree-shaking cannot be based only on the shape of source-level `import` statements. It needs to analyze the final declaration output: does the `.d.ts` generated from the current `tsconfig` still reference the target declaration provider?

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

Re-exports, public or protected `class` members, generic constraints, conditional types, mapped types, and entry-point forwarding can also bring upstream types into the final declaration output. In other words, reference graph tree-shaking is not as simple as deleting imports that appear to be used only in implementation code. It requires semantic analysis over declaration output.

This is similar to tree-shaking in bundlers: it is a useful optimization technique, but it increases analysis cost. Many bundlers prioritize fast feedback during development instead of running full dead-code elimination by default. Limina makes a similar trade-off at this stage: it currently focuses on one-shot checking and generation, and does not yet implement incremental analysis around declaration output.

If Limina were to run reference graph tree-shaking by default in this model, it would need to handle several additional problems:

- how to efficiently obtain or simulate the final declaration output of each source `tsconfig`;
- how to distinguish TypeScript’s raw `.d.ts` output, framework-checker output, declaration bundler output, and package public API shape;
- how to avoid removing real project references based on stale `.d.ts` output;
- how to reuse previous declaration-output analysis when source files change frequently, instead of rerunning full semantic analysis on every check;
- how to explain removed edges, especially when they still exist in the source import graph.

These problems are solvable, but they are outside the current default reference graph generation path. Limina currently chooses to generate a conservative declaration build graph first: it uses the import records from files owned by the current `tsconfig`, resolves declaration providers with TypeScript, generates `references`, and then checks whether the generated `references` are complete, allowed, and orderable.

This trade-off means the reference graph may be broader than the final declaration output. Some runtime implementation dependencies may participate in generated `references` even if they do not appear in the final `.d.ts`.

The most direct effect is that the dependency scope of incremental declaration builds may be broader. If source code in A resolves to a managed source scope in B, Limina may generate an A -> B declaration build reference. Even if A’s final `.d.ts` does not reference B, changes in B may still affect A’s build ordering and incremental check path. This is a more conservative build graph, not the minimal dependency graph of the final declaration output.

Another effect is that cyclic dependencies may be surfaced earlier. Two source scopes may only call each other at runtime, and their final declarations may not reference each other. But in Limina’s current generated graph, those source imports may still form a generated project-reference cycle. This diagnostic does not necessarily mean that the final `.d.ts` files cyclically reference each other. It means the source-level declaration provider relationship crosses independent `tsconfig` boundaries and cannot be stably ordered as a TypeScript project-reference graph.

Graph checks therefore lean toward exposing source-boundary issues instead of hiding implementation dependencies. Some edges might be removable from the perspective of final declaration output, but if an edge comes from a real import in a managed source scope, Limina treats it as an auditable declaration provider relationship. Users should not fix this by manually deleting the generated project reference. If the edge comes from a real source import, deleting the generated reference only makes the generated graph inconsistent with the source facts.

More reliable fixes include:

- adding explicit public API types to exported values or functions if upstream types are only being leaked through inference;
- moving tightly coupled source scopes into the same source `tsconfig`, so the cycle stays inside a project boundary;
- extracting shared types, protocols, or abstractions into a lower-level `contracts` or `shared` module;
- moving startup, registration, or plugin wiring code to a higher-level entry point;
- if one side is intentionally a declaration boundary, exposing types through explicitly maintained `.d.ts` files and keeping them fresh through the provider’s own build workflow.

These fixes do not make Limina perform reference graph tree-shaking, but they reduce accidental implementation coupling in the reference graph and make the project-reference boundaries required by `tsc -b` clearer.

## How Graph Check Uses This Classification

Generation writes the declaration build graph under `.limina`. Graph check compares that generated graph against the source import facts.

For `references` completeness checks, graph check also uses declaration provider classification:

- If an import resolves to `.d.ts`, `.d.cts`, or `.d.mts`, graph check does not require a source project reference.
- If an import resolves to another source provider, graph check verifies that the expected project reference exists.
- If TypeScript cannot confirm the declaration provider, graph check does not add a project reference from Oxc’s runtime resolution result.
- If an existing project reference cannot be proven by static imports, declaration provider edges, or allow rules, graph check may report an extra project reference.
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

### Oxc can resolve this specifier, but TypeScript cannot

This diagnostic means that a general or runtime resolution view can find a file, but the current checker’s TypeScript declaration provider cannot be determined. Limina does not generate project references from Oxc’s result.

Check package type entries, `tsconfig` module resolution settings, path aliases, and checker configuration first.

### Workspace source import uses package export without a type entry

This diagnostic means that governed workspace source imports enter a package through `package.json#exports`, but the entry does not provide a stable TypeScript type entry or checker source entry.

If this entry is intended for source governance, add a type declaration branch or import through a stable public type entry. If it is only a runtime resource, avoid using it as a type dependency entry for governed source code.

### Missing project reference for workspace import

This diagnostic means that a static import reaches another source provider that needs declaration output, but the current generated declaration configuration does not contain the corresponding project reference.

Usually, verify that both source `tsconfig` files are selected by the checker’s `include`, and then regenerate the graph.

### Extra project reference not proven by static imports

This diagnostic means that a generated declaration project reference cannot be proven by static imports, declaration provider edges, or allow rules.

If the edge comes from a dependency that static analysis cannot see, express it through rules or an explicit edge. Otherwise, remove the extra project reference.

### Generated project reference cycle

This diagnostic means that generated declaration project `references` form a cycle. The cycle may come from mutual imports, implicit edges, or cross-checker declaration provider relationships.

First check whether the source boundaries in the cycle are too fine-grained, whether shared types should be moved lower, whether runtime wiring should be moved upward, or whether one side should become an explicitly maintained declaration boundary.

## Recommended Mental Model

Do not think of Limina as a stronger module resolver. A more accurate model is that Limina uses import records and resolution results as evidence to build a declaration build graph and an architecture check graph for a monorepo.

Each tool is responsible for a different part:

```text
oxc-parser
  -> collect import/export module specifiers from source code

TypeScript resolver
  -> determine declaration providers under the current checker and tsconfig

Oxc resolver
  -> provide general source graph, runtime resolution clues, and diagnostics

Limina graph model
  -> map declaration providers to project references, declaration-file consumption, or diagnostics
```

This boundary avoids several common misunderstandings.

First, a file being resolvable at runtime does not mean the declaration build should reference the `tsconfig` that owns that source file.

Second, resolving to `.d.ts` does not mean Limina will automatically build that declaration file. It only means current project-reference inference does not need to treat that edge as a source-provider project reference.

Third, source-level `import` relationships may be more conservative than the minimal dependency relation of the final `.d.ts`. Limina currently trusts source-level declaration provider relationships by default, rather than tree-shaking the reference graph based on final declaration output.
