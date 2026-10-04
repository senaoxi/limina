---
name: project-context-writing
description: Write or maintain repository Project Context Records (PCR) and saved technical audit reports, including English/Chinese pairs, source-grounded implementation status, decision summaries and privacy review. Use for .agents/docs changes or when persisting findings from another skill.
---

# Project Context Writing

Read the repository AGENTS, PCR map and owning record before writing. Use source,
tests, manifests and checked-in configuration to establish current behavior.
Keep each topic in its existing owner; maintain complete English/Chinese pairs
with matching filenames, claims, examples, evidence scope and relative links.

## Technical facts and decisions

- Lead with the applicable technical conclusion, scope and reason. Preserve
  decisions, rejected alternatives, acceptance criteria and known limitations.
- Separate implemented behavior, inferred consequences, pending constraints and
  Open decisions. A request establishes a constraint, not delivery. Source
  inspection is not runtime verification; list commands and results only when
  actually executed, including failures, skips and environment limits.
- Cite repository-relative source/test/config paths, reproducible commands,
  relevant commit hashes or necessary public standards. A private conversation
  is input to distill, not a durable source citation. Do not infer acceptance,
  rationale, compatibility promises or a human vouch from implementation.
- Capture the technical correction or decision after feedback, without recording
  who asked, private interaction dates, dialogue chronology, screenshots,
  personal absolute paths or conversation/session/task identifiers. Persist only
  the necessary project constraint, not temporary permissions or task history.
- Preserve meaningful release dates, dated verification baselines, dependency
  measurements, public references and existing valid vouch semantics. Dates and
  the product's users are not blanket privacy violations. Add a vouch only on
  explicit instruction; if an edit changes covered words, follow the repository
  stamp rules rather than inventing renewed acceptance.

## Examples

These examples use fictional components and neutral data.

- Avoid: "A reviewer asked in a private chat to make DemoPanel eager."
  Prefer, after checking source: "DemoPanel uses `client:load` for eager
  hydration; both locale examples use the same directive."
- If source still uses `client:visible`, write: "Pending constraint: switch
  DemoPanel to `client:load` in both locales. Acceptance requires source parity
  and browser verification." Do not claim the change already ships.
- Avoid: "A request in a private session selected a five-second retry."
  Prefer: "Metadata polling retries at five-second intervals until the monotonic
  deadline; integrity mismatches fail immediately. Verify with the release
  regression suite."
- Keep: "The 2040-01-02 compatibility audit covered Node 24 and two checker
  tuples; other platforms were not run." This is a technical evidence date.
- Keep: "Users can select a workspace through the CLI." This is product behavior.

## Privacy review before handoff or an authorized commit

1. Review the intended diff and both language editions for private attribution,
   dialogue paraphrases, personal paths, private hostnames, raw output metadata,
   session/task IDs and credentials. Inspect filenames and link destinations too.
   Use relative paths or documented placeholders for local reproduction roots.
2. If credentials appear, report only category and file/line. Remove them from
   the scoped current files without reproducing values in reports, examples or
   fixtures. Do not expand into rotation or Git history rewriting without scope.
3. Run the repository's applicable scanner below, then inspect semantics manually.
   Pattern scanning is a review aid; it cannot prove privacy or implementation.
   Synthetic controls must use fictional data, never copied private input.
4. Check pairs, heading anchors, local links, skill frontmatter and
   `git diff --check`. Recheck file hashes/status/index before edits and at
   completion; preserve concurrent and unrelated changes. Report checks actually
   run, failures and unverified behavior. Commit/push remain separately authorized.

Run `pnpm run docs:privacy --context-records .agents/docs` for PCR prose. This
uses the existing documentation scanner with narrow attribution/identifier
checks enabled only for context records. Public docs keep their existing
`pnpm run docs:privacy` gate. Inspect all hits and semantics manually; do not
weaken a rule or add a broad exclusion to hide a real finding.
