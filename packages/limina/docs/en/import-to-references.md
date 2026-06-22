# From `import` to `references`: How Limina Generates Type Graphs

TypeScript `references` are often confusing for monorepo users: if the source code already `import`s another package, and the dependency has already been declared in `package.json`, why does the project reference still need to be written again in `tsconfig.json`?

Intuitively, it may seem that the compiler could derive this graph directly from package dependencies and source imports. But the real issue is not **whether imports can be scanned**, but rather:

> Who is qualified to define which TypeScript project a file belongs to?
> Who can guarantee that an import relationship should become an upstream reference for declaration builds?
> Who handles inference failures, semantic inconsistencies, and mismatches between runtime entry points and source entry points?

Limina can infer references not because the problem itself is simple, nor because module resolvers inherently understand TypeScript project references. Rather, Limina narrows the problem to a **constrained, checkable, fallible, and correctable** repository scope.

It does not ask TypeScript to guess the entire monorepo.
It requires users to first declare source type boundaries, and then generates a verifiable declaration build graph only within those boundaries.

## `references` Are Not an Ordinary Dependency List

`package.json` dependencies, source imports, package exports, tsconfig file sets, and TypeScript project references are related, but they are not the same thing.

```text
package.json says: I depend on this package
source import says: I use this entry point
exports says: this entry point resolves to source code or build output
tsconfig says: which files belong to this type environment
references says: whose output should be trusted first during declaration builds
```

`references` affect how TypeScript splits compilation units, reads upstream declarations, schedules build order, and performs incremental builds. They are neither an import-scan cache nor a mirror of `dependencies`.

Therefore, native reference inference is not merely **eliminating a bit of JSON boilerplate**. It changes how the compiler and language service understand the entire repository.

