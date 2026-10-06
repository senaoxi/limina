# Why Limina

A TypeScript project often starts with one `tsconfig.json` and one type-check command. It is easy to see where the source lives, what it depends on, and which config checks it.

As the repository splits into packages, and individual packages gain browser code, Node code, tests, and tooling, these answers become spread across different configs. Moving a file or adding an import can affect package dependencies, checking scopes, and build relationships at the same time.

Maintainers need to keep asking: **Do the relationships in the source still agree with the package declarations, checking configs, and boundaries the team has chosen?**

## What Still Matters After Type Checking Passes

Suppose an application in a workspace imports another package's source directly:

```ts
// packages/app/src/main.ts
import { Button } from '../../ui/src/Button';
```

With a configuration that allows direct resolution of workspace source, this import may pass type checking and work in a development build. Yet it bypasses the public entry of `ui`; the `package.json` for `app` may not even declare a dependency on `ui`.

Type checking answers questions about types in the current program. The team still needs to decide whether `app` is allowed to use this package, whether it uses the intended entry, and whether that access remains valid when the packages are built independently or published.

If the team requires access through package entries, declare the dependency in `app`, expose the corresponding entry from `ui`, and change the import to:

```ts
import { Button } from '@acme/ui';
```

These pieces of information must work together, but they answer different questions:

| Information                   | Question it answers                                                    |
| ----------------------------- | ---------------------------------------------------------------------- |
| Source `import`               | Which module entry does this file actually use?                        |
| `package.json` dependencies   | Which packages does this package declare it can use?                   |
| `package.json#exports`        | Which entries does this package expose to consumers?                   |
| `tsconfig`                    | Which files are checked, and in which type environment?                |
| TypeScript project references | Which upstream project outputs must a project build and consume first? |

Switching to a package name is one step. Package declarations, entry resolution, and type-build relationships still need separate checks.

## One Package Can Have Multiple Checking Scopes

Package boundaries cannot express every source constraint. For example, a package may contain:

```txt
packages/example/
  src/client/   # browser code
  src/node/     # Node code
  src/shared/   # modules used by both
  tests/        # tests
  scripts/      # tooling
```

Suppose the team wants both `client` and `node` to depend on `shared`, while `shared` stays independent of any runtime and `client` cannot depend on Node-only modules.

Each scope can use a `tsconfig` suited to its type environment. Tests and tooling need checking too, but their type environments and available dependencies may differ from production source. Being type-checked does not mean they should enter the published production output.

Splitting configs creates relationships to coordinate: whether new files enter the intended scope, whether multiple configs claim the same file as their own source, whether imports between configs need upstream declarations, and whether dependencies follow the direction the team intended.

Here, “source ownership” means which config's selected source scope a file belongs to. Importing `shared` from both client code and tests is different from listing its files as owned source in both configs. Shared use does not itself create an ownership conflict.

Directory names help people understand purpose. To make tools report violations, the source scopes and allowed dependency directions also need to be configured.

## How Limina Reduces This Maintenance Work

Limina reads source configs and package declarations, then uses the type checker's analysis of imports and type sources to check source ownership and dependency rules. For checkers that support declaration builds, it generates the required project references.

The team chooses the boundaries; Limina computes and checks them within the configured scope. These responsibilities answer two different questions: which relationships should be allowed, and whether the current code meets those requirements.

### Check Source Ownership and Dependency Boundaries

For the earlier examples, Limina can check cross-package relative imports, whether package imports are authorized by dependency declarations, and whether source within the checking scope has gaps or conflicting ownership.

Runtime restrictions require additional configuration. For example, apply [graph rules](./config/graph-rules.md) to the client source's `tsconfig` to restrict dependencies on Node built-ins or specified server source scopes. Naming a directory `client` does not enable these restrictions.

These checks help maintainers find differences between code and intended boundaries when adding, moving, or splitting source.

### Generate Project References from Declaration Build Requirements

TypeScript [project references](https://www.typescriptlang.org/docs/handbook/project-references.html) connect projects through declaration outputs. With `tsc -b`, the compiler can build in dependency order and skip projects that are already up to date. The maintenance question is whether those references still match the current source's build requirements.

With Limina, the team continues to maintain configs that describe source scopes and type environments. Limina derives the required project references from checker analysis of dependencies and type sources, then delegates declaration builds to `tsc`, `tsgo`, or `vue-tsc`.

For example, when `client` imports a module from `shared`, a reference is generated only if they belong to different managed source configs, the checker establishes that the current build needs declarations from `shared` source, and ownership and checker compatibility conditions are met. If the checker consumes an existing `.d.ts` instead, that consumption alone does not create a reference to its source project.

Source imports, artifact consumption, and project references therefore need separate explanations. See [Why Imports Cannot Directly Become References](./why-import-is-not-references.md). Astro and Svelte checkers type-check their respective source configs without generating declaration build configs; scheduling relationships between framework checks are also distinct from TypeScript project references.

### Extend Checks to Configured Build Outputs

Correct source relationships do not establish that a published package is usable. Consumers read package entries and build outputs, which may differ from the source accessed directly during workspace development. An entry declaration might still point to source files, for example, while the published package contains only built files.

For packages that will be published, configure [package checks](./config/package-checks.md) and [release checks](./config/release-checks.md) after preparing the build outputs. Coverage depends on the configured outputs, enabled checks, and available analysis tools. These checks still need real consumer tests alongside them.

Limina derives and checks these relationships. Package managers still install dependencies, type checkers perform type checking and supported declaration builds, and bundlers produce production artifacts. Business behavior, API design, and the suitability of the boundaries still require tests and review.

## AI-Assisted Changes Need Structural Feedback Too

AI can use project documentation and instructions such as `AGENTS.md` to modify code, but it may still omit dependency declarations, bypass package entries, or leave new files outside the intended checking scope. These changes need the same checks as human changes.

Once team constraints are expressed as rules, local and CI reports from Limina can provide concrete files, configs, and dependency evidence to help developers or AI locate problems.

Fixing a violating import is different from changing an allowlist, ignore rule, or boundary exception. The latter changes the constraints the team accepts; developers should review the reason, rather than treating a passing check as the only goal.

## When Adoption Is Worth Considering

The deciding factor is the cost of maintaining structural relationships. Consider Limina when:

- Multiple source configs must work together, and file ownership or check coverage is easily missed or overlaps.
- Package dependencies, public entries, and actual imports change frequently, requiring repeated consistency checks during review.
- The team already has runtime boundaries or dependency-direction rules and wants to check them continuously in local development and CI.

If a project has clear, stable source scopes and its existing type-check and build workflows are sufficient, continuing with those workflows is reasonable.

Adoption requires the team to define source scopes, checker ownership, and applicable boundary rules, and to resolve conflicts in existing configs. Limina can reduce repetitive maintenance, but it cannot decide how to split packages, design public APIs, or accept architecture exceptions for the team.

## Start from an Existing Project

Evaluate adoption around a specific problem, such as finding unchecked source or maintaining client/server dependency boundaries:

1. Follow [Getting Started](./getting-started.md) to prepare dependencies and initialize a config. Review which packages and source files are included and which checker owns each source config.
2. If configs that actually contain source already declare TypeScript project references by hand, use the matching version of `limina-migrate` as described in the [migration guide](./cli.md#limina-migration). Initialization does not rewrite source tsconfigs, so completing initialization does not mean migration is complete.
3. Run checks, use the reported files, configs, and dependency evidence to resolve issues, then add the applicable checks to daily development and CI.

Read results together with their scope and execution status: disabled, blocked, skipped, or unavailable analysis does not establish that the corresponding relationships are valid.
