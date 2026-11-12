# Limina Skill evaluations

This private workspace implements the frozen Limina Skill experiment contracts:
a local execution controller, a calibrated 26-task suite, independent grading
and reproducible reports. The controller's private records establish which
registered batches have completed. A diagnostic or partial batch is not a
complete Limina Skill score.

The runtime uses the locally installed Codex CLI with its existing ChatGPT
login and native sandbox. Project execution for grading uses a separate local
Docker container. The package has no agent-eval, Vercel service or API-key
runtime dependency. It does not install a floating Codex version, purchase
credits, enable automatic reload, or publish artifacts.

## Development checks

From the repository root:

```sh
pnpm --filter @limina/evals test
pnpm --filter @limina/evals typecheck
pnpm exec eslint packages/evals/src
```

These checks do not start model evaluations. The operator commands are
`prepare`, `preflight`, `smoke`, `run` and `report`. The presence of an
entry point does not authorize dispatch.

## Formal dispatch

The controller owns the canonical private plan outside the repository. Its
configuration contract and validation live in [formal.ts](src/controller/formal.ts).
It references the full private calibration index, the four exact runtime
profiles (base, Vue, migration and mixed frameworks), frozen technical review
evidence and any required maintainer ruling. Each evidence reference is a
canonical file path and the SHA-256 of its bytes. Include the development-only
export and its native isolation observations, the included-only billing
observation, and a separate canonical workspace-volume parent outside any Git
repository and package-manifest ancestry. Use a clean temporary parent so local
product checks cannot inherit an unrelated host package. Keep the plan, journal, outputs and raw traces inaccessible to
revision workspaces. Use the same controller and shared budget ledger throughout.

For a new controller with no prior evaluation usage, initialize its private
`budget.jsonl` once, before the first diagnostic or smoke attempt. Use exclusive
creation so the command fails if the file already exists.

```sh
node -e 'require("node:fs").writeFileSync(process.argv[1], "", {flag:"wx", mode:0o600})' "$controller/budget.jsonl"
```

For an existing controller, use its original ledger. If the file is missing,
recover the recorded history before resuming.

From the repository root, with the private config in `plan`:

```sh
pnpm --filter @limina/evals eval:smoke --config "$plan" --total-budget-usd 100 --attempts 3
pnpm --filter @limina/evals eval:run --batch development --config "$plan" --total-budget-usd 100 --attempts 102
```

After all development slots finish, the controller freezes its evidence and
decision. If the Skill is unchanged, run `--batch sealed --attempts 54`. If an
isolated revision produces a candidate, freeze it before accessing acceptance
results and run `--batch confirmation --attempts 234`. Both use the same
`--config` and `--total-budget-usd 100`. This is the **global** ceiling, never
an allowance per command. The admitted personal account uses included quota
only: every launch must have zero credit balance, an active allowance and a
maximum extra cost of zero. If these facts change, stop and retain the journal.
That maximum is a conditional dispatch-policy bound, not a measured bill.
Token completeness does not establish inclusion, paid-credit consumption or USD
settlement. Missing monetary measurements remain `null` even while included-only
execution is eligible. Unknown settlement cannot authorize paid work.

An eligible batch creates its manifest and budget projection before dispatch.
To stop new launches safely, create `STOP` in the controller's `formal`
directory. The Runner rechecks it synchronously after asynchronous preparation,
before budget reservation and slot claim. Reservation, claim and process creation
then follow without asynchronous work. A stop raised during preparation leaves
the slot `not_run`, with no reservation or model call. An already-admitted
attempt can finish capture and recording. Preserve the stop evidence and
reconcile any in-flight state before removing the marker on explicit resume.
The same command resumes the same private run. A setup or budget rejection
before launch leaves the slot unexecuted; a started slot does not disappear
after a crash. Reconcile any unfinished record against captured evidence
before proceeding. Never clear a journal or ledger to force a rerun.
Resume also requires the exact archived execution source and dependencies pinned
by that run. Updating the implementation does not authorize replacing its Runner
identity. A corrected financial report can reinterpret all conditions uniformly
under a new reporting identity while preserving their execution/grading records.
The final choice is recorded once to prevent switching branches after seeing
sealed outcomes. Reports use each private run directory and the shared ledger.
Smoke and development traces remain diagnostics until the corresponding
registered batch is complete.

### Estimated API-equivalent cost

Reports calculate a separate `estimatedCost` from captured native Codex requests,
following [CodexBar's inclusive-input algorithm](https://github.com/steipete/CodexBar/blob/20ada8abf0e4e2267aaa8c7cc9cf891cdf866838/Sources/CodexBarCore/Vendored/CostUsage/CostUsagePricing.swift).
Only explicitly selected controller runs are read, without credentials, model
requests, new dependencies or unrelated host sessions. Failed attempts and
replacements remain included. Duplicate or conflicting identities cannot inflate
consumption or become complete measurements.

The frozen [pricing snapshot](src/core/estimated-cost.ts) qualifies GPT-6.1 Terra
at its retained 2026-11-06 Standard API rates: USD 1 input, 0.05 cached input and
5 output per million tokens. The 2026-11-09 snapshot additionally qualifies
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) at USD 2
input, 0.10 cached input and 10 output per million tokens. Captured output includes
reasoning tokens. Cache reads are subtracted
from ordinary input; reasoning is already part of output. The full-request
long-context multiplier applies above 272,000 input tokens, per request.
Unknown models/tiers, unreported failed-request usage and cache writes without
observable retention remain unpriced. Partial observed sums are retained;
complete totals remain `null`. These are API-equivalent estimates at the selected
price snapshot, not subscription charges, credits deducted or actual settlement.

