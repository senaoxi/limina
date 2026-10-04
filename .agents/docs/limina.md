# Limina Architecture Knowledge

[English](./limina.md) | [简体中文](./zh/limina.md)

Limina connects config-selected package governance scope, checker semantic facts, declaration build relations, and filesystem mutation authority. A successful governance run must separately answer “who may interpret this source,” “which relations require validation or building,” and “whether this result is still valid.” These answers share inputs but have distinct authority; one field cannot establish all of them.

This record set was reconstructed from the **2026-09-11 working tree**. Production code, types, schemas, configuration, and executable call chains establish facts; tests seek counterexamples. Earlier PCR served only to identify questions to recheck. None of the prose has a human vouch. `Confirmed` means direct implementation evidence, not a long-term product commitment or empirical coverage of every environment. The empirical scope is recorded separately in the [audit](./limina-architecture-audit.md).

## Find a record by question

| Question                                                                                                                                | Sole prose owner                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| How are entities identified, where does authority come from, what is the actual execution order, and which relations can produce edges? | [System model](./limina-system-model.md)                                                                 |
| How do config selection, the nearest root manifest, and workspace/single classification establish authority?                            | [Root authority](./limina-system-model.md#workspace-discovery-authority)                                 |
| How do nameless Knip owners retain identity and which pnpm behaviors remain capability-specific?                                        | [Knip identity and capabilities](./limina-system-model.md#knip-owner-identity-and-capability-boundaries) |
| How does a validated region index canonical packages, owner cuts, and re-entry?                                                         | [Region query index](./limina-system-model.md#internal-query-index-for-validated-regions)                |
| How do TypeScript / Vue / Astro / Svelte obtain trustworthy dependency facts?                                                           | [Semantic facts](./limina-semantics.md)                                                                  |
| How do generation, caches, disposal, artifacts, mutation, and issue freshness fit together?                                             | [Lifecycle and publication](./limina-lifecycle.md)                                                       |
| Which properties must ordinary refactoring preserve, why, and how can they be challenged?                                               | [12 Core Invariants and evidence matrix](./limina-invariants.md)                                         |
| How should PRs analyze impact and synchronize code, guards, and PCR?                                                                    | [Review and maintenance workflow](./limina-architecture-workflow.md)                                     |
| What changed in the earlier PCR, and what were the four review rounds and actual command results?                                       | [Audit](./limina-architecture-audit.md)                                                                  |

The system model owns definitions; invariants own properties, counterexamples, and enforcement sites; the workflow owns maintenance actions; the audit records only this reconstruction's evidence and corrections. Other records link these owners rather than duplicating full definitions. Repository integration boundaries remain owned by [architecture.md](./architecture.md#limina-boundary).

## Current public surface

[package.json](../../packages/limina/package.json) defines the ESM package, Node range, `limina` binary, and exports. The manifest owns the version; architecture records do not maintain a second copy. The main module's public API is defined by [src/index.ts](../../packages/limina/src/index.ts): `defineConfig`, configuration types, validation errors, and governance issue types. Internal providers / semantic contexts do not thereby become a public plugin API.

The [CLI factory](../../packages/limina/src/cli/factory.ts) registers init, check, graph, proof, source, build, checker, package, release, and a deprecated migration forwarder. The separate `limina-migrate` package owns migration execution and embeds the required same-release core source. `limina/internal/*` maps workspace modules directly to `.ts` source; all internal mappings are removed from the published export map. These same-release entries are not a cross-version plugin API. [Repository boundaries](./architecture.md#limina-boundary) own distribution and dependency details; [migration lifecycle](./limina-lifecycle.md#migration-is-a-separate-transaction) owns verification scope. Consult registration modules, schemas, and `limina --help` for subcommands and flags. `release check` checks configured release consistency; repository release scripts perform publication. The check command must not be treated as npm publish.

The [build configuration](../../packages/limina/rolldown.config.ts) externalizes declared runtime/peer/optional dependencies; other build inputs may be bundled. The [manifest generator](../../packages/build-tools/src/package-plugin.ts) retains and resolves development metadata while removing private workspace development dependencies. A tool in devDependencies does not become a production dependency merely by appearing there, nor does its name prove that it is bundled. Actual published contents still require the relevant build/package checks.

The [configuration loader](../../packages/limina/src/config/loader.ts) accepts an object, promise, or function receiving command/mode, then normalizes and validates it. Top-level configuration, defaults, and compatibility ranges are defined by [config](../../packages/limina/src/config) and the [schema](../../packages/limina/schemas/tsconfig-schema.json); root repository choices belong to [limina.config.mts](../../limina.config.mts). The current flat `config.checkers` contains both `auto` policy and named scopes, with automatic discovery always enabled. Named scopes select default source `tsconfig.json` entries; named configs enter through managed reference closures, and `auto.exclude` does not truncate an established closure. Do not reintroduce the legacy `mode: auto` model.

## Facts, inferences, and human judgments

- **FACT / Confirmed**: current behavior whose creator, consumer, necessary guard, and applicable conditions can be identified.
- **INFERENCE / Derived**: a property or risk inferred from multiple facts; it does not establish the designer's motivation.
- **DESIGN JUDGMENT / Candidate**: a proposal, trade-off, or open product boundary; identify who must decide.
- **NOT VERIFIED**: the relevant experiment was not run, or the environment could not preserve a key condition. A test's existence is not evidence that it passed in this run.

These records define retrieval and review conventions without a decision ledger or human vouch. Direction questions the source cannot answer remain Open: the compatibility commitment for public issues/schemas/paths; extension contracts beyond the fixed checker set; the long-term status of `build --raw`; whether the domain/application layers will centrally drive all production validation; and whether external caches spanning provider generations need support. Closing an Open question requires an explicit project decision or relevant empirical evidence; implementation alone cannot establish product intent.
