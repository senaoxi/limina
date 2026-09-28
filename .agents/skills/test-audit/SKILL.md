---
name: test-audit
description: 'Invoke whenever writing, materially changing, reviewing, or sweeping tests in docs-islands. Gate new tests by observable contracts, audit low-value or implementation-coupled coverage, consolidate duplicate proof at the correct owner boundary, and remove test-only production seams when they have no non-test contract.'
---

# Test Audit

Use one value bar across three modes. Authoring mode gates new or materially
changed tests. Audit mode reviews focused candidates that duplicate stronger
proof, couple behavior to implementation, or keep test-only production seams
alive. Campaign mode audits one subsystem's complete test surface; read
[CAMPAIGN.md](CAMPAIGN.md) before starting one.

Optimize for confidence and contract ownership, not deletion count.

## Authoring gate

Before adding or materially changing a test, answer all four questions:

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail for the intended reason?
3. Why does existing coverage not already own that contract?
4. Does the test require a production export, flag, wrapper, injection hook, or
   other seam that no production caller or public contract needs?

A missing answer means the test is not ready.

Treat the **owner boundary** as the closest real boundary that owns the
semantics and can detect the regression without reimplementing the behavior in
the test. Do not interpret "stronger" as "higher level": unit, integration, E2E,
and smoke tests are independent only when they cover distinct risks. Examples
include process boundaries, package output, module resolution, filesystem or OS
behavior, framework lifecycle, CLI execution, and packaging.

Prefer extending an existing table-driven case or fixture over replaying the
same contract in another layer. A behavior-preserving refactor should not break
a test unless the refactored structure is itself an architecture contract.

For bug regressions, demonstrate the pre-fix failure and post-fix success for
the intended reason. Use a safe baseline checkout/worktree, a focused control
fixture, or a deliberate mutation when appropriate. Do not overwrite unrelated
user changes to recreate the old state. If the pre-fix failure cannot be
demonstrated safely, report that limitation instead of claiming complete
regression proof.

## Junk patterns