Normal `report` includes estimates. Reprice existing frozen runs independently:

```sh
pnpm --filter @limina/evals eval:report --estimated-cost-only \
  --run-directory "$EVAL_CONTROLLER/run" \
  --additional-run-directory "$EVAL_CONTROLLER/replacement/run" \
  --output "$EVAL_CONTROLLER/new-cost-report"
```

The additional run option is repeatable; supply every diagnostic/replacement run
within the intended scope. Reports retain manifest, journal, trace, pricing and
calculation identities. They do not rewrite journals, scores or the actual-spend
ledger, and never change the USD 100 dispatch authorization ceiling.

The public exporter accepts `--estimated-cost <estimated-cost.json> <sha256>`
after ordinary arguments. It requires the exact attempt set, including retained
infrastructure observations, and publishes only aggregate estimates. The site
labels these values **Estimated Cost**, marking incomplete coverage.

Set a new `campaign` value in the private plan when the Runner changes. It is a
single lowercase path segment such as `native-trace-v2`; runs are stored under
`formal/<campaign>/`. The campaign participates in experiment identity. Keep
earlier campaigns intact and run the complete registered sample counts under
the new identity. The shared budget ledger and `formal/STOP` remain global.

## Frozen product preparation

```sh
pnpm --filter @limina/evals eval:prepare \
  --repository /absolute/checkout \
  --output /absolute/new-controller-directory \
  --toolchain /absolute/frozen-build-toolchain.json
```

The toolchain file supplies `node` and `pnpm` objects with the native executable
path, SHA-256 and admitted version, an explicit `storeDirectory`, and
`registryMetadata: { directory, manifestSha256 }`. The metadata directory holds
`metadata-manifest.json`, an array of public npm registry cache paths and SHA-256
values, plus the corresponding files. No user configuration or credentials are
copied. The current implementation targets macOS with Node 26.13.0 and native
pnpm 12.10.1.

Preparation copies actual tracked and untracked input bytes, modes and deletion
records, and records HEAD and Git status separately. It refuses an output inside
the source checkout, including parent-directory symlink aliases. It installs
offline with a frozen lockfile and lifecycle scripts disabled, retaining the
repository's release-age and trust checks. Missing cache data fails preparation.
It then builds the tools and both product artifacts in the copied workspace and
records artifact and complete Skill identities in `prepared.json`.

The explicit package store is currently an installation input, not a portable
dependency archive. Formal preflight still requires admission and archival of
each task's full dependency closure. A successful product build does not admit
a task or authorize a model evaluation. The script is named `eval:prepare` so
ordinary package installation cannot invoke it as an npm lifecycle hook.

## Foundation preflight

```sh
pnpm --filter @limina/evals eval:preflight \
  --config /absolute/controller/preflight.json \
  --output /absolute/controller/new-evidence-directory
```

The configuration follows `FoundationPreflightConfig` in
`src/controller/preflight.ts`. It contains canonical controller, prepared-input
and runtime-bundle paths; the original authentication-home locator; exact
Codex, Code Mode host, Node, pnpm and Docker binary identities; and the isolated
Docker endpoint, empty client configuration directory and immutable image ID.
The authentication-home locator is a path, never credential content. Keep this
machine-specific configuration and all raw evidence outside the repository.

The command rechecks frozen source and product bytes, the complete Skill,
tool identities and the runtime dependency bundle. Three native sandbox probes
test protected-path reads through direct commands, a symlink and an independent
runtime, with authorized workspace writing as a positive control. Only a
non-secret canary is placed in the credential directory. Read-only CLI RPCs
check ChatGPT authentication, Terra High availability and included allowance;
the command does not dispatch a model.

An actual unprivileged Docker process checks read-only tools, disabled network,
absent credentials and management socket, and the dependency tree against the
host bundle. Both trees must contain identical regular-file bytes and modes,
directory modes and relative link targets. Symlink permission bits are excluded
from this cross-platform identity because the operating systems define them
differently. Runtime files must be readable by UID 1000; image construction must
preserve that access while the verifier root filesystem stays read-only.

Each invocation uses a new private evidence directory and stops at the first
failed phase. Prior failures remain intact. A successful foundation report has
`formalDispatchAuthorized: false`: it establishes local capabilities, not task
calibration, sealed-set isolation or permission to start a comparison batch.

## Current implementation boundaries

- `src/core/task.ts` defines task-specific mutation, installation and dependency
  policies. `mutation.ts` validates complete S0/S1 differences before execution.
  A writable manifest does not authorize lifecycle hooks or new dependencies.
  All YAML documents in a pnpm 12 lock stream participate in dependency identity.
