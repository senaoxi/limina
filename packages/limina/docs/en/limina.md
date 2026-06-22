# What is Limina

Limina is an architecture governance tool for TypeScript monorepos.

Its adoption path is explicit: start with incremental type builds, then progressively enable architecture governance. Teams can first generate reusable type-build configuration from existing TypeScript configuration and source dependency relationships, giving the repository a stable build entry point. The same set of project facts can then be extended to dependency-graph governance, source-boundary checks, check coverage verification, and release checks.

For small projects, running TypeScript type checks directly is often enough. In large monorepos, however, project relationships become more complex:

- Packages need to access each other through explicit dependency declarations.
- TypeScript project references need to stay consistent with actual source imports.
- TypeScript, Vue, Svelte, documentation, scripts, and test code may require different checker workflows.
- Packages published to npm also need correct entry points, type declarations, dependency declarations, and published contents.

This information is usually spread across `tsconfig`, `package.json`, source imports, checker configuration, and release artifacts. As the repository grows, these sources can gradually drift away from the real project state.

Limina does not replace these tools. It turns the project relationships they depend on into checks that can be generated, validated, and run.

## Start with incremental builds

When adopting Limina for the first time, the recommended starting point is type builds, not the full set of governance rules.

Limina reads existing TypeScript configuration and source dependency relationships, generates reusable type-build configuration, and derives a reliable build order. Teams do not need to substantially reshape the repository structure to get a runnable, incremental build entry point suitable for local development and CI.

This path is useful because:

- It provides a concrete engineering benefit before introducing the full rule set.
- Build relationships are derived from source configuration and real imports, reducing the long-term cost of manually maintaining project references.
- After the type-build path is stable, teams can progressively enable dependency-graph governance, source-boundary checks, and check coverage verification.

For large TypeScript monorepos, this is often a lower-cost adoption path with benefits that are easier to validate.

## Then enable architecture governance progressively

After the incremental build path is stable, teams can enable additional checks to make repository constraints explicit.

Limina’s core governance capabilities include the following areas.

**Govern the dependency graph.** Check whether actual source imports, TypeScript project references, and workspace dependency declarations are consistent, and detect missing references, redundant references, invalid access, and undeclared dependencies.

**Protect source boundaries.** Detect cross-package relative imports, unauthorized imports, missing dependency declarations, and source ownership issues, preventing modules from bypassing intended entry points to access internal implementation details.

**Verify check coverage.** Find files that are not covered by checks, covered more than once, or covered by a check scope that does not match the source scope, reducing quality blind spots.

**Compose check workflows.** Builds, dependency-graph checks, source-boundary checks, and check coverage verification can run as independent tasks or be composed into local development, CI, or prerelease workflows. Tasks that can run concurrently are executed concurrently to reduce waiting time.

**Add release checks.** Before release, validate package metadata, type entry points, build output, and packed package contents to catch issues that may affect consumers.

These capabilities do not need to be enabled all at once. Teams can adopt them in stages: stabilize builds first, add key boundaries to change validation, and then connect release checks to the release workflow.

## Suitable projects

Limina is better suited to TypeScript monorepos that have reached a certain level of engineering complexity, especially when the project:

- Uses pnpm workspaces to manage multiple packages.
- Already uses TypeScript project references, or plans to adopt incremental type builds.
- Wants to reduce the cost of manually writing and synchronizing project references.
- Needs to constrain access boundaries between production code, tooling code, test code, browser code, and Node code.
- Contains TypeScript, Vue, Svelte, or other code that requires specialized checkers.
- Publishes npm packages and wants to validate the actual published artifacts before release.

For smaller projects with simple package boundaries and no release artifacts to validate, TypeScript and existing check tools may already be sufficient.

## Non-goals

Limina is not a bundler, a test framework, or a publishing tool. It does not replace TypeScript or framework-specific checkers.

It runs alongside these tools and verifies that the monorepo structure they depend on remains reliable: whether source relationships are valid, whether the type-build graph is consistent, whether check coverage is complete, and whether release artifacts match expectations.

In other words, Limina is not concerned with how application code is written. It focuses on whether the engineering constraints in a large repository remain clear, reviewable, and maintainable.

## How teams use it after adoption

After adopting Limina, teams can place different checks at different stages.

During local development, incremental builds can quickly verify whether type-build relationships still work.

In CI, dependency relationships, source boundaries, and check coverage can be checked to prevent architecture drift from entering the main branch.

Before release, package metadata, type entry points, build output, and packed package contents can be validated to reduce issues that would otherwise be discovered after publishing.

The practical result is that when a change breaks a project relationship, the failure points more directly to the source of the problem. Teams can decide whether the change needs a project reference, a dependency declaration, a source-boundary adjustment, additional check coverage, or a release artifact fix.

## Next steps

Read [Why Limina](./why.md) to understand the motivation, or go directly to [Getting Started](./getting-started.md) to begin adoption.
