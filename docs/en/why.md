# Why Limina

A TypeScript monorepo often starts simple: one root `tsconfig.json`, a few packages, and a type-check script.

At that stage, a file's package, dependencies, checking config, and place in the build order are usually easy to identify.

As the repository grows, one package may contain browser code, Node code, shared modules, tests, tools, build configuration, and published entries. These source groups often need different type environments and separate `tsconfig` files.

With multiple configs, developers also have to maintain their TypeScript project references. Changes to source dependencies that require declarations can affect build order; runtime boundaries and check coverage need attention too.

Limina reads source configs and checker-derived dependency facts, generates supported declaration references, and checks configured ownership and dependency rules.

## One Package Can Contain Multiple Engineering Boundaries

In a simple project, a package can usually be understood as a single boundary: one package, one source set, one type-check entry.

In a complex TypeScript monorepo, a package may already contain multiple boundaries. For example, a VitePress-related package may include:

- client runtime code for the browser;
- server-side or build-time code for Node;
- shared modules that may be reused by both browser and Node code;
- test code;
- build scripts and tool scripts;
- multiple public entries exposed to consumers.

Files in the same package may need separate type environments. For example, a project may require browser code to avoid Node built-ins, shared modules to remain independent of a runtime, and tests and tools to stay outside production build relationships.

Separate `tsconfig` files express these environments; their dependency relationships still need to be maintained.

## Project References Improve Builds, but Add Maintenance Cost

TypeScript project references are suitable for large repositories. They let type builds run in dependency order and reuse incremental build results.

But project references assume that the reference graph is accurate.