- TaskSpec v2 freezes capture exclusions and required state roots. Exclusions
  are limited to declared runtime caches or dependency directories, cannot
  overlap fixture inputs, protected or writable project paths, dependency
  inputs, required artifacts or the Skill tree, and participate in execution
  and grading identity. S0 and S1 must use exactly that policy; a matching pair
  of under-captured snapshots still cannot pass. Tasks about cache behavior
  must retain the relevant cache as required state. Generated delivery output
  such as P01 `dist` remains captured and checked, not silently discarded.
- `reconstruction.ts` rejects unsafe mutations before preparation, checks rebuilt
  S0, replays accepted changes and compares the result with S1. Docker accepts
  only a reconstruction handle and checks it again before transfer.
- `snapshot.ts` records actual files, modes, binary content and links without
  consulting Git or ignore files. Incomplete capture cannot become an empty
  successful diff. `outcome.ts` preserves known execution failures separately
  from capture, mutation and assertion outcomes.
- `runner/local-codex.ts` fixes model, reasoning, speed and permission settings,
  verifies the executable and Code Mode host identities, and reads account/model/Skill metadata
  through the CLI. The authentication file is neither read by the controller
  nor copied. Each client uses a fresh private HOME and CODEX_HOME, delegating
  only the canonical authentication file. Host instructions, configuration,
  skills and plugins are not copied; the delegate is removed after client exit.
- `runner/attempt.ts` records execution evidence continuously and attempts final
  capture on failure. Native Skill discovery must match the selected treatment;
  host Skill paths are disabled without changing the user's configuration.
  All invocation overrides are parsed in an empty authentication home before
  a model attempt can reserve budget.
  Native prompt inspection rejects unexpected AGENTS instruction messages
  before reservation and does not inherit the attempt's trace writer.
  The native execution profile makes the workspace `.agents` tree read-only,
  protecting the installed Skill treatment while project files remain writable.
- `runner/native-trace.ts` checks the pinned CLI schema-2 raw tool trace, session
  continuity, tool/inference pairs and usage against stdout totals. Missing
  payloads, session changes and incomplete usage prevent acceptance and dispatch.
  New captures also reject AGENTS instruction injection; historical reads keep
  their original contract. Inspection rollouts are separate from model rollouts.
  This internal trace interface is version-specific; upgrades need readmission.
- `runner/task-workspace.ts` installs only a TaskSpec-authorized frozen runtime
  and controller-declared relative workspace links. It checks bundle identity,
  copy integrity and link boundaries, and installs the complete Skill before S0.
  The Runner protects root and package-local dependency directories and rechecks
  their identity after final capture. Formal dispatch must consume the returned
  runtime-integrity status; unknown integrity cannot be treated as a pass.
  Verifier reconstruction replays the frozen Skill state but never copies Agent
  dependencies.
- `runner/workspace-volume.ts` currently supports macOS APFS work volumes.
  The task lives in a volume subdirectory, keeping OS volume-root metadata
  outside the project without adding a capture exclusion.
  Detachment and read-only reattachment revoke writes through previously opened
  descriptors. Renaming a directory or setting immutable flags is insufficient.
  Failed freezing produces unknown state rather than a live-directory fallback.
- `runner/docker-verifier.ts` executes project code as UID 1000 with a pinned
  image, read-only root filesystem, no network, no capabilities and no host
  mounts. The frozen Docker identity selects a 1024 MiB default or 2048 MiB
  memory limit; all compared conditions for a task use the same limit. The
  runtime-only preflight byte limit is 512 MiB; project capture limits remain
  separate. It returns command observations, not grading decisions. Grader
  assertions and final result storage remain outside the container. pnpm commands
  use the pinned native binary through `with current`, preventing automatic
  manager selection from project manifests. Controller flags disable pnpm's
  implicit pre-run installation and require offline operation with installation
  scripts ignored; the same settings propagate to nested commands. This applies
  to the already-admitted verifier closure, not repository-wide dependency
  policy. Explicit installation plans additionally require a frozen lockfile.
  Local Codex receives the same package-manager defaults in its controlled
  environment and shell configuration. Agent-side environment values are not
  the trust boundary: native sandbox restrictions and verifier revalidation
  remain mandatory.
  A monotonic grading deadline is shared across reconstruction, container start
  and commands in the calibration controller. Commands receive only remaining
  time; a late successful return cannot pass. Timeout classification checks
  the Docker client's killed flag even when it exits zero. Cleanup closes
  dispatch, waits for pending client operations and removes the named container;
  command observations survive errors. Formal dispatch must use the same
  deadline ownership when it is connected.
- `core/budget.ts` maintains one durable ledger, limits concurrency to one and
  retains unknown usage. The total additional-spend ceiling is USD 100 with at
  least USD 15 reserve. The current Runner admits included allowance only,
  requires zero purchased-credit balance and stops when allowance is unavailable.
  A subscription price is never used as a per-task USD conversion.
  Token completeness and monetary evidence are independent. Legacy `included/0`
  records are read as unverified financial classifications without rewriting the
  journal. Actual settlement requires independently sourced `financialEvidence`
  (invoice or provider-settlement source, observation time and evidence SHA-256).
  Later financial evidence is appended; complete token measurements remain
  immutable. Reports distinguish observed sums, unknown records, actual totals
  and conditional authorization bounds. An unknown actual total or actual
  remaining budget stays `null`. Settings and native quota observations retain
  their own timestamps; refreshing quota does not refresh an old reload-setting
  observation. Fresh included-only reservations require an eligible personal
  plan, zero credits and unlimited credits disabled.
  Candidate admission uses its independent included-only reservation and complete
  captured usage and trace; it does not require a monetary `included` label.
  A finalized partial usage record can authorize further included-only work
  only under that zero-paid bound; it cannot authorize a paid reservation.
  An attempt with no final usage record still blocks concurrent dispatch.
