# Configuration Reference

Use `scope` for governance boundaries. Configure checks, `pipelines`, `concurrency`, and `cache` directly at the top level so their options are easy to find. Every field is optional; `defineConfig({})` uses all defaults.

| Domain                                           | Responsibility                                                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `scope`                                          | `regions` establishes governed regions, `source` selects source files, and `checkers` selects checker entries and ownership. |
| `graph`, `source`, `proof`, `package`, `release` | Rules, inputs, tools, and exceptions for Graph, Source, Proof, Package, and Release.                                         |
| `pipelines`, `concurrency`                       | `pipelines` orders steps; `concurrency` controls resource limits.                                                            |
| `cache`                                          | Persistent analysis caching and additional validity inputs, independently of orchestration.                                  |

Existing configurations require a one-time [configuration migration](./config-file.md#config-domains-migration).

Configuration normally lives in `limina.config.mts` beside the project's `package.json`. Start with the default regions, source scope, and automatic checker discovery, then add rules for the problems you need to address.

## Read by Configuration Goal

| What you need to decide                                                                            | Configuration entry                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Which config to use, which package is the governance root, and what to return for each environment | [Config File](./config-file.md): `defineConfig`, loaders, `mode`, and `command` |
| Whether to persist analysis and which additional files affect validity                             | [Analysis Cache](./config-file.md#cache): `cache` and `cache.dependencies`      |
| Which packages and nested package scopes belong to the run                                         | [Regions](./regions.md): `scope.regions`                                        |
| Which source files need checking coverage                                                          | [Source Boundary](./source-boundary.md): `scope.source`                         |
| Which checker owns each source config                                                              | [Checker Configuration](./checkers.md): `scope.checkers`                        |
| Who authorizes source imports, and how to check unused code                                        | [Source Checks](./source-checks.md): `source`                                   |
| Which project references, package dependencies, or built-in module dependencies are forbidden      | [Graph Rules](./graph-rules.md): `graph.rules` and labels in source configs     |
| Which specific files temporarily do not require ordinary checking coverage                         | [Proof Allowlist](./proof-allowlist.md): `proof.allowlist`                      |
| Which built outputs need checking                                                                  | [Package Checks](./package-checks.md): `package.entries`                        |
| How to check packed files and workspace publish dependencies                                       | [Release Checks](./release-checks.md): `release`                                |
| How to combine tasks and control execution resources                                               | [Pipelines](./pipelines.md) and [Execution Concurrency](./execution.md)         |

## Suggested Configuration Order

First establish the config file and governance root, then review package regions, source scopes, and automatic checker discovery. Add named scopes and graph rules when you need fixed checkers or dependency directions. Configure output entries and their checks when you need to publish packages.

`scope.source` selects files that need coverage; `source` configures source-check policies. They serve different purposes. See [Regions](./regions.md) for the distinction between `scope.regions.exclude`, source exclusions, and checker-entry exclusions.

In source tsconfigs, `liminaOptions` declares graph-rule labels, declaration relationships invisible to static analysis, and user artifact outputs. See [Core Concepts](../concepts.md) for explanations and examples.
