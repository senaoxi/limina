# Project context map

[English](./README.md) | [简体中文](./zh/README.md)

Source, tests and configuration establish current behavior; records preserve durable context. Historical validation in inherited records is not evidence for this migration. No record has a human vouch.

## Read by task

Read the relevant paired records before edits. For architecture work, use the Limina map to locate the sole owner; the entries below route other tasks and direct questions without duplicating that owner's definitions.

| Task or question                                                    | Context owner                                       |
| ------------------------------------------------------------------- | --------------------------------------------------- |
| Set up, edit, build or accept a repository change                   | [Development workflow](./development-workflow.md)   |
| Start architecture work and locate semantic owners                  | [Limina map](./limina.md#find-a-record-by-question) |
| Identify entities, authority, execution phases and relations        | [System model](./system-model.md)                   |
| Establish TypeScript / Vue / Astro / Svelte dependency facts        | [Semantic facts](./semantics.md)                    |
| Trace generations, caches, contexts, mutation and result freshness  | [Lifecycle](./lifecycle.md)                         |
| Locate protected properties, counterexamples and executable guards  | [Core invariants](./invariants.md)                  |
| Review invariant impact and select maintenance validation           | [Architecture workflow](./architecture-workflow.md) |
| Check reconstruction evidence, corrections and verification limits  | [Architecture audit](./architecture-audit.md)       |
| Change package distribution or repository integration boundaries    | [Repository architecture](./architecture.md)        |
| Evaluate reuse for a requirement, or add/replace a dependency       | [Dependency admission](./dependency-admission.md)   |
| Maintain supported dependency licenses and bundled-code policy      | [Dependency license policy](./license-policy.md)    |
| Maintain repository gates and commit checks                         | [Repository gates](./gates.md)                      |
| Understand toolchain versions and compatibility policies            | [Toolchain and checks](./technology-stack.md)       |
| Change CI, security, reports or external workflow integration       | [Infrastructure](./infrastructure.md)               |
| Check local migration scope and remote/publication/deployment gates | [Migration](./migration.md)                         |

## Bilingual publishing and maintenance

English topics live at `.agents/docs/<name>.md`; complete Chinese counterparts live at `.agents/docs/zh/<name>.md`. Both files must have the same filename and be tracked by Git. They are two language editions of one prose owner.

1. Maintain the complete pair in the same change for every PCR update, including prose-only corrections and additions, renames, moves or deletions.
2. Match meaning, examples, evidence dates and limits, caveats, provenance and effective status. Neither edition is an independent source of truth; translation does not create new validation, evidence or a human vouch.
3. Maintain both maps and cross-links together. Compare sections and heading anchors in both editions; check local links from each file's location.

## Writing and privacy review

Use [project-context-writing](../skills/project-context-writing/SKILL.md) before writing PCR or persisting technical audit results; it owns the writing, evidence-status and privacy-review procedure. Record technical facts, decisions, reasons, acceptance criteria and effective status. A pending requirement remains pending until source and relevant checks support it. Technical verification dates, public references and normal product-user concepts remain valid when relevant.

Keep each current truth in one prose owner; do not turn unstamped interpretation into human intent or permanent compatibility promises. Never add a vouch or decision ledger without explicit direction.

Distill feedback into project constraints; do not retain who asked, private interaction dates, conversation/task identifiers, personal paths or raw private metadata. Source fields must point to repository-relative evidence, reproducible checks or necessary public references. This repository rule overrides conversation-attribution wording in any managed PCR workflow; preserve managed markers and generated content.

Before handoff or an authorized commit, review the intended diff and both editions for privacy and technical meaning using the skill's checklist. Run `pnpm run docs:privacy --context-records .agents/docs` and the applicable formatting, pair, link and Git checks. Pattern scanning is a review aid, not proof of privacy or implementation; inspect semantics manually. Report credentials only by location/category, and never copy private originals into reports or fixtures.