These patterns are audit candidates, not automatic deletion rules. A matching
test is valid only when the [retention bar](#retention-bar) identifies an
independent contract it owns.

- assertion-free coverage probes;
- self-comparisons and identity copiers;
- expected inventories, manifests, exports, or fixtures mechanically copied
  from the production declaration they assert;
- exact source, import, identifier, or string checks that only pin an
  implementation spelling;
- private predicate or call-shape tests duplicated by an observable owner
  boundary;
- duplicate invocations of the same contract without a distinct failure mode;
- package-local replays of a shared helper's already-owned semantics;
- tests whose only purpose is preserving test-only exports, globals, wrappers,
  or injection hooks;
- dead production code whose only callers are tests and which owns no public or
  architecture contract;
- expected values produced by the helper, parser, renderer, or resolver under
  test;
- mocks that implement the behavior being asserted, or one semantically
  identical mock standing in for APIs with different contracts;
- fixtures that precompute the outcome or ordering that the production owner is
  supposed to produce;
- state or persistence assertions against a store the exercised path never
  writes;
- capability tests that merely restate declared flags instead of exercising the
  behavior those flags promise;
- negative controls that pass because of an unrelated guard or an unreachable
  rejection path;
- test names or fixtures that claim behavior their inputs and assertions do not
  exercise.

Do not classify repository fixtures merely because they contain copied-looking
`package.json`, `tsconfig.json`, workspace, or source files. In Limina,
fixture repositories are often the real behavioral input. Judge whether the
fixture is exercised through the owning parser/checker/CLI boundary and whether
its expected result is independently asserted.

## Value bar

A test earns its maintenance cost when it independently protects observable
behavior, a credible regression, or a meaningful contract.

Before judging a candidate, read the complete test and its production owner,
entry points, callers, callees, sibling implementations, overlapping tests,
relevant CI routing, and history. Read root and scoped `AGENTS.md` files first.
When behavior depends on a third-party API, inspect the installed dependency's
source or types when necessary.

An existing test that changes during a behavior-preserving reorganization is
suspect, not automatically deletable. Determine whether it guards architecture
or implementation before acting.

## Discovery

Keep discovery read-only until candidate evidence is complete.

1. Identify the owning Nx project and available targets with
   `pnpm nx show project <project> --json`; do not guess target names or flags.
2. Inspect the package's unit tests plus any owned integration, playground,
   E2E, smoke, fixture, or platform-specific suites.
3. Inspect cross-package proof when the contract is shared.
4. Inspect CI only where it adds routing, platform, packaging, or lifecycle
   semantics that local unit tests cannot establish.

For broad audits, divide work by production owner boundaries rather than test
filename prefixes. In this repository that commonly means package/core source,
Limina integration and detector fixtures, VitePress playground/E2E and smoke,
package smoke projects, scripts/tooling, and cross-cutting architecture tests.

Outside campaign mode, prefer a few high-confidence candidates over a large
speculative inventory.

## Retention bar

Keep a test when it independently enforces a public API, CLI, package,
configuration, migration, filesystem/process, platform, release, generated
output, dependency, security, or architecture contract. Also keep:

- call ordering when order is observable behavior;
- regressions with a credible and independently exercised failure mode;
- integration/E2E/smoke proof for risks not reachable at the unit owner
  boundary;
- repository fixtures that model real package/workspace/configuration inputs
  and exercise them through the production boundary;
- source inspection when it is the cheapest independent architecture or
  user-facing contract guard and survives unrelated identifier refactors;
- a retained baseline failure until it is reproduced and classified as a
  product defect, test defect, or environment issue.

Static, slow, or source-aware is not a deletion reason by itself. Prove that
stronger proof remains before deleting a test.

## Candidate evidence

Record every field before editing. A missing field means the candidate is not
ready for deletion:

- exact test name and location;
- the contract it claims to own;
- what concrete failure it can actually detect;
- non-test callers of any production or support seam involved;
- stronger remaining owner-boundary proof, or why no proof is needed;
- relevant history and why the test or seam exists;
- production or test-support deletion unlocked;
- risk and the focused validation command.

## Edit shape

Choose one coherent owner-boundary batch. Remove obsolete test-only exports,
globals, wrappers, and dead paths only after establishing that no production
caller, public API, or architecture contract needs them. Move retained
regressions to their canonical owner when doing so reduces duplicated proof.
Consolidate repeated package or dependency assertions only when one owner can
express the same contract without losing a distinct failure mode.

Production LOC reduction is a possible result, not a success metric. Do not add
replacement tests that restate the same implementation, and do not turn
uncertain candidates into cleanup merely to increase deletion counts.

## Validation

Follow the repository and nearest scoped `AGENTS.md` first. Do not edit source
or tests concurrently with a validation process that is reading the same
checkout.

1. Confirm the owner and available Nx targets with
   `pnpm nx show project <project> --json`.
2. Run the narrowest relevant Nx test target first. Pass file/filter arguments
   only when the target's configured command supports them.
3. Run integration, E2E, smoke, packaging, or platform proof only when the
   changed contract crosses that boundary.
4. Run the owner's required typecheck, lint, build, or documentation targets as
   required by repository policy.
5. For Limina-governed source/config/package changes, follow the repository
   Limina validation section, including `pnpm exec limina check`; for Limina
   tests, also follow `packages/limina/AGENTS.md`.
6. Run `pnpm lint:packages` when manifests, exports, dependencies, publishable
   outputs, or package structure are affected.
7. Avoid repository-wide mutating `pnpm lint` or `pnpm format` in a dirty
   checkout unless that mutation scope is intentional. Prefer non-mutating,
   targeted checks where possible.
8. Always run `git diff --check` and inspect final `git status --short`.
9. Inspect `git diff --numstat` when an audit removes substantial code; report
   production/tooling separately from tests and test support.

Report every validation command actually run and any relevant check that was
not run. Never claim a command passed unless it succeeded in the current
workspace.

## Landing and continuation

Commit, push, open a PR, merge, or otherwise land changes only when authorized.
Follow repository Git/PR policy rather than imposing a merge or rebase strategy
from this skill. Preserve unrelated working-tree and index changes.

For a continuing audit, refresh discovery from the current branch state before
starting the next owner-boundary batch.

## Handoff

Report:

- root cause and low-value categories removed or consolidated;
- production owner simplifications;
- retained audit candidates and the contracts that justify them;
- focused and broader proof actually run;
- production/tooling versus test/test-support LOC when materially changed;
- remaining failures, skipped checks, and uncertainties;
- named follow-ups.
