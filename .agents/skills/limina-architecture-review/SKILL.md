---
name: limina-architecture-review
description: 'Review Limina designs, diffs, PRs, and cross-module changes for reachable correctness and architecture failures. Exclude simple mechanical edits, consumer configuration help, and speculative robustness advice.'
---

# Review Limina architecture

1. Pin the scope, intended observable, revision, and existing diff. Start with
   [the PCR map](../../docs/README.md), [Limina map](../../docs/limina.md), and
   [architecture workflow](../../docs/architecture-workflow.md). Use the sole
   English/Chinese owner; do not add a parallel architecture knowledge system.
2. Reconstruct the changed production chain with
   [source investigation](../limina-source-investigation/SKILL.md), or reuse its
   current evidence. Distinguish actual Domain/Application/Infrastructure/Checker
   wiring from unused abstractions. Review source before treating PCR as fact.
3. Identify affected [Core Invariants](../../docs/invariants.md) by the actual
   identity, authority, relation, lifecycle, failure, or public-contract change.
   If none applies, explain why those observables are preserved. Use
   [repository architecture](../../docs/architecture.md) for package boundaries,
   [system model](../../docs/system-model.md) for definitions,
   [semantics](../../docs/semantics.md) for compiler facts, and
   [lifecycle](../../docs/lifecycle.md) for cache/publication/freshness.
4. Challenge input admission, semantic correctness, execution order, identity
   and authority, unavailable/partial/cancelled states, resource lifetime,
   cache restoration, and version compatibility. Choose relevant angles and
   find real reachable counterexamples; do not turn every angle into a finding.
5. Use [change verification](../limina-change-verification/SKILL.md) for empirical
   claims and [test-audit](../test-audit/SKILL.md) when reviewing tests. Static
   concerns stay labeled until the required experiment establishes them.
6. Classify independently by severity and disposition. P0 is catastrophic,
   P1 severe reachable correctness/authority/freshness failure, P2 bounded
   defect or credible maintenance risk, P3 limited clarity/drift. Disposition is
   pre-implementation blocker, implementation acceptance, or allowed follow-up.
   Name exactly which action/claim a blocker prevents. Uncertainty, unavailable
   tooling, and general hardening do not by themselves establish P0/P1.

For each blocking finding provide: trigger; current source/line evidence;
actual behavior; expected contract and owner; root cause; smallest sufficient
repair; independent validation; and limits. Deduplicate by root cause. No defect
is a scoped outcome, not an all-platform guarantee. Review alone does not
authorize a fix. Route durable record edits through
[project-context-writing](../project-context-writing/SKILL.md), public/bilingual
docs through [doc-coauthoring](../doc-coauthoring/SKILL.md). Global review skills
are optional orchestration, never a replacement for these owners.
