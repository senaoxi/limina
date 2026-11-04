---
name: limina-typescript-semantics
description: 'Investigate or change TypeScript Project References, Native evidence, framework Checkers, declaration providers, generated references, and semantic cache behavior inside Limina. Exclude generic TypeScript style and Limina consumer setup.'
---

# Limina compiler semantics

1. Read [the map](../../docs/README.md), [semantic facts](../../docs/semantics.md),
   [system model](../../docs/system-model.md), and relevant
   [invariants](../../docs/invariants.md). For incremental/context/cache work read
   [lifecycle](../../docs/lifecycle.md); obtain version policy from
   [technology stack](../../docs/technology-stack.md), then inspect manifests,
   lockfiles and actual resolved implementations. Prose versions are navigation.
2. Frame one semantic proposition with a concrete importer, config, request
   kind, resolution mode, selected target, and expected compiler observable.
   Trace the production chain and producer/consumer types using the
   [source anchors](references/source-anchors.md), not their names alone.
3. Keep physical file identity, compiler member identity, source ownership,
   semantic authority, and execution ownership distinct. Separately trace source
   dependency, TypeEvidence, Compilation Obligation, declaration dependency,
   Project Reference, framework scheduling, and output attribution. A resolved
   path or a semantic graph edge alone does not authorize changing raw references.
4. Follow declaration-provider selection, actual declaration inputs/outputs,
   reference projection, final admission, Checker execution, and cache context
   qualification. Preserve absent, unknown, unavailable, unsupported, and failed
   evidence as different states. A physical resolver result cannot stand in for
   the compiler's request, membership, or declaration proof.
5. Inspect TypeScript and the selected Vue/Astro/Svelte Checker's actual
   version-matched code. Observe tsc, tsgo, and framework tools independently
   when claiming parity. Do not promote one version's behavior to a universal
   contract, equate semantic family with executable identity, or treat a bounded
   analysis as a full compiler Program.
6. For empirical confirmation, use
   [change verification](../limina-change-verification/SKILL.md) for a faithful
   reproduction, independent counterexamples, real Checker/process boundaries,
   and exact version results. A source-only explanation ends at labeled source
   evidence without claiming a runtime result. Compare direct compiler behavior, Limina evidence,
   generated configs/references, and final build only where the proposition
   connects them. Distinguish cold/warm/incremental states and unavailable tools.

Return the claim, source chain, observations per tested tuple, revised boundary,
and NOT VERIFIED conditions. Route architecture changes to
[architecture review](../limina-architecture-review/SKILL.md) and saved findings
to [project-context-writing](../project-context-writing/SKILL.md). Reuse completed
investigation; do not recursively restart skills or duplicate PCR definitions.
