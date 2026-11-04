# Semantic source entry points

These are search starting points. Read current callers and consumers before
asserting a production path; names and documents are not execution evidence.

| Question                                             | Start here                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI to production execution                          | [CLI factory](../../../../packages/limina/src/cli/factory.ts), [check runner](../../../../packages/limina/src/cli/check-run.ts), [pipeline execution](../../../../packages/limina/src/pipeline/execution.ts)                                                                      |
| Semantic versus execution ownership                  | [ownership types](../../../../packages/limina/src/core/build-graph/checker-ownership-types.ts), [project contexts](../../../../packages/limina/src/core/project-dependencies/context.ts)                                                                                          |
| Native request facts, TypeEvidence, obligation joins | [dependency facts](../../../../packages/limina/src/core/typescript-semantic/dependency-fact.ts), [Native obligation](../../../../packages/limina/src/domain/analysis/native-obligation.ts), [Native Coverage](../../../../packages/limina/src/domain/analysis/native-coverage.ts) |
| Generated reference admission and restored graphs    | [reference validation](../../../../packages/limina/src/core/build-graph/reference-validation.ts) and its actual callers                                                                                                                                                           |
| Checker execution and dependency scheduling          | [dependency plan](../../../../packages/limina/src/typecheck/build/dependency-plan.ts) and selected Checker adapters                                                                                                                                                               |
| Generation, cache, and disposal                      | [preflight manager](../../../../packages/limina/src/preflight/manager.ts), [analysis cache](../../../../packages/limina/src/core/build-graph/analysis-cache.ts)                                                                                                                   |

For Vue, Astro, and Svelte, use the [semantic owner](../../../docs/semantics.md)
to locate the current adapter, capability qualification, and upstream dependency
entry. Inspect the installed Checker implementation from its real resolution
owner. Do not infer framework behavior from Native paths, or assume a workspace
root dependency is the toolchain selected for a leaf.

For declaration governance, resolve the source/config consumer and provider,
then follow the actual producer into the generated graph and execution admission.
For incremental behavior, record input/context identity, selected tool tuple,
cold/warm state, and actual outputs. Source/test anchors are navigation, not a
promise that those checks ran or that all supported versions behave identically.
