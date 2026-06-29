# Import Resolution to Declaration Build Graph

In a monorepo, an `import` is often not just about “where code is loaded from”. For TypeScript declaration builds, the more important question is: where do the type declarations required by this import come from?

Limina’s references inference is built around this question. It does not directly treat “resolved to a source file” as equivalent to “a reference should be generated”. Instead, it first determines the declaration provider for the import under the current checker and tsconfig semantics, and only then decides whether the edge should become a reference, be treated as declaration-file consumption, or be reported as a configuration issue that needs to be fixed.

This article does not cover the quick start, the full configuration reference, or a complete troubleshooting guide. It explains one main path: when one module imports another module, how Limina converts that import into a reviewable declaration build graph relationship.

## Why “which file was resolved” is not enough

Consider a regular import:

```ts
import { createClient } from '@acme/core';
```

It appears to simply use `@acme/core`, but in a monorepo this import may represent several different relationships:

- TypeScript resolves it to `packages/core/dist/index.d.ts`, which means the current module consumes an existing declaration file.
- TypeScript resolves it to `packages/core/src/index.ts`, which means the current module may depend on another source scope to produce declaration output.
- TypeScript resolves it to an external package declaration or a Node built-in module, which usually does not belong to the monorepo’s internal references graph.
- TypeScript cannot resolve the import under the current configuration, which means the type entry, tsconfig configuration, or package boundary may need to be fixed.

Therefore, “it can be resolved” is only a fact, not the final conclusion. For generated declaration references, the real question is:

```text
Under the current checker and tsconfig semantics, who provides the type declarations for this import?
```

Limina calls this result the declaration provider. Limina generates a corresponding reference only when the declaration provider is another Limina-managed source tsconfig scope, and the required type declarations must be obtained through that scope’s declaration output.

## Overall flow

The process can be understood in three steps:

```text
Source file
  -> Collect import/export module specifiers
  -> Determine the TypeScript declaration provider
  -> Map the result to references, declaration-file consumption, or diagnostics
```

The first step only cares about which module specifiers appear in the source code. The second step uses TypeScript’s resolution result under the current checker and tsconfig to determine where the declarations come from. Only the third step enters Limina’s graph model.

This separation avoids a common misunderstanding: Oxc can help Limina collect imports quickly and can provide runtime-resolution clues for diagnostics, but the declaration references generated under `.limina` are not determined by Oxc’s resolution result.

## Step 1: Collect import records

Limina collects import records from source files governed by the current tsconfig scope. This includes static imports, re-exports, dynamic imports, type imports, and certain CommonJS forms that can be statically identified in source code.

At this stage, Limina only records traceable source facts, such as:

```text
Which file
Around which line
Which import/export form
Which module specifier
```

At this point, Limina does not determine whether the import is valid, nor whether references need to be generated.

For Vue files, Limina collects import records from `<script>` content according to the configuration. This is still only import collection. It is not equivalent to Vue compilation and does not replace type checking by the Vue checker.

## Step 2: Determine the declaration provider

After collecting import records, Limina resolves the type entry seen by TypeScript in the current checker and tsconfig context.

Common results can be understood as follows:

| TypeScript type resolution result                      | Limina’s interpretation                              | Generate declaration reference   |
| ------------------------------------------------------ | ---------------------------------------------------- | -------------------------------- |
| `.d.ts` / `.d.cts` / `.d.mts`                          | Existing declaration file                            | No                               |
| Source file within the current scope                   | Owned by the current scope                           | No                               |
| Source file in another Limina source scope             | Requires another scope to produce declaration output | Yes                              |
| External library declaration or external package entry | External dependency                                  | No                               |
| Unresolved                                             | Declaration provider cannot be confirmed             | No; reported through diagnostics |

The most easily misunderstood case is “existing declaration file”. This includes not only declaration artifacts under `dist`, but also user-maintained `.d.ts` files. As long as TypeScript resolves to `.d.ts`, `.d.cts`, or `.d.mts` under the current semantics, Limina will not infer a source tsconfig reference from it.

Suppose a package exposes its entry like this:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./src/index.ts"
    }
  }
}
```

If TypeScript resolves to `dist/index.d.ts` under the current tsconfig semantics, this edge is a declaration-file consumption relationship. Limina should not infer a reference to the tsconfig that owns `src/index.ts` just to make the source graph look more complete.

Conversely, if TypeScript resolves to a source file in another scope, for example:

```text
packages/core/src/index.ts
```

and that file is governed by another Limina source tsconfig, then the edge enters references inference.

## Step 3: Generate references from source providers

When the declaration provider is a source file, Limina continues by determining which source tsconfig scope owns that file.

If the target source file belongs to the current scope, no reference is needed. If it belongs to another scope, Limina maps the target source tsconfig to the corresponding generated `.dts.json`, and then adds that `.dts.json` to the `references` of the current generated declaration config.

The simplified decision rules are:

```text
TypeScript resolves to a declaration file
  -> Declaration-file consumption
  -> Do not generate references

TypeScript resolves to source within the current scope
  -> Internal dependency of the current scope
  -> Do not generate references

TypeScript resolves to source in another scope
  -> Source-provider dependency
  -> Generate references to the target .dts.json

TypeScript cannot confirm the declaration provider
  -> Do not generate references
  -> Emit corresponding diagnostics or expose the issue in graph checks
