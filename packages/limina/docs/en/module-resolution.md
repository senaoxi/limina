# Why Doesn't Limina Use an Existing Module Resolver?

Short answer: Limina does use existing resolvers, but it does not delegate the whole decision to any single resolver.

Module resolution is only one part of what Limina has to prove. A resolver can answer "where does this specifier point from this file?" Limina also has to answer "what does that resolved file mean for this monorepo?" Is it source or an artifact? Which package owns it? Which `tsconfig*.dts.json` owns it? Does the import require a TypeScript project reference? Is the import authorized by the nearest `package.json`? Does a `workspace:*` import that resolves to `dist` require an Nx build edge?

Those are architecture-governance questions, not just file lookup questions.

## What Limina Needs From Resolution

For Limina, a resolved import is evidence. It is used to prove boundaries that should remain stable in CI:

- the import must be discovered statically from source;
- the specifier must resolve under the active checker profile;
- the resolved file must map to a package owner;
- source-owned imports must match TypeScript project references;
- artifact-owned imports must match build dependencies where relevant;
- `#imports` must stay inside the nearest package owner;
- diagnostics must point back to the exact import that caused the edge.

That last point is important. Limina should not "fix up" a resolver result just to make the graph convenient. If `@acme/core` resolves to `packages/core/dist/index.d.ts`, Limina treats that as an artifact result. It does not silently walk source maps or guess that the real source was `packages/core/src/index.ts`, because doing so would hide the exact contract that the package export exposes.

## Why Node's Resolver Is Not Enough

Node's native resolvers, such as `require.resolve` and `import.meta.resolve`, are excellent at answering a runtime question: "what would Node load?"

Limina asks a different question: "what should this TypeScript monorepo prove before it builds and publishes?"

Node does not know about TypeScript `paths`, `baseUrl`, `rootDirs`, `moduleSuffixes`, `allowArbitraryExtensions`, declaration-only projects, Vue/Svelte checker extensions, or Limina's package-owner model. It also cannot tell Limina whether a resolved file is governed source, generated declaration output, or a publish artifact that should create an Nx build dependency.

Node resolution is therefore useful as a mental model for package `exports` and `imports`, but it cannot be the whole source of truth for Limina.

## Why TypeScript's Resolver Is Not Enough

TypeScript's module resolver is the closest match for many Limina checks. Limina must respect the same `compilerOptions` that the checker uses, especially path aliases, package imports, package exports, custom conditions, and TypeScript-only resolution behavior.

But TypeScript resolution is type-oriented. That is exactly what makes it valuable, and also why it is not enough by itself.

For example, TypeScript may resolve a public package export to `dist/index.d.ts`. That is correct for typechecking. But Limina still needs to know what this means structurally:

- if it is built declaration output, a project reference may not be required;
- if it is checker-owned source, a project reference is required;
- if a `workspace:*` import reaches `dist`, an Nx build edge may be required;
- if TypeScript can only reach runtime JavaScript for a public export, the export may be unsafe for declaration checking.

TypeScript also works within TypeScript program boundaries. Limina has to connect multiple declaration leaves, framework checker entries, package owners, source files, package manifests, and built package outputs. It uses TypeScript resolution where that is the right evidence, but the final decision belongs to Limina's graph model.

## Why Bundler Resolvers Are Not Enough

Bundlers are intentionally flexible. Vite, Webpack, Rollup, esbuild, and framework-specific build tools may support plugins, virtual modules, asset suffixes, loaders, CSS imports, aliases, and environment-specific condition choices.

That flexibility is useful for building applications, but it is a poor single source of truth for architecture governance.

A bundler resolver is usually tied to one build pipeline. A monorepo may have several pipelines: Node tools, browser packages, test code, Vue/Svelte files, library packages, and publishable `dist` outputs. A bundler plugin may also make an import work at build time even though it is not a valid package dependency, not covered by a checker entry, or not safe for another runtime.

Limina wants the opposite property: a small, reviewable set of facts that can be checked consistently before the build. Bundler behavior can inform a condition domain, but Limina should not let a build plugin become the only proof of a cross-package dependency.

## Why Knip's Resolver Is Not Limina's Resolver

Limina uses Knip where Knip's model is a good fit: unused workspace dependencies and strict-mode source reachability. Knip is excellent at building broad dependency graphs for "is this file, export, or dependency still reachable?" questions.

Limina's core resolver has a narrower and stricter job. It is not trying to infer every possible entry point or reverse-map a build artifact back to source. It is trying to prove that each statically discovered import has the right package authority, source owner, project reference, runtime boundary, and build edge.

That difference matters. A dead-code tool may reasonably say, "this artifact probably came from that source file, so count the source as used." Limina should usually say, "the resolver reached an artifact, so this edge is an artifact edge." That preserves the contract the repository actually exposes through `package.json#exports`.

## What Limina Actually Does

Limina combines resolvers instead of replacing them with a single one:

- It statically collects import records from source files, including ESM, export-from, dynamic imports with literal specifiers, TypeScript import types, CommonJS `require`, `require.resolve`, `import = require`, Vue inline scripts, and supported comment pragmas.
- It prefers TypeScript/checker resolution when the active compiler options require TypeScript-only behavior.
- It resolves direct relative files, `paths`, and `baseUrl` in a controlled way.
- It uses Oxc resolver for package-style resolution with extension aliases, package `exports` / `imports`, symlink behavior, and condition names derived from the active compiler options.
- It falls back to checker resolution where Oxc is not the right authority.
- It maps the resolved file into Limina concepts: package owner, source owner, declaration project, artifact directory, graph rule, and Nx build dependency.

The resolver result is therefore not the end of the decision. It is the evidence Limina uses to decide which architectural rule applies.

## The Practical Rule

Think of resolution in Limina as a chain:

```text
source import
  -> static import record
  -> resolver result under the active checker profile
  -> package/source/artifact ownership
  -> reference, dependency, boundary, or build-edge rule
  -> diagnostic pointing back to the import
```

Existing resolvers are very good at the middle step. Limina exists because the steps before and after it matter just as much.

That is why Limina does not use "the Node resolver", "the TypeScript resolver", "the bundler resolver", or "the Knip resolver" as the whole answer. It uses resolver results as facts, then applies the monorepo rules that make those facts safe to build, review, and publish.