This is also the fundamental reason why the TypeScript community has discussed similar directions for a long time, yet has found them difficult to land directly: [infer project references from monorepo structure or tooling](https://github.com/microsoft/TypeScript/issues/25376).

## `package.json` Dependencies Are Not Project References

Suppose a workspace package declares the following:

```json [packages/core/package.json]
{
  "name": "@acme/core",
  "exports": {
    ".": "./src/index.ts",
    "./runtime": {
      "types": "./dist/runtime.d.ts",
      "import": "./dist/runtime.js"
    }
  }
}
```

Another package imports it:

```ts
import { createClient } from '@acme/core';
```

If this entry point resolves to the source code of `core`, it expresses source-level collaboration. For declaration builds, the current project may need to reference the corresponding declaration build config for `core`.

But if the import is:

```ts
import { renderRuntime } from '@acme/core/runtime';
```

and that entry point resolves to `dist/runtime.d.ts` and `dist/runtime.js`, then it is closer to consuming an upstream build artifact rather than referencing an upstream source project.

Within the same workspace dependency, different entry points may express different relationships:

| Import Target            | Closer Semantic Meaning                                             |
| ------------------------ | ------------------------------------------------------------------- |
| Workspace source file    | Source-level type collaboration; may require generating a reference |
| Workspace build artifact | Artifact consumption; may appear as a scoped artifact edge          |
| External package entry   | Ordinary package dependency                                         |
| Node built-in module     | Runtime capability dependency                                       |
| Private internal path    | Possible package-boundary bypass                                    |

If TypeScript only looks at `package.json`, it is difficult to safely determine which entry point should become a project reference. It must also deal with multiple tsconfig files, conditional exports, framework files, editor modes, and watch mode.

## TypeScript Needs General Semantics; Limina Can Require the Repository to Be Explicit First

TypeScript is a language and compiler. Its default behavior must accommodate a vast number of existing projects, and it cannot casually assume that one particular monorepo structure is the standard answer.

For example, a package may contain all of the following:

```text
packages/app/
  tsconfig.json
  tsconfig.lib.json
  tsconfig.test.json
  tsconfig.client.json
  tsconfig.server.json
```

Which configurations represent production source code? Which are only for tests? Can browser code and server code reference each other? Which configuration should participate in declaration builds? These are not questions that TypeScript can safely answer merely by looking at `package.json` or imports.

Limina has a different position.

Limina is not adding a set of implicit rules to the entire TypeScript ecosystem. Instead, within a repository that has opted into Limina, it requires users to first declare the entry points for source governance:

```js [limina.config.mjs]
export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        include: ['packages/*/tsconfig.json'],
      },
    },
  },
});
```

This configuration does not ask Limina to blindly scan and guess the entire repository. Instead, it tells Limina:

> These `tsconfig.json` files are the source check entries.

Starting from these entry points, Limina follows solution references to source configs such as `tsconfig.lib.json`, `tsconfig.test.json`, or `tsconfig.client.json`. It then resolves file sets, compiler options, checker capabilities, and actual imports, and generates the corresponding declaration build configs.

## Limina Separates Type-Checking Modules from Declaration Build Configs

The core prerequisite that allows Limina to infer references is that it fully separates two concepts:

| Module                   | Location                                  | Maintained By       | Purpose                                                                            |
| ------------------------ | ----------------------------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| Type-checking module     | `tsconfig*.json` in user source code      | User-maintained     | Describes which source files belong to the current type-checking unit              |
| Declaration build config | `.limina/tsconfig/.../tsconfig*.dts.json` | Generated by Limina | Describes how declaration builds should output, reference, and build incrementally |

Users maintain source-level type-checking modules.
Limina generates declaration build configs under `.limina/`.

The two have different responsibilities, while preserving the same file set:

```text
source type configuration
  -> source files it covers
  -> declaration build config
```

For example:

```text
packages/core/tsconfig.lib.json
  -> packages/core/src/**/*.ts
  -> .limina/tsconfig/checkers/tsc/projects/packages/core/tsconfig.lib.dts.json
```

As a result, Limina does not require users to handwrite native TypeScript `references` in leaf source configurations. Source tsconfig files are only responsible for describing **which files I cover and how these files are type-checked**. The `references`, `outDir`, `declaration`, `emitDeclarationOnly`, `tsBuildInfoFile`, and related settings required for declaration builds are generated by Limina under `.limina/`.

This avoids a common problem: in ordinary source tsconfig files, some configurations contain `references` while others do not, making it hard for developers to tell whether those references represent a TypeScript solution graph or implicit edges patched in by tooling.

In Limina’s model:

> Native TypeScript `references` should be reserved for solution configs.
> Leaf source configurations should not carry the responsibility of implicit edge completion.

## Oxc Resolver Is Not Responsible for Understanding `references`

Limina can use Oxc Resolver to infer refs, but not because Oxc Resolver inherently understands TypeScript project references.

Oxc Resolver solves a lower-level problem here:

```text
import specifier -> resolved source file
```

The actual ref inference is performed by Limina itself:

```text
resolved source file -> owning source config -> declaration build config
```

In other words, Limina decomposes the problem into three stages:

```text
import specifier
  -> resolved source file
  -> owning source config
  -> declaration build config
```

Oxc Resolver only participates in the first stage.
The second and third stages come from Limina’s project model.

This is why Oxc Resolver can be used for ref inference: it does not need to know what TypeScript project references are. It only needs to resolve imports quickly and completely to real files. As long as the resolved file belongs to one of the source configs selected by Limina, Limina can find its corresponding declaration build config.

## Bare Import Inference Is Reduced in Dimensionality

In an ordinary TypeScript context, bare imports are complex:

```ts
import { createClient } from '@acme/core';
```

They may involve:

- `package.json#exports`
- `package.json#imports`
- `compilerOptions.paths`
- `baseUrl`
- `customConditions`
- `moduleResolution`
- package-manager dependency protocols
- symlinks
- package-manager layouts
- framework file extensions such as Vue / Svelte

If TypeScript were to natively infer references, it would have to answer:

> Which TypeScript project should `@acme/core` correspond to?

That is a general semantic problem.

In Limina, however, the problem is reduced to:

> Does the file resolved from `@acme/core` belong to a source config selected by Limina?

If the resolution result is:

```text
@acme/core
  -> packages/core/src/index.ts
```

and that file belongs to:

```text
packages/core/tsconfig.lib.json
```

while Limina has already generated the following for that source config:

```text
.limina/tsconfig/checkers/tsc/projects/packages/core/tsconfig.lib.dts.json
```

then the current project can generate a reference:

```text
current declaration build config
  -> core declaration build config
```

This edge is not guessed from the package name, nor copied from `dependencies`. It is inferred from the actual import target and file ownership.

## Limina Infers **Proven Source Relationships**

When Limina infers relationships, the core evidence is not:

```text
two packages are in the same workspace
```

nor:

```text
a dependency is declared in package.json
```

but rather:

```text
an import in a checked source file actually resolves to a file covered by another source config
```

The process can be understood as follows:

```text
user declares source config entry points
  │
  ▼
checker resolves the file set covered by each entry point
  │
  ▼
Limina establishes source file -> owning source config
  │
  ▼
Limina scans import/export/import()/require() in source code
  │
  ▼
resolver resolves each specifier to a concrete file
  │
  ▼
if the target file belongs to another source config selected by Limina
  │
  ▼
add the declaration build config for the target source config to references
```

Therefore, Limina’s inference is more conservative than **patching references from dependency names**. It requires that:

1. The import actually exists.
2. The import can be resolved to a concrete file.
3. The target file is inside Limina's check scope.
4. The target file can be assigned to a unique source config.
5. The current source config and the target source config are different.
6. The target source config has a corresponding declaration build config.
7. The edge does not violate graph rules.

Only when these conditions hold should Limina generate a reference.

## Edges Invisible to Static Analysis Should Not Pretend to Be Automatically Inferred

Not all real dependencies can be discovered through static import analysis.

For example:

- imports only appear in generated files;
- route tables, plugin tables, or command tables are generated by build plugins;
- modules are registered at runtime through manifests;
- framework macros or compiler plugins create dependencies only after transformation;
- virtual modules are mapped to real source files during build;
- DI containers connect modules through string tokens.

These edges are real, but they cannot be proven by the static import graph.

Such relationships should not be written into ordinary source tsconfig files as TypeScript `references`. Doing so would mix native TypeScript project references with Limina’s implicit edge-completion semantics.

A better approach is to use a Limina-specific field:

```json [packages/app/tsconfig.lib.json]
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],

  "liminaOptions": {
    "graphRules": ["app"],
    "implicitRefs": [
      {
        "path": "../core/tsconfig.lib.json",
        "reason": "The app route manifest is generated by a build plugin. Once generated, it loads core, but there is no static import in the source code."
      }
    ]
  }
}
```

The meaning of `implicitRefs` is:

> This is an implicitly dependent edge explicitly declared by the user.
> **implicit** means that it is invisible in the static source import graph, not that Limina secretly adds it.

It only participates in the refs graph generated by Limina and does not change TypeScript’s native interpretation of the source tsconfig.

## `implicitRefs` Are Not a Whitelist

`implicitRefs` only supplements source edges that **cannot be proven by static analysis but truly exist in engineering reality**. It should not bypass architectural rules.

If a project is marked as browser:

```json
{
  "liminaOptions": {
    "graphRules": ["browser"],
    "implicitRefs": [
      {
        "path": "../node-runtime/tsconfig.lib.json",
        "reason": "Loaded at runtime through a plugin."
      }
    ]
  }
}
```

and the `browser` rule forbids references to `node-runtime`, this supplemented edge should still fail.

That is:

```text
automatically inferred edges + implicitRefs supplemented edges
  -> jointly enter the generated project-reference graph
  -> jointly undergo checks such as deny.refs / deny.deps / condition domains
```

`implicitRefs` does not mean **allowing violations**. It means **declaring facts that static analysis cannot see**.
Whether such facts are allowed to exist is still determined by graph rules.

## Limina Can Fail; That Is Precisely Why It Can Do This

If compiler-level default inference guesses incorrectly, the cost is high. Editors, watch mode, build caches, and a large number of existing projects would all be affected.

As an architectural governance tool, Limina can choose a different approach: when it encounters uncertainty, inconsistency, or boundary violations, it fails directly and asks the user to fix the structure.

None of the following cases should be silently guessed over:

| Symptom                                                      | Limina’s Likely Judgment                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| Entry point is not selected by `checker.include`             | This is not a declared source check entry point              |
| Import cannot be resolved                                    | The entry point, path, or build convention needs correction  |
| Import resolves to an internal file of another package       | Package boundary may have been bypassed                      |
| Import resolves to a build artifact                          | More like artifact consumption than a source reference       |
| One file is covered by multiple source configs               | File ownership is ambiguous                                  |
| One configuration covers source files from multiple packages | Type-checking module boundary is too coarse                  |
| Browser entry imports Node capability                        | Runtime boundary is broken                                   |
| Generated graph is inconsistent with package exports         | Source relationships are not honored by package entry points |
| Source graph passes but the published package is broken      | Artifacts do not honor relationships expressed in source     |
| Dynamic dependency does not declare `implicitRefs`           | The static graph cannot prove this edge                      |

This is also the difference in responsibility between Limina and TypeScript.

TypeScript must serve all projects stably.
Limina can say to a repository:

> Your structure is not clear enough yet; I cannot safely generate this relationship.

This kind of failure is not a defect. It is the value of a governance tool.

## Limina Does Not Replace TypeScript; It Prepares the Graph TypeScript Needs

Limina does not change TypeScript’s language semantics. What it does is organize, outside the repository’s source layer, a relationship graph that TypeScript declaration builds can execute, and continuously verifies during generation and checking that this graph comes from real source relationships.

| What Users Maintain                       | What Limina Handles                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| Source `tsconfig.json` entries            | Declares where source governance starts                                      |
| Referenced source `tsconfig*.json` files  | Describes concrete type-checking modules and file ownership                  |
| `limina.config.mjs#checkers`              | Maps entry configs to checker capabilities                                   |
| `package.json#exports`                    | Verifies public entry points and runtime boundaries                          |
| Source imports                            | Infers relationships between checked source projects                         |
| `liminaOptions.implicitRefs`              | Supplements real edges invisible to static analysis                          |
| Generated tsconfig files under `.limina/` | Organizes declaration-build output, references, and entry points             |
| Package build artifacts                   | Checks from the consumer’s perspective whether the published result is valid |

In other words, Limina does not ask users to trust some magical automatic inference. It first requires the repository to declare its boundaries clearly, and then performs inference only within those boundaries for relationships that can be proven by source code, resolution results, and package configuration.

## When This Inference Should Be Trusted

When a repository satisfies the following conditions, Limina’s reference inference is usually a reliable engineering benefit:

- workspace packages have clear `package.json#name` values;
- source configs have well-defined responsibilities;
- each checked source file belongs to exactly one source config;
- cross-package access generally goes through package names and public exports;
- TypeScript, Vue, Svelte, and similar entry points all have corresponding checkers;
- build artifacts and package exports honor source relationships;
- real edges invisible to static analysis are explicitly declared through `implicitRefs`;
- CI runs Limina, ensuring graph checks, source checks, proof checks, and checker builds all pass together.

If a repository still heavily depends on cross-package relative paths, mixed tsconfig usage, unstable public entry points, or inconsistencies between build artifacts and source entry points, Limina will not automatically make it healthy. It is more likely to first expose a batch of structural issues.

That process is not an integration failure. It turns **relationships maintained by convention and experience** into facts that the repository can check.

## A More Accurate Conclusion

Limina can infer references not because TypeScript missed a simple feature.

More accurately:

> It is difficult for TypeScript to make monorepo reference inference a default language capability;
> Limina, however, can make it an engineering-governance capability within a repository.

TypeScript must design stable semantics for the entire ecosystem.
Limina can require a repository to first declare source config entry points, checker capabilities, package boundaries, and runtime rules.

Oxc Resolver provides fast and complete module-resolution capability; Limina provides file ownership, declaration build config mapping, and refs-graph generation. Only by combining the two can Limina turn the following chain:

```text
import specifier
  -> resolved source file
  -> owning source config
  -> declaration build config
```

into a generated references graph that is checkable, buildable, fallible, and correctable after failure.

Therefore, Limina’s advantage is not that it guesses the entire monorepo on TypeScript’s behalf, but that:

> Within the check scope already declared by the user, it converts real source relationships and explicitly declared implicit edges into a references graph that TypeScript declaration builds can consume.