- `core/experiment.ts` preregisters all 3 smoke, 102 development, 54 sealed or
  234 three-condition confirmation slots. It fixes independent repetitions and
  seeded condition order within each task/repetition block. Execution, grading
  and comparability identities are separate; only the declared Skill treatment
  is omitted from natural-condition comparability. Public sealed metadata
  contains IDs and domains only.
- `core/run-store.ts` journals starts and results with a durable hash chain.
  Resume preserves the exact plan and refuses an unresolved in-flight attempt.
  Only a recorded infrastructure failure with intact evidence can receive one
  replacement. Agent failures are retained without retry. Missing or changed
  artifacts cannot preserve a previous pass; unexecuted slots remain `not_run`.
- `core/report.ts` aggregates each task before each domain, weights the eight
  Limina domains equally and reports negative controls separately. Comparisons
  use matching valid blocks and expose every excluded pair. Unknown evidence or
  unexecuted slots makes the report provisional. Diagnostics, infrastructure
  replacements and failed attempts remain in global usage and spending totals.
- `tasks/I01.ts` and `graders/I01.ts` implement the representative initialization
  task. Its TaskSpec permits package scripts and targeted tsconfig edits while
  preserving sources and dependencies. Its config permission admits static data
  declarations before execution. The Grader uses the fixed product and compiler,
  checks the full workflow, and injects a real type error; it does not trust a
  project's test script or the Agent's claimed result. Grader command failures
  remain separate from task failures.
- `tasks/N01.ts` and `graders/N01.ts` implement the ordinary TypeScript repair
  negative control. The project configuration remains fixed; the Grader runs
  the pinned compiler and tests the emitted function on normal, empty,
  whitespace, punctuation and non-ASCII inputs. Compilation alone is
  insufficient, and the task prompt contains no Limina instruction. Normal
  compiler output at `dist/greet.js` is captured and authorized; forged output
  cannot repair broken source because grading recompiles it. Other files or
  installation hooks in that directory remain unauthorized.
- C01 activates an existing graph rule without changing its source relation or
  governance. The Grader queries the exact standalone invocation and requires
  a denied-reference diagnostic for the intended import, then checks an
  independent allowed relation. A nonzero exit alone is insufficient.
- C02 repairs default-entry selection and nested solution naming while retaining
  four named leaf environments and source coverage. R03 restores a solution's
  explicit closure while preserving an excluded direct entry. Both freeze auto
  entry exclusions, check actual generated ownership, and inject independent
  source diagnostics through `checker build` and the pinned compiler. Pure
  TypeScript `checker typecheck` can be disabled and is not used as this evidence.
  Correct directory references and reordered JSON remain valid; missing closure,
  flattened solutions and fabricated generated manifests cannot earn a pass.
- I03 diagnoses an invalid nearest manifest without initializing an ancestor.
  Its current edition distinguishes the requested invocation directory, nearest
  manifest and successfully resolved governance root; blocked resolution leaves
  no resolved root. Only the diagnosis may change, and generated initialization
  state stays captured. Independent product probes validate rejection and
  preservation, separately from the Agent's report and investigation evidence.
  K03 diagnoses a missing Vue checker without unauthorized installation or
  checker substitution. Both require an explicit diagnosis and independently
  reproduce the blocker using the fixed product; doing nothing cannot pass.
- K01 checks separate TypeScript and Vue ownership with real checker builds,
  a TypeScript assignment error and a Vue template error. Plain tsc is an
  independent negative control for template coverage. Its admitted runtime
  uses a fresh, image-populated, read-only dependency volume at the project
  path; it does not change K03's intentionally absent peer. Preflight checks
  mounted bytes, denied writes/replacement and native dependency protection.
- S01 authorizes a finite set of exact manifest dependency states backed by
  the same admitted closure. Actual source checks distinguish a declaration
  at its source owner from root-only declarations; builds and runtime checks
  also preserve behavior. Redundant root declarations cannot earn a pass,
  and unadmitted versions, hooks and source removal are rejected before grading.
- S02 requires a public package import and preserved provider delegation. A
  cross-package relative import can compile and run yet fail source governance;
  copying the provider implementation fails a changed-provider runtime control.
  Formal preparation creates the declared workspace links before S0.
- P01 repairs the generation input for package exports and delivers rebuilt
  output. Both source and output manifests participate in dependency validation.
  The Grader removes submitted output before building, compares submitted files
  with fresh output, runs Limina package checks and tests separate Node and
  TypeScript consumers, including a deliberately invalid typed call. A green
  package boundary check alone cannot establish correct exports.
