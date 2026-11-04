---
name: limina-source-investigation
description: 'Investigate current Limina repository implementation, production call chains, and ownership for read-only source questions or pre-change grounding. Exclude consumer setup, historical rationale alone, and unrelated repositories.'
---

# Investigate Limina source

1. Read the root/scoped AGENTS, [PCR map](../../docs/README.md), and the relevant
   owner through [the Limina map](../../docs/limina.md). Record the actual branch,
   HEAD, and relevant working-tree differences. Preserve existing work.
2. Start at an actual entry selected by the question. For CLI behavior, begin
   with [the launcher](../../../packages/limina/bin/limina.js) and
   [registration](../../../packages/limina/src/cli/factory.ts); follow the
   selected command through the real runner and its consumers. For another
   surface, find its actual caller first. These are starting points, not a
   frozen call graph.
3. Track inputs, normalized types, identity, authority, ordering, state, errors,
   caches, and disposal through the complete affected production chain. Locate
   Domain, Application, Infrastructure, Core, and Checker responsibilities by
   actual imports/calls. A directory, class name, test-only caller, or architecture
   diagram does not establish that production executes an abstraction.
4. Consult [system model](../../docs/system-model.md) for definitions and
   [lifecycle](../../docs/lifecycle.md) for freshness/lifetime questions. Read
   current types and producers/consumers; follow dynamic/process entries too.
   Use [TypeScript semantics](../limina-typescript-semantics/SKILL.md) when the
   question requires compiler/checker evidence, reusing the chain already traced.
5. Answer with a causal chain and accurate current source paths/line numbers.
   Separate source fact, executed test/probe, PCR context, derivation, and
   NOT VERIFIED. Test existence is not a passing run, and source facts are not
   human design intent or a promise for every version.

Keep read-only questions read-only. If empirical confirmation is requested,
use [change verification](../limina-change-verification/SKILL.md) in permitted
evidence space; do not modify product code to make an answer true. For saved
findings, use [project-context-writing](../project-context-writing/SKILL.md).
No global Pstack skill is required.
