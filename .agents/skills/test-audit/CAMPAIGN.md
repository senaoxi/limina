# Test-pruning campaign

Campaign mode audits one subsystem's complete test surface as one coherent
change. The value bar, retention bar, candidate evidence, edit rules, and
validation in [SKILL.md](SKILL.md) apply to every lane.

Use campaign mode only when the requested scope is explicitly subsystem-wide.
Do not turn an ordinary focused audit into a deletion campaign.

## 1. Establish the baseline

Define the subsystem by production ownership, not only by directories. Record:

- the baseline revision or working-tree state;
- all in-scope test, fixture, harness, and test-support files;
- the owning Nx projects and their relevant targets;
- baseline failures separately from passing tests.

Use an isolated worktree or another non-destructive baseline when reproducing
older behavior would otherwise overwrite unrelated user changes.

Done when every in-scope test surface has an owner and its baseline state is
known.

## 2. Split by owner boundary

Divide the subsystem into **lanes** along production semantics. Typical
boundaries may include parsing/resolution, graph construction, configuration,
CLI/process execution, package output, framework lifecycle, filesystem/platform
behavior, or shared helpers.

Include integration fixtures, smoke projects, playground/E2E cases, and
platform-specific CI cases only when the subsystem owns their contract.

Done when every in-scope test belongs to one primary lane and cross-lane proof
is explicitly identified.

## 3. Build a read-only ledger

Read every assigned test in full, including parameter tables. Read its
production owner, entry points, callers, relevant history, overlapping tests,
and CI routing before classifying it.

Use one ledger mark per independently meaningful contract:

- `R`: retain; name the contract and failure mode;
- `F`: retain the contract but repair a vacuous, misleading, or unreachable
  assertion;
- `C`: consolidate; name the owner that will absorb the contract and the proof
  that remains;
- `D`: delete; name the stronger remaining proof or explain why no independent
  contract exists.

An `it.each` or equivalent table may be one ledger item when all rows exercise
the same contract. Split rows when they have materially different failure
modes.

Parallel read-only reviewers are optional. When unavailable, perform separate
review passes; independence of reasoning matters more than agent count.

Done when every declaration or meaningful table row has a classification and
evidence.

## 4. Plan the retained layers

Treat the ledger as evidence, not as the edit list. Perform a second pass that
asks which test layer actually owns each contract.

Name a **keeper** for every retained contract. A higher-level suite is not
automatically stronger: prefer the closest real owner boundary, and retain
integration/E2E/smoke proof only for distinct risks such as process behavior,
package artifacts, real module resolution, filesystem/OS behavior, framework
lifecycle, or packaging.

Identify any test-only production seams that become unnecessary if a layer is
retired.

Done when every proposed deletion has a keeper or an explicit no-contract
justification.

## 5. Cut over lane by lane

Apply one owner-boundary lane at a time. Serialize edits to shared harnesses and
support code so overlapping changes do not hide lost coverage.

Remove test-only exports, getters, reset hooks, injection seams, or indirection
only after confirming they have no non-test caller or durable contract.

Update CI routing, explicit test inventories, or baseline files only when those
mechanisms actually exist in this repository and the moved test participates in
them. Do not introduce such mechanisms just to satisfy the campaign.

Add or change scoped `AGENTS.md` test-ownership rules only when the campaign
discovers a durable repository rule worth enforcing in future sessions.

Done when each lane's keepers pass their focused validation.

## 6. Preservation review

Before claiming completion, perform an independent pass over deleted coverage
and retained keepers. Look specifically for:

- a contract that lost its only proof;
- a negative case that now passes for the wrong reason;
- an unreachable assertion;
- a fixture whose setup now supplies the expected result;
- a platform, packaging, or lifecycle risk accidentally collapsed into a unit
  test;
- a public or architecture contract mistaken for implementation detail.

For each restored or disputed contract, use a deliberate mutation or equivalent
control when it can be done safely. Prefer an isolated worktree or a focused
fixture. Never overwrite unrelated user changes merely to create a mutation.
Confirm the keeper fails for the intended reason, then restore the source
exactly.

Done when every preservation finding is restored or rejected with source
evidence.

## 7. Separate product defects

A baseline failure that survives in a valid keeper is not test-pruning evidence.
Classify it separately.

When the failure is a product defect, repair the production owner only if that
work is inside the user's requested scope. Prove the repair with a failing
control and a passing candidate on the same relevant boundary when practical.
Otherwise report it as a follow-up.

Do not delete a valid failing test merely to make the campaign green.

Done when every retained baseline failure has a classification and disposition.

## 8. Reconcile and hand off

If the branch moves during a long campaign, reconcile according to repository
and user Git policy. Do not impose merge-versus-rebase policy from this skill.

When upstream changes touch a retired test, determine whether they introduced a
new contract. Preserve that contract in the appropriate keeper rather than
blindly restoring or deleting the upstream change.

Rerun the subsystem's required Nx targets and any distinct integration, smoke,
E2E, packaging, or platform proof affected by the final shape.

Hand off with the [SKILL.md](SKILL.md) report, plus:

- baseline and final test/support line counts when useful;
- lanes, retired layers, and keeper ownership;
- preservation findings and any mutation/control proof;
- product defects discovered;
- checks run, checks skipped, and remaining uncertainty.