- P02 resolves workspace/catalog protocols in a delivered distribution manifest
  while preserving source declarations. Actual pnpm archives are consumed by
  Node and TypeScript outside the workspace. Removing a packed transitive
  dependency must break both consumers; no workspace fallback can earn a pass.
- T01 repairs native configuration loading while preserving a CommonJS package
  and the original configuration bytes. Both supported ESM filename treatments
  are calibrated; the Grader also checks an independent CommonJS consumer.
- T03 retains a real previous-success manifest across a failed configuration
  load. It checks the diagnosis, a fresh graph/checker run, a real compiler error
  and recovery after another failed load. All relevant cache state is captured;
  retaining or cleaning the old manifest are both valid when the config is fixed.
- R02 selects the intended local built declaration through actual export
  conditions. Native TypeScript resolution, generated references, real checker
  builds and Node consumption distinguish the built API from the newer source
  API. Local presence alone does not imply a source reference.
- W02 separates internal declarations from managed user output, preserves source
  during cleanup, compares delivered files with a fresh build and exercises
  runtime/type consumers, including copied local declarations. Its bounded
  script grammar accepts directory aliases and quoted config paths but rejects
  command separators; it never turns multiline shell text into one command.
- W03 previews migration without changing project inputs. The Grader runs the
  frozen public migrator, compares the complete project state before and after
  preview, and checks the report against the actual plan and isolated input.
  Preview completion cannot be reported as an applied or disk-validated migration.
  Migration audit files remain in capture scope even when Git ignores them.
- `tasks/index.ts` exports the implemented development task definitions. Task
  and Grader source identities remain independent of registry additions.
- `controller/revision-export.ts` revalidates all 17 development tasks and
  frozen product/Skill inputs before exporting public documentation, fixtures,
  prompts and allowlisted development diagnostics. It copies no Grader source,
  reference solutions, raw traces or Git history. Outputs cannot inherit a host
  Git repository or overlap protected storage; mutation invalidates the export.
  Native isolation probes cover direct/parent paths, aliases and Git objects,
  protected controller/authentication paths, local networking and Docker IPC.
  Any revision must use a fresh, development-only session. Candidate admission
  requires the original export, trusted start/final snapshots, a Skill-only
  patch and a separately budgeted native trace before the candidate is frozen.
- `controller/calibration.ts` executes reference and incorrect repairs in fresh
  verifier containers, preserving F0/S0/S1, command observations and expected
  outcomes. Calibration is explicitly not an Agent attempt. Admission rechecks
  task/Grader/framework code, the dependency and image identities, snapshot
  integrity and every expected negative result; a green receipt alone is
  insufficient. Changes to shared mutation or grading code invalidate receipts.
- `controller/suite.ts` requires all 26 admitted tasks before freezing any
  formal batch, including smoke. Sealed task, Grader and reference code must
  reside in the separate controller store. This file-boundary gate does not
  establish Skill revision process, mount, tool or network isolation; those
  runtime checks remain required before formal dispatch.

## Reporting stored runs

```sh
pnpm --filter @limina/evals eval:report \
  --run-directory /absolute/controller/frozen-run \
  --budget-ledger /absolute/controller/budget.jsonl \
  --output /absolute/controller/new-report-directory
```

Reporting revalidates the frozen manifest, append-only journal and referenced
evidence. Recorded attempts must match the shared budget ledger and its token
measurements; proven setup failures before dispatch can have no reservation.
Later settlement uses the ledger's current values without rewriting attempts.
The batch pins the canonical ledger and its initial byte prefix. A different or truncated ledger is rejected; valid appends remain visible. The report identifies the calculation source and exact journal of expenses used. It writes `report.json` and `report.md` without model calls. The export
contains allowed aggregates and task IDs, not prompts, hidden Grader code,
reference solutions or raw tool payloads. Sealed aggregates remain controller
data and must not be given to the same round's Skill revision process.
Financial interpretation has its own recorded source hash. Historical zeroes
derived only from `turn.completed` are not dollar receipts. A report may have
complete execution/grading evidence and still have `financialProvisional: true`;
its monetary total and actual remaining budget then remain unknown. The
remaining authorization shown for a zero-paid-bound policy is a different
quantity. Per-thread credits and dollar observations may be unavailable for the
account; no API prices or subscription-price allocation fill those gaps.

Per-task pass rates include known Agent errors and timeouts as failures, with
Wilson 95% intervals. Skill Lift is the difference on matching valid blocks in
percentage points. Regression is the joint fraction of those blocks where Base
passes and the treatment fails. The macro interval uses a fixed-seed 10,000-draw
hierarchical paired bootstrap: resample tasks within each domain, then paired
repetitions within each sampled task, retaining equal domain weights. Missing
domains produce an unknown macro rather than renormalizing the observed subset.
The preregistered three repetitions remain exploratory even if an interval
excludes zero; the report never claims significant improvement.

