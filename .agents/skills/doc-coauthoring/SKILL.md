---
name: doc-coauthoring
description: Co-author, rewrite, translate, or review Limina documentation against the current repository. Use for README changes, user guides, concepts, CLI and configuration references, migration guides, and technical proposals. Preserve English/Chinese parity and review reader understanding. For PCR or saved technical audits, use project-context-writing as the owning procedure and this skill only for additional structure or reader review. Exclude ordinary technical Q&A without a documentation task.
---

# Limina Documentation Co-authoring

Use three stages: establish context and evidence, draft or revise, then review
for readers and run applicable checks. Complete focused edits directly; use
section-by-section collaboration when requested or when it resolves a material
uncertainty. Do not turn every documentation task into a questionnaire.

## 1. Establish context and evidence

### Scope and ownership

Read applicable `AGENTS.md` instructions, the [PCR map](../../docs/README.md),
relevant paired records, and the [development workflow](../../docs/development-workflow.md).
Inspect Git status and target files before editing; recheck their baseline before
writing. Preserve unrelated and concurrent work, including staged and untracked
files. Staging, commits, publication, and deployment require authorization.

Identify the reader, central question, document type, destination, and language
scope from the request and existing files. Public guides can assume TypeScript
project and package-manifest familiarity, not Limina implementation knowledge.
Read the existing document and counterpart before changing structure or terminology.
Use [repository routes](references/repository-routes.md) for destinations, evidence,
locale routing, and checks; recheck paths rather than treating them as fixed.

Keep each topic in its existing owner. For PCR or saved technical audit results,
read [project-context-writing](../project-context-writing/SKILL.md); it owns evidence
status, privacy, provenance, and PCR bilingual maintenance. Do not duplicate that
procedure or invent a decision ledger. Follow the architecture and dependency
admission routes in `AGENTS.md` when a proposal changes those boundaries.

Return a requested chat draft or replacement Markdown in the conversation. Do not
create a root-level scratch document merely because drafting began. For authorized
repository edits, use the established destination and an appropriate edit tool.
Use available tools; do not require a model vendor, global skill installation,
particular file-edit API, or unrelated private-account searches.

Read repository evidence before asking for facts available there. Ask only about
unresolved intent or constraints that would materially change the result. State
non-blocking assumptions and complete the supported portion. Respect an explicit
request for interactive drafting or a single-language chat response.

### Claim evidence

For new or materially changed technical claims, trace the relevant entry point,
conditions, normalization, execution, and rejection or fallback behavior. Read the
supporting source, tests, schemas, public contracts, manifests, and configuration;
do not inspect unrelated subsystems just to satisfy a checklist.

Use existing prose and memory as navigation or intent, not implementation evidence.
Identify the working-tree or revision basis when it matters. Local changes do not
prove publication; release-specific writing requires evidence for that release.
Keep implemented behavior, runtime observations, inference, recommendations,
conditional capability, historical behavior, and future intent distinct.

Correct or qualify unsupported claims. Surface conflicts with accepted requirements
or vouched direction through the owning procedure instead of silently rewriting
intent. Do not change production code to make a prose-only claim true or infer a
human decision from completed code. Source inspection is not runtime verification.

Use primary upstream sources for external claims and the relevant version. Keep a
compact claim-to-evidence map while drafting. Cite the actual supporting premise
in the document or handoff without filling introductory prose with internal paths.

## 2. Draft or revise for the reader

Lead with the applicable conclusion or task outcome and scope. Explain only the
concepts needed for the next step. Describe user-observable relationships before
internal names, generated artifacts, or phases. Distinguish Limina's responsibility
from compilers, package managers, build tools, and external tasks when that affects
the reader's decision.

When relevant, distinguish package authorization, source imports, project references,
checker ownership, and pipeline scheduling. Similar graph terminology does not
establish equivalent meaning or coverage; trace the relationship being documented.
Do not turn an implementation detail into a public compatibility promise.

Choose the shape by purpose:

- Concepts: concrete problem, causal mechanism, necessary distinctions, and limits.
- Task or migration guides: starting state, prerequisites, smallest safe steps,
  expected outcome, failure or recovery path, and mutation boundaries before commands.
- CLI or config reference: syntax, values, defaults, omitted versus explicit values
  where meaningful, interactions, invalid combinations, and observable effects.
- Proposals: current state, proposed change, alternatives, trade-offs, acceptance
  criteria, and open decisions; do not present them as approved or implemented.

Preserve verified technical meaning during rewriting. Report substantive corrections
rather than disguising them as style edits. Keep API names, fields, flags, issue
codes, and executable examples exact. Prefer mechanisms and bounded claims to
promotional adjectives; mention limits where they change the conclusion.

Use examples only for the current point. Establish command prerequisites, working
directory, side effects, and expected outcomes. Label illustrative output; never
invent successful transcripts or run migration, installation, release, or publishing
commands merely to illustrate them. Do not change executable examples casually.

### Language and navigation

Maintain both locales for public site pages and each existing paired README:
claims, examples, conditions, status, evidence scope, and link meaning must agree.
Create both editions for new site pages. If the user explicitly limits a public-doc
edit to one locale, report the remaining parity gap; mandatory PCR pairing still
follows its owning procedure. Translation does not create stronger guarantees or
new validation evidence.

Write natural Chinese developer prose. Retain English technical terms when useful,
keep terminology consistent, and leave CLI/API identifiers unchanged. Check each
language's headings and anchors separately; do not require literal sentence parity.

For public page additions, moves, renames, or removals, inspect both locale configs,
VitePress rewrites, navigation, and incoming links. Do not equate source paths with
public URL prefixes. Use links accessible to the intended reader, not an internal
PCR-relative link that breaks on the public site. Explain meaningful diagrams in
text and supply useful alternative text.

Apply feedback with focused edits and reread user changes before writing. Revisit
only affected claims, sections, counterparts, and links. Remove draft placeholders
unless the deliverable is explicitly an outline.

## 3. Reader review, checks, and handoff

### Reader review

Ask whether a reader can identify the applicable situation, action or mechanism,
expected result, and limitation from the document and accessible references alone.
A short rewrite needs a focused reread; a substantial guide needs explicit checks
of its highest-risk misunderstandings, not a fixed quota of questions or rounds.

When an independent reader agent is available and appropriate, give it only the
document, intended audience, and questions, not the authoring conversation or hidden
implementation conclusions. Ask for supporting passages, ambiguities, and missing
prerequisites. Compare its answers against evidence rather than confidence.

Otherwise perform a document-only self-review and identify it as such. Do not claim
fresh-context testing occurred or require another chat before delivering the result.
Repair misunderstandings and repeat the affected review. Reader comprehension is
not proof of implementation, runtime verification, or maintainer approval.

### Checks and handoff

Select checks through [validation routes](references/repository-routes.md#validation-routes)
and current manifests. Recheck claims against source, compare locale pairs, and
inspect formatting, frontmatter, local links, anchors, navigation, and privacy.
Use existing tooling plus semantic review; a pattern scan cannot prove correctness.

Run relevant read-only formatting and repository gates, and docs build for site
changes. For executable examples or behavior claims requiring empirical evidence,
select focused tests and follow applicable verification instructions. Report failures
and skipped checks; do not relabel source inspection as execution.

Review the intended diff and Git status. Inspect untracked additions explicitly:
ordinary `git diff --check` does not inspect their content. Do not fix unrelated
failures, weaken gates, install dependencies, or broaden the task silently.

Deliver the text or changed paths, material corrections, checks actually executed,
and unresolved or unverified items. Do not append private chat history, conversation
links, personal paths, credentials, or raw tool output to repository documentation.