This applies to cross-package access and to [different source scopes within one package](#one-package-can-contain-multiple-engineering-boundaries). A relative import within the same package may look like this:

```ts
import { resolveThemeConfig } from '../shared/theme';
```

A reference is needed only when the importer and imported file belong to different managed configs and the checker's semantic evidence requires a source declaration provider. Consuming an existing declaration artifact or observing a framework scheduling dependency does not by itself require that reference.

When maintaining references by hand, developers must check config ownership, add or remove references as dependencies change, and review any runtime-boundary violations.

As configs multiply, keeping declaration dependencies and build references aligned takes more work. This alignment supports build ordering and incremental reuse; source coverage and runtime boundaries still need separate checks.

## Limina Starts Governance from the Project Reference Graph

Limina uses TypeScript project references for supported declaration builds.

Teams still maintain their source configs and package boundaries. Limina reads those configs and checker-derived dependency facts, generates declaration build relations for build-capable owners, and checks those relations against configured governance rules. Astro and Svelte owners run per leaf without declaration projection; artifact consumption is exported separately and does not establish build-task ordering.

Limina recalculates generated declaration references from the current configs and dependency facts, reducing manual reference maintenance. Local commands and CI can check the resulting graph.

When source structure changes, Limina checks declaration-provider requirements, configured runtime rules, source ownership, and check coverage. The generated references let supported checkers run their declaration builds.

The following scenarios use these checks. Source ownership, declaration references, framework scheduling, and artifact consumption remain separate facts; they do not all become TypeScript `references`.

## Typical Scenario: One Package Supports Multiple Runtimes

Suppose one package contains three source groups: `client`, `node`, and `shared`:

```txt
packages/example/
  src/client/
  src/node/
  src/shared/
```

They usually need different type environments:

```txt
src/client/tsconfig.json   # browser runtime
src/node/tsconfig.json     # Node runtime
src/shared/tsconfig.json   # shared modules
```

For this example, suppose `client` may depend on `shared` but not `node`, `shared` must remain independent of a runtime, and `node` may use Node types and built-ins.

These requirements need source scopes and configured graph rules. Cross-config imports also need the declaration-reference review described in [Project References Improve Builds, but Add Maintenance Cost](#project-references-improve-builds-but-add-maintenance-cost).

Users declare source ownership scopes and graph rules. Limina builds the supported declaration graph from source dependencies and reports rule violations. Directory names such as `client` and `node` alone do not establish a runtime rule.

## Typical Scenario: Tests and Tooling Should Not Pollute the Main Build

Complex packages often contain test code and tool scripts:

```txt
packages/example/
  src/
  scripts/
  tests/
  vitest.config.ts
  build.config.ts
```

These files need type checking, but they should not necessarily participate in production artifact builds. A build-capable test or tool owner can still have a Limina declaration build for checking its own scope.

Tests may use test-only dependencies, and tools may use Node-only modules. Separate configs keep these type environments distinct from production source, as in the [multiple-runtime example](#typical-scenario-one-package-supports-multiple-runtimes).

Configure the intended source ownership: test files belong to test configs, tools use a suitable type environment, and production source stays outside test and tool ownership.

Ownership checks can report a file that is covered by conflicting configs.

## Typical Scenario: Code Runs, but the Structure Is No Longer Predictable

Cross-package relative imports are a common structural problem in monorepos:

```ts
import { Button } from '../../ui/src/Button';
```

This import bypasses the package name, dependency declaration, and public entry. The code may resolve even though `package.json` does not declare that dependency.

Declare the dependency in the importing package and use its public entry:

```ts
import { Button } from '@acme/ui';
```

Limina can check this import against the dependency declaration and consumed public entry. Declaration-provider edges, framework scheduling, and artifact consumption still depend on checker facts and target ownership; a package name alone does not establish a project reference.

`#imports` follow the same idea: a relative target is an internal entry of the declaring package scope and cannot be used to access another package; a package target may point to a third-party package or a workspace dependency, but it still needs to be authorized by the workspace package that owns the importing file.

As with [cross-config imports within one package](#project-references-improve-builds-but-add-maintenance-cost), resolution alone does not establish ownership, authorization, or declaration-reference requirements.

## AI Iteration Makes Structural Feedback More Important

Changes can leave imports outside package entries, dependencies undeclared, or source files outside their intended checking scope. Maintainers need to review these relationships as well as the changed code.

AI-generated changes need the same review. Rules that can be expressed as checks reduce repeated manual inspection.

Documentation, task descriptions, and instructions such as `AGENTS.md`, `CLAUDE.md`, or `.cursor/rules` can explain repository rules to AI. Check results are still needed to catch omissions and misinterpretations.

Type checkers, static analysis, and formatters provide repeatable diagnostics that AI can use to correct type, syntax, and style errors.

A local type or style check may still pass when an import bypasses a package entry, a dependency is undeclared, or a file is outside the intended checking scope.

Limina checks configured source ownership, project references, package boundaries, and coverage. Business behavior still requires tests, review, and domain validation.

These checks can run locally and in CI or pull request workflows, so structural diagnostics are available alongside other validation results.

AI can use check results to fix ordinary violations, but changes involving allowlists, ignore rules, boundary exceptions, or a required `reason` are better confirmed by a developer. These changes are usually not ordinary fixes; they declare that the team accepts an architecture exception.

Read AI-assisted fixes against the scope of each check: tests cover business behavior, ordinary tools provide type and static-rule feedback, and completed, enabled Limina checks cover their configured ownership and architecture rules.

## The Final Goal: Reduce Structural Maintenance Cost

Limina aims to reduce manual maintenance of declaration references and source boundaries.

Multiple packages, runtimes, checkers, and published entries need consistent ownership and dependency configuration. The examples above cover runtime scopes, tests and tools, and cross-package access.

The configured checks help answer these questions:

- Which source range does this file belong to?
- Which `tsconfig` should govern it?
- Do its module dependencies respect runtime boundaries?
- Do project references accurately express real source dependencies?
- Can the type build graph run incrementally?
- Are tests, tools, and production source clearly separated?
- Before publishing, do artifacts still satisfy the structural expectations established at the source stage?

Interpret each result within the configured scope and completed checks; disabled, blocked, skipped, or unavailable analysis does not establish that the corresponding relationship is valid. Package and release checks require configured built outputs and remain supplementary to real consumer tests.

Use the reported config paths, files, and dependency evidence to locate and correct the relationships that fail these checks.