The report separates development, sealed and negative-control results. Safety
is shown for selected slots and for all recorded attempts, including replaced
infrastructure attempts. Per-condition time and usage include failures and
replacements. Cached input is a subset of input, not an additional token count.
Measurements distinguish observed sums, missing counts and complete totals;
missing values never become zero. The shared ledger includes earlier diagnostics
as well as the reported batch, preserving included, pending, settled and unknown
categories separately from USD estimates and actual settlement.
An explicit `inference_failed` event closes its inference lifecycle, while its
unreported tokens remain unknown. The trace still requires every tool and
inference to have a valid terminal event and every referenced payload to exist.
CLI-reported partial counters remain observed sums with `incompleteCount`;
their complete totals stay `null`. Known Agent errors, timeouts and incomplete
final project state retain their separate failure semantics. Smoke requires
complete token coverage; development and final comparisons can report partial
usage under the admitted included-only bound without inventing measurements.

## Acceptance and interpretation

The local OAuth/native sandbox/Docker chain has real execution evidence.
Each new Runner identity requires its three independent formal smoke conditions
and registered comparison batches before it can support a result. Smoke checks
execution, capture, grading and usage; it does not measure Skill Lift. Each
formal batch still rechecks runtime admission, isolation, frozen inputs and
calibration identities before dispatch. Preserve failures and diagnostic usage
in the same evidence store and budget ledger.

The suite retains 24 Limina tasks and two negative controls, split into 17
development and nine sealed acceptance tasks. The historical V1 calibration
covers 207 correct and incorrect repairs, including 122 development cases.
All nine sealed definitions and their calibration/admission records reside in
controller-private storage. Calibration uses no model and is not an Agent
attempt. Shared pipeline or verifier resource changes invalidate prior receipts
and require recalibration. Sealed task text, Graders, reference solutions and
historical scores must remain outside the Skill revision environment, its Git
history, tools, credentials and network access.

M3 retains the preregistered Base/current Skill/candidate Skill comparison and
sample counts. Finish the 102-slot development batch before freezing its
evidence-based retain/revise decision. A retained Skill leads to 54 sealed
slots; a revised Skill leads to a fresh 234-slot comparison. Freeze any candidate
before sealed evaluation and keep acceptance results out of same-round revision.
Stop at allowance or budget limits and mark remaining slots `not_run`; partial
results remain provisional. Only the completed batch's validated report can
establish its observed pass rates, regressions and costs.

## Versioned model campaigns and V2

Each model/stage has its own immutable experiment and RunStore. A campaign provides a seeded, balanced block schedule, a frozen roster and a common task bank; every attempt uses the original shared budget ledger. V1 task/Grader sources and historical JSON exports are not rewritten. The campaign API is additive; legacy commands continue to read their original manifests. V2 dispatch requires a campaign with a frozen model profile; a V2 plan cannot enter the legacy single-model execution route.

Create profiles with core/model-profile.ts from the exact pinned binary's bundled catalog, then verify current account availability during operator preflight. A catalog entry is not execution admission. Profiles freeze reasoning, requested default tier, context/compaction limits and instruction/capability digests. Different native templates prevent strict comparisons; native-profile campaigns still report within-model Skill effects. Never infer a backend tier or silently switch models.

The campaign configuration is private JSON: version 1, admission (canonical file and sha256 of the existing formal plan), directory (a new directory within sealedStore), profiles (complete frozen ModelProfile objects), and comparability (strict or native-profile). The formal plan selects bankRevision v2 and the calibrated sealed-v2 root. For V2 model dispatch it also references taskCalibration: a hashed independent review with matching bankId, status passed, referenceAccess false, reviewerMode independent, and exactly 26 passed task entries, each with hashed evidence. Grader calibration never writes this approval.

Operator commands, from the repository root:

```sh
pnpm --filter @limina/evals eval:prepare-bank --source-store "$V1_STORE" --output "$V2_STORE" --prompts "$PRIVATE_PROMPTS"
pnpm --filter @limina/evals eval:calibrate --bank v2 --config "$CALIBRATION_PLAN"
pnpm --filter @limina/evals eval:campaign --stage freeze --config "$CAMPAIGN_CONFIG"
```

prepare-bank copies the nine private tasks and their declared source/Grader closure, including module identity and generated fixture inputs, into a new store and requires nine separately authored prompts. The calibration plan contains version 1, repository, sealedStore, a new private output, and the four existing reviewed runtimes. Calibration runs isolated Docker graders without models, produces bank.json and suite-calibrations.json, and writes task-review packets containing only task inputs and permissions. The 17/9 split, eight main domains and two controls are unchanged. V2 revisions do not turn published V1 instances into unseen tests.

V2.1 is a separate bank edition. TaskSpec remains schema version 2; the revision, complete task/Grader inputs and resulting bank ID distinguish V1, V2 and V2.1. Select it explicitly; unknown revisions fail rather than falling back. Prepare a fresh private root from V2:

```sh
pnpm --filter @limina/evals eval:prepare-bank --bank v2.1 --source-store "$V2_STORE" --output "$V21_STORE" --prompts "$V21_PRIVATE_PROMPTS"
pnpm --filter @limina/evals eval:calibrate --bank v2.1 --config "$V21_CALIBRATION_PLAN"
```

Preparation preserves the preceding sealed source closure and adds the new wrapper's ESM metadata. It does not author revised sealed scoring: the private-store maintainer must place that edition's reviewed task/Grader modules in the new root before calibration. Keep all sealed definitions, references and cases outside the repository and review-only inputs. Calibration still covers all 26 tasks and all positive, incorrect and unauthorized cases. Independent review gets only prompts, F0, permissions and the declared prepared tool environment. Counterfactual runtime/cwd controls have separate recorded identities and never replace the primary task environment or add formal samples.