```

If a source-provider edge crosses checker boundaries, Limina records the declaration-provider edge and checks whether that edge can be consumed by the consumer checker in the generated declaration graph. This check only applies to Limina’s generated declaration graph. It does not mean Limina can replace the type-checking capabilities of TypeScript, Vue, Svelte, or any other checker.

## How graph checks use this classification

Graph generation is responsible for writing the declaration build graph under `.limina`. Graph checks compare source import facts against the current graph and verify whether they are consistent.

In reference completeness checks, graph checks also use declaration-provider classification:

- If an import resolves to `.d.ts`, `.d.cts`, or `.d.mts`, graph checks will not require a source project reference.
- If an import resolves to another source provider, graph checks verify whether the expected reference exists.
- If TypeScript cannot confirm the declaration provider, graph checks will not add a reference based on Oxc’s runtime-resolution result.
- If an existing reference cannot be proven by static imports, declaration-provider edges, or allow rules, graph checks may report it as an extra reference.

However, graph checks are not limited to declaration providers. Checks related to package entries, runtime resolution, dependency declarations, and boundary rules may still use other resolution results as evidence. This article focuses only on the main path of references inference and reference completeness checks.

## Common cases

### Consuming an existing declaration file

If a workspace package exposes a declaration file through `exports.types`:

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

When another package imports `@acme/core`, and TypeScript resolves to `dist/index.d.ts` under the current tsconfig semantics, Limina will not generate a reference to the source tsconfig of `@acme/core`.

This does not mean Limina will build or refresh `dist/index.d.ts`. If a package chooses to consume build artifacts, it still needs to maintain those artifacts through its own build process, watch task, CI, or release process.

### Depending on another source scope

If TypeScript resolves to a source file governed by another source scope:

```text
packages/core/src/index.ts
```

and that file needs to provide type declarations through the target tsconfig’s declaration output, Limina makes the current generated declaration config reference the target generated `.dts.json`.

This reference represents a declaration build dependency. It is not a package publishing relationship, nor a runtime bundling relationship.

### Using hand-written declaration files

If TypeScript resolves to a hand-written declaration file inside a source directory:

```text
packages/core/src/index.d.ts
```

Limina treats it as an existing declaration file. Even if the file is under `src`, Limina will not infer a source tsconfig reference from it.

## When Oxc appears in diagnostics

Oxc does not participate in references generation, but it may still appear in diagnostics. This is usually used to explain that a file can be found from a runtime-resolution perspective, while TypeScript under the current checker and tsconfig has not confirmed an available declaration provider.

A typical diagnostic is:

```text
Oxc can resolve this specifier, but TypeScript cannot
```

This diagnostic does not mean “Oxc resolved it incorrectly”, nor does it mean “Limina should add a reference using the Oxc result”. It only indicates that runtime resolution and type resolution are not aligned.

Common investigation directions include:

- Whether `moduleResolution` matches the current `package.json#exports` form;
- Whether `exports.types` or type conditions exist;
- Whether `paths`, `baseUrl`, or `customConditions` are consistent with the current checker;
- Whether the current import bypasses the package’s public type entry.

The usual fix is to provide the missing type entry or adjust the tsconfig configuration, not to make Limina guess a reference.

## The role of `implicitRefs`

Static import analysis can only prove edges that are visible in source code. Dependencies that come from generated code, framework conventions, runtime manifests, or plugin mechanisms have no direct import/export record in source code; Limina does not guess them automatically, and the user supplements such edges explicitly through `liminaOptions.implicitRefs` when needed.

For the full meaning of `implicitRefs`, how to configure it, and why it does not replace declaration-provider inference, see [Why import Cannot Directly Equal references](./why-import-is-not-references.md).

## How to understand common diagnostics

### Oxc can resolve this specifier, but TypeScript cannot

This diagnostic means that a general or runtime-resolution perspective can find a file, but the current checker’s TypeScript declaration provider cannot be determined. Limina will not generate references based on the Oxc result.

First check type conditions in the package entry, the tsconfig module resolution configuration, path aliases, and checker configuration.

### Workspace source import uses package export without a type entry

This diagnostic means that governed workspace source code imports through a `package.json#exports` package entry, but that entry does not provide a stable TypeScript type entry or checker source entry.

If this is an entry intended for source governance, consider adding a type declaration branch or importing from a stable public type entry. If it is only a runtime resource, avoid using it as a type dependency entry for governed source code.

### Missing project reference for workspace import

This diagnostic means that a static import reaches another source provider that requires declaration output, but the current generated declaration config does not contain the corresponding reference.

Usually, both source tsconfigs should first be confirmed as selected by the checker `include`, and then the graph should be regenerated.

### Extra project reference not proven by static imports

This diagnostic means that a generated declaration reference cannot be proven by static imports, declaration-provider edges, or allow rules.

If the edge truly comes from a dependency invisible to static analysis, it should be expressed through rules or an explicit supplemental edge. Otherwise, the extra reference should be removed.

## Recommended mental model

Do not treat Limina as a stronger module resolver. A more accurate description is that Limina uses import records and resolution results as evidence to build the declaration build graph and architecture check graph for a monorepo.

Different tools are responsible for different parts:

```text
oxc-parser
  -> Quickly collect import/export module specifiers from source code

TypeScript resolver
  -> Determine the declaration provider under the current checker and tsconfig

Oxc resolver
  -> Provide regular source graph information, runtime-resolution clues, and diagnostic hints

Limina graph model
  -> Map declaration providers to references, declaration-file consumption, or diagnostics
```

This boundary avoids two common misunderstandings.

First, the fact that runtime resolution can reach a source file does not mean the declaration build should reference the tsconfig that owns that source file.

Second, resolving to `.d.ts` does not mean Limina will automatically build that declaration file. It only means the current references inference does not need to treat that edge as a source-provider reference.