V2.1 defines observable ownership and delivery boundaries, public report field types and permissible equivalent forms. Scoring keeps independent native commands, consumers, freshness, strictness and failure propagation; an implementation spelling alone is not a substitute for these observations. Reviewers freeze submissions before private grading, and receive no private grading feedback. A failed or ambiguous review remains in the evidence; it cannot be converted to a passed admission by choosing a later favorable record.

V2.2 is an additional complete-bank edition. It preserves earlier definitions and requires a new private Sealed store, all 26 calibrations and a matching independent input review. The public development registry alone is never a complete Bank. Preparation and offline calibration use:

```sh
pnpm --filter @limina/evals eval:prepare-bank --bank v2.2 --source-store "$V21_STORE" --output "$V22_STORE" --prompts "$V22_PRIVATE_PROMPTS"
pnpm --filter @limina/evals eval:calibrate --bank v2.2 --config "$V22_CALIBRATION_PLAN"
```

The [V2.2 definitions](src/tasks/v2_2/index.ts) retain the 17/9 split and two controls. W02 accepts bounded, valid positional config entries while executing internal and user builds separately, checking delivered bytes, consumers and clean/rebuild. S01 explicitly assigns the production TypeScript dependency to the app; root-only and duplicate declarations remain invalid. I01 executes the submitted workflow before and after a source error. K01 tests TypeScript and Vue diagnostic coverage without requiring a particular checker allocation. S02 accepts public re-exports and validates the public number API with an independent compiler. K03 normalizes relative root-directory reports. P01 accepts equivalent root and nested conditional exports while retaining actual consumers; an isolated type-condition consumer prevents runtime-entry fallback from hiding a missing declaration target. R02 requires both the native consumer compiler and actual Checker to reject the same declaration-consumer error. Positive equivalence cases retain disabled checks, unsafe mutation, forged output, wrong ownership and dependency changes as counterexamples.

Scratch permission is explicit in development prompts. `capturePolicy.requiredRoots` describes paths to capture if present, not an obligation to create every path. Protected source perturbations performed by the Grader occur only in disposable reconstructed verifier projects; they never authorize the solver to modify protected inputs. A diagnostic report establishes the requested assessment, not an engineering repair or proof that the solver ran every Grader probe.

New shared controller code changes calibration/Runner identity even when an old task definition is unchanged. Strict private historical replay requires its archived controller closure; existing public reports retain their original identity and contract. The live dashboard compares complete stages from the exact published Bank and the same Campaign/Model Profile. Archived current-task selection summaries remain readable, but their cross-source substitutions do not enter live Base/Skill differences. Offline calibration and independent review do not establish model discrimination or a causal Skill gain.

The prepared pnpm entry applies fixed no-install arguments to run/exec and nested PATH-based calls. Its generated script is read-only and lives under excluded runtime state; the pinned native executables remain unchanged. Direct installation commands are rejected before invoking pnpm. This prevents accidental implicit installation, not hostile direct-binary bypass. A new Runner identity is required, and native sandbox/preflight/smoke acceptance is still separate from offline tool tests.

Shared calculation and calibration source is identity-bound. Preserve the archived source closure as well as V1/V2 records before changing it. The current reader never silently re-admits an older calculation under changed code; immutable historical public JSON remains readable, while strict private replay uses its archived source. New bank/calculation identities do not overwrite earlier snapshots or failure records.

After separate authorization for live evaluations, use eval:campaign with stage smoke, pilot, development, sealed or confirmation, total-budget-usd 100 and the complete roster-wide attempt count. Per model counts are 3, 18, 102, 54 and 234 respectively. All stages require smoke except smoke itself. The nine-task pilot covers each main domain and N01 once per arm, remains separate, and cannot establish significant improvement. Final stages require one frozen development-only decision across all roster models; finalDecision references a private receipt binding campaignId, retain/revise, frozenAt and one hashed existing decision per profile. Decisions cover every Smoke-admitted model and list all others in notAdmittedProfileIds; excluded profiles need no invented development decision. All participating model decisions use the same cutoff and candidate Skill. No sealed execution begins before all required development decisions are admitted.

V2 smoke requires all three conditions to pass with complete model, usage and grading evidence. A hashed journal-prefix completion receipt gates later stages; a failed profile stays in the roster as not admitted while passing profiles may proceed. The immutable stage schedule balances positions among admitted participants and retains the full planned roster. Campaign preparation/dispatch locks prevent competing controllers. Interruptions retain in-flight state; reconcile it from independent evidence before explicitly resuming. V2 determinable slots require verified model/configuration evidence. When that evidence is missing, the assigned slot stays unknown while its raw Agent failure, usage and attempts remain recorded. Unknown token or settlement data remains unknown; retries and diagnostic usage stay on the shared ledger. New profiles do not receive fresh USD 100 pools.

For a campaign report, eval:report --campaign --config reads a private JSON file with campaignFile, stage, runs (profileId, canonical directory and budgetFile per admitted model), a fresh output, and optional candidateDigest. It produces report.json, source-index.json and a read-only ledger-snapshot.jsonl with no dispatch authority. Journal and attribution prefixes are fixed at report generation, so later append-only work does not rewrite the report. Report reading never creates or starts a run. Publish only an explicitly selected report using:

```sh
node --import tsx scripts/docs/export-evals.ts --campaign "$REPORT_DIRECTORY" "$SOURCE_INDEX_SHA256" "$NEW_CAMPAIGN_JSON"
```

NEW_CAMPAIGN_JSON must be the campaign ID, stage and report-identity filename (campaignId-stage-reportIdentity.json) in the docs theme's evals-campaigns directory. The exporter invokes the package-owned public-report reader through a read-only JSON process boundary, then registers the immutable snapshot in evals-campaigns.json. Private verification and public field selection stay inside the Evals package. The page consumes public JSON through its own view contract rather than importing controller code. It never invokes the runner. Report identities allow an incomplete and a later complete report for the same campaign/stage to coexist without overwriting either snapshot. Public data contains independent statuses, coverage, bounds, paired regressions and minimal activation/attribution summaries. Only a bound admission source can mark a model not admitted; omitted run data is missing and retains its planned count. It excludes prompt, Grader, reference, raw trace, account, evidence-path and actual-charge guesses.

To add measurements to an existing frozen campaign without dispatching models or reading the live ledger, create a new report from the pinned source index:

```sh
pnpm --filter @limina/evals eval:report --campaign \
  --directory "$FROZEN_REPORT" \
  --source-index-sha256 "$SOURCE_INDEX_SHA256" \
  --output "$NEW_REPORT_DIRECTORY"
```

Reanalysis validates the old report against its exact manifest, journal and attribution prefixes, admission evidence and ledger snapshot before attaching measurements. Already-measured reports first replay using their original reviewed pricing identity; unknown or conflicting price snapshots are rejected. New measurements then use the current frozen pricing snapshot. It records the original index/report hashes and calculation identity and writes a new calculation/report identity. Existing reports, snapshots, grades and ledger entries remain unchanged. A historical report that cannot be reproduced is rejected, even if its byte hash is correct.

Campaign measurements include every physical execution, including failures, unknowns and infrastructure replacements. Duration and API-equivalent cost first average measured attempts within each task/condition, then give available cells equal weight. Main tasks and negative controls are separate; model-row means combine Base and Skill. Agent time and end-to-end time are distinct. Measurement coverage counts complete observations over physical executions, with measured/assigned task-condition cells also retained. Missing values never become zero: partially priced traces contribute only to observed subtotals, not complete-attempt means or complete totals. Actual settlement stays separate. Frozen pricing/calculation identities and private per-attempt trace hashes bind estimates to the execution set; only aggregate measurements enter public JSON. Models without formal admission retain N/A results and measurements.

An offline grading recovery uses `RunStore.reviewGrading` to append a `grading_review` event after the original attempt has finished. It accepts only `grader_error`, matching frozen task/setup/toolchain identities, intact original snapshots and model evidence, a same-input offline proof with zero model calls and the original grading deadline, and a complete assertion/command receipt. The adjudication may pass or fail; known Agent failures cannot be reviewed into success. It preserves the original journal prefix, assertion file, run ID, usage, timing and execution count. Review artifacts and elapsed time are separate controller evidence. Historical source indexes continue to pin the old journal prefix; publish a fresh Campaign report to select the adjudication without overwriting an older snapshot. No model retry or budget reservation is involved.

Activation separates installed, discoverable, discovered, skillRead, referenceReads and followed. The private trace capture also retains both native skills/list observations and their workspace/profile scope, so discoverability can be audited independently of a content read. Complete successful tool reads may prove reading; merely listing a path or passing a task cannot. Attribution is independently appended by eval:attribute --run-directory --input, with an existing runId, rubricDigest, controlled causes, private evidence references, confidence and adjudication. Neither diagnostic changes assigned arms or scores. Three repetitions are limited stability evidence, never pass@k or a large independent sample.

### Latest-bank data for the docs page

The docs page uses the latest-bank summary to identify the current task bank. The v2.2 snapshot records offline calibration and independent frozen-submission counts from the hash-pinned controller admission. Correctly rejected repairs and unauthorized changes count toward offline calibration. Historical task banks, public result snapshots and failed evidence remain archived.

For a detailed independent-review bundle (index version 1), use the repository exporter:

```sh
node --import tsx scripts/docs/export-evals-calibration.ts \
  --evidence-root "$CALIBRATION_EVIDENCE_ROOT" \
  --source-index-sha256 "$CALIBRATION_INDEX_SHA256" \
  --output docs/.vitepress/theme/evals-latest-bank.json
```

The evidence root contains `coordinator/final/evidence-index.json`. The exporter checks the index hash and each referenced file before writing an immutable `evals-calibrations/<bankId>-<publicationIdentity>.json` and atomically replacing the latest pointer. It reads evidence without invoking a Grader, model, account or budget operation. The public summary contains allowlisted counts, statuses and provenance hashes. Prompts, assertion names, solutions, traces, review narratives and evidence paths stay private.

The bilingual model table uses complete campaign stages for the exact current Bank Identity. The table shows its pending row until that Bank has complete model results. The archived calibration snapshot contains the task-level offline results.
