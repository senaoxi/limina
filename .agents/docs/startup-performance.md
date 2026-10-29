# Startup performance acceptance

[English](./startup-performance.md) | [简体中文](./zh/startup-performance.md)

The measured implementation improves startup on the repository workload, but neither target is met: cold 67.364 s versus 35 s, hot 30.356 s versus 15 s. This record covers one initial optimization and two additional evaluations. Complete acceptance is not green: the unchanged dependency tooling gate also fails, as detailed below. Do not treat this local acceptance record as a performance guarantee for other workspaces. [Lifecycle](./lifecycle.md) and [semantics](./semantics.md) retain ownership of reuse and authority contracts.

## Reproduction boundary

Measured on 2026-10-29/30 with Apple M1 (8 CPU cores, 16 GiB), macOS 27.0.1 / 26A434 arm64, Node 26.13.0, pnpm 12.10.1, TypeScript 6.0.3, Vue 3.5.43, vue-tsc 3.2.4 and tsx 4.23.15. Baseline is clean `main` at `dbefa8d5210539f730749bd3d0557915c32180df`; optimized source is the change containing this record. The source CLI entry is selected by the repository launcher.

Each round uses the entire root `pnpm check --force`, followed by `pnpm check` in a new process, five pairs after a separate excluded full prewarm. Force bypasses the complete Limina analysis model; OS file pages, tsx and independent Checker caches remain. No governance scope, required validation or command is removed. Start/end source hashes guard every formal sample. All attempts and slow samples remain recorded. The default root workflow retains its existing disabled `checker:typecheck` task; the separate required `pnpm run typecheck` command was actually executed and passed.

The primary boundary is external pnpm start to `graph:materialize.completedAt`; cache read/qualification before the task timer is included. End-to-end uses a monotonic clock. The internal graph task is shown separately. Darwin `wait4.ru_maxrss` is a job/process high-water observation, not simultaneous summed process-tree RSS. CPU profiles and metric-enabled diagnostics are separate from timing samples.

The host was on AC power without a reported thermal warning, but was not idle or dedicated. An existing Node gateway consumed roughly one core, and browser/compiler activity varied. Cross-batch comparisons therefore cannot establish small causal improvements or regressions from medians alone. No background service was terminated and no samples were discarded.

## Complete measurements

Positive percentages mean lower time than baseline; RSS is absolute. Every row contains five runs.

| Round    | Mode | Reference Graph seconds: median (min–max) | Improvement from baseline | End-to-end seconds: median (min–max) |    RSS MiB: median (min–max) |
| -------- | ---- | ----------------------------------------: | ------------------------: | -----------------------------------: | ---------------------------: |
| baseline | cold |                 126.298 (123.532–130.231) |                     0.00% |            209.085 (204.469–212.565) | 4569.406 (4326.969–4601.984) |
| baseline | hot  |                    38.330 (38.111–40.655) |                     0.00% |            108.868 (108.563–112.535) | 2760.578 (2729.469–2789.156) |
| round1   | cold |                    80.914 (78.724–81.722) |                    35.93% |            162.560 (159.898–165.431) | 4675.375 (4174.859–4800.234) |
| round1   | hot  |                    30.389 (30.100–30.498) |                    20.72% |            106.312 (104.173–111.588) | 2937.719 (2775.375–3127.656) |
| round2   | cold |                    73.398 (69.486–74.387) |                    41.89% |            166.328 (154.281–172.318) | 3962.625 (3862.516–4101.719) |
| round2   | hot  |                    32.027 (30.991–37.079) |                    16.44% |            117.207 (110.907–125.456) | 2689.344 (2492.234–3159.812) |
| round3   | cold |                    67.364 (64.642–67.426) |                    46.66% |            149.591 (143.455–152.677) | 4159.000 (4107.688–4208.688) |
| round3   | hot  |                    30.356 (30.240–31.564) |                    20.80% |            103.642 (101.359–110.720) | 2933.250 (2854.516–2977.984) |

The final target gaps are 32.364 s cold and 15.356 s hot. Final end-to-end changes are 28.45% cold and 4.80% hot improvement; negative values denote regression.

Each cold/hot pair retains identical source hashes. Both retained optimization batches also retain identical cache-index digests across each pair. The baseline did not capture per-sample index digests; its hot restoration is established by the separate diagnostic, not retroactively invented digest evidence.

Phase medians below are seconds. Overlapping task durations are not additive, and snapshot publication also contributes to end-to-end time.

| Round / mode    | Graph task | Startup and reading | checker:build | graph:check | proof:check | source:check |
| --------------- | ---------: | ------------------: | ------------: | ----------: | ----------: | -----------: |
| baseline / cold |    124.690 |               1.637 |        46.853 |      17.784 |      18.318 |        5.204 |
| baseline / hot  |     26.242 |              12.114 |        63.286 |       7.100 |       7.639 |        5.223 |
| round1 / cold   |     79.304 |               1.640 |        46.987 |      18.024 |      18.560 |        5.094 |
| round1 / hot    |     19.397 |              10.983 |        68.938 |       7.009 |       7.516 |        5.274 |
| round2 / cold   |     71.460 |               1.797 |        50.451 |      18.422 |      19.061 |        5.431 |
| round2 / hot    |     20.260 |              11.591 |        74.565 |       7.132 |       7.687 |        5.696 |
| round3 / cold   |     65.613 |               1.631 |        46.311 |      17.361 |      17.880 |        5.254 |
| round3 / hot    |     19.272 |              11.172 |        66.051 |       7.091 |       7.628 |        5.218 |

Observed adjacent-batch changes follow; positive means lower, negative means regression. The last batch has no retained production-code change and is not evidence of another optimization gain.

| Adjacent batch / mode    | Graph improvement | Graph task improvement | End-to-end improvement | checker:build improvement | RSS reduction |
| ------------------------ | ----------------: | ---------------------: | ---------------------: | ------------------------: | ------------: |
| baseline → round1 / cold |            35.93% |                 36.40% |                 22.25% |                    -0.29% |        -2.32% |
| baseline → round1 / hot  |            20.72% |                 26.08% |                  2.35% |                    -8.93% |        -6.42% |
| round1 → round2 / cold   |             9.29% |                  9.89% |                 -2.32% |                    -7.37% |        15.24% |
| round1 → round2 / hot    |            -5.39% |                 -4.45% |                -10.25% |                    -8.16% |         8.45% |
| round2 → round3 / cold   |             8.22% |                  8.18% |                 10.06% |                     8.21% |        -4.96% |
| round2 → round3 / hot    |             5.22% |                  4.88% |                 11.57% |                    11.42% |        -9.07% |

| Round / mode    | All five Reference Graph samples (seconds)                 |
| --------------- | ---------------------------------------------------------- |
| baseline / cold | 130.231375, 128.422763, 123.686062, 126.298209, 123.532333 |
| baseline / hot  | 40.654808, 38.329869, 38.554378, 38.274458, 38.110635      |
| round1 / cold   | 81.570055, 81.722082, 78.723939, 78.993925, 80.914337      |
| round1 / hot    | 30.405051, 30.219987, 30.388697, 30.497854, 30.099613      |
| round2 / cold   | 73.610980, 74.387209, 69.624253, 73.397534, 69.486274      |
| round2 / hot    | 35.238667, 30.990875, 37.078965, 32.026905, 31.721329      |
| round3 / cold   | 67.417959, 67.425787, 67.134299, 64.642020, 67.363662      |
| round3 / hot    | 30.279691, 30.240219, 30.355671, 31.563910, 30.508130      |

## Work retained and rejected

- Initial optimization: share hash/binding derivations within one synchronous notification; scope first physical bindings to bounded analysis; index only privately published Coverage membership; reuse canonical field order only for privately immutable proof data; replace repeated resolution scans with a first-entry map. Cold Graph falls from 126.298 to 80.914 s and hot from 38.330 to 30.389 s. Cold baseline CPU profiles identify approximately 38.77 s of input observation, 32.91 s of path binding and 5.4 s of Coverage self work; inclusive times overlap. Initial cold/hot RSS rises 2.32%/6.42%, which is retained in the table rather than hidden. The targeted semantic batch passed 233 tests across five files.
- Additional round 1: batch exact import-literal matching, reuse neutral syntax facts by current text/path/compiler within one cache generation, and share qualified Vue dependency collection across the two synchronous reference projections. Actual Programs remain the source of requests and proof. The syntax microbenchmark moves from about 170 ms to 6.7 ms; a cold diagnostic records 2,890 builds and 3,578 syntax hits. Cold Graph falls to 73.398 s, but hot Graph rises to 32.027 s and hot end-to-end to 117.207 s. This round has a clear cold-path benefit; it does not prove a hot-path improvement. After correcting the callback omission described below, 141 affected tests and the focused Vue replay case passed.
- Additional round 2: test a single recursive ancestor Set instead of one Set per DTO node. On a real snapshot with 9,288 requests, six alternating, GC-controlled samples have medians of 473.638 ms before and 469.288 ms after, only 0.92% apart with overlapping ranges. Withdraw this candidate because the benefit is not reliably distinguishable. The final five cold/hot pairs measure the retained round-2 production implementation; changes between those batches do not establish another optimization benefit. Keep the sibling-alias ownership regression for the immutable-proof boundary. No Program, Checker, proof, validation or scheduler task is removed.
- Rejected: branding encoded receipt intermediates as published Native data breaks direct receipt decoding. A corrected unbranded encoder passes 124 byte/value comparisons but is slower and is not retained. A proposed snapshot syntax fingerprint memo is rejected because actual warm CPU cost is only 0.092 s. No new worker or concurrency mechanism is introduced: profiles show CPU/observation/representation costs, without evidence that scheduling waits are the main bottleneck.

The production chain remains [CLI configuration and preflight](../../packages/limina/src/cli/check-run.ts), [cache qualification](../../packages/limina/src/preflight/analysis-cache.ts), [restore or cold preparation](../../packages/limina/src/core/build-graph/prepare.ts), checker selection and actual bounded Programs, reference inference/validation, [materialization](../../packages/limina/src/preflight/materialization.ts), execution admission and Checker tasks, then [publication](../../packages/limina/src/execution/executor.ts). A hot diagnostic has `graphHits=1`, no semantic Programs and no fallback; declaration candidate validation remains real work. The cold diagnostics retain 15 semantic contexts, 31 bounded Programs and 11 Vue Programs. Zero semantic Programs on restoration does not mean zero Programs in the command.

## Correctness acceptance

The independent reproduction workspace contains Native TypeScript and Vue, three projects and an actual cross-project Vue dependency. Its pnpm/compiler/framework versions match the repository. The scripts live under the separately retained evidence root, called `$EVIDENCE_ROOT`; commands below run from the Limina repository. Their assertions compare meaningful graph data, not only file existence. Whole-repository cold/warm diagnostic comparisons also match all nine graph categories at baseline and in both retained optimization rounds; the optimized workload contains 952 dependency occurrences, four distinct project/Checker edges and 20 owned artifacts. Ignoring only edited source-line offsets, all 950 baseline dependency occurrences remain; the two additions come from regression-test imports. All 13 source units retain their earlier owned/declaration members, declaration references and authority; the new Coverage helper is the only added source member.

1. Differential adversary: `node --import tsx "$EVIDENCE_ROOT/coverage-experiment.mjs" semantic "$EVIDENCE_ROOT/evidence/final4-coverage.json"`, `node --import tsx "$EVIDENCE_ROOT/syntax-experiment.mjs" "$EVIDENCE_ROOT/evidence/final4-syntax.json"` and `node --import tsx "$EVIDENCE_ROOT/freeze-final.mjs" "$EVIDENCE_ROOT/evidence/final4-freeze.json"`. The old implementation is the Oracle for incomplete universes, stale/conflicting identities, aliases, mutable/caller-frozen inputs, import/JSDoc ranges, module extensions and DTO grammar. This tests representation changes independently of cache storage.
2. Incremental adversary: `node --import tsx "$EVIDENCE_ROOT/fixture-scenarios.mjs" incremental final4`. Each source/body/add/delete, dependency rename, tsconfig, package module format, lockfile and configuration-module change has its own cold/hot positive control, changed warm attempt, forced full recomputation and next warm restoration. Manifest, dependency occurrences, checker entries, mappings, generated files, ownership, source/declaration membership and semantic authority must match.
3. Recovery/concurrency adversary: `node --import tsx "$EVIDENCE_ROOT/fixture-scenarios.mjs" recovery final4`. Incompatible schema, damaged blocks and forged Coverage must reject restoration and agree with full analysis. Invalid declared references must fail cold/warm without replacing the previous index. Two independent concurrent processes must produce equal semantics, write at most one new revision and preserve every index field other than its validated random revision; a subsequent process must restore successfully.

The differential run passes 28,000 Coverage assertions, 181 syntax cases and 38 DTO assertions. All eight incremental cases pass; a source-body change creates 3 semantic contexts versus 5 for full analysis, a lockfile change creates 1 versus 5, and the remaining cases conservatively rebuild all 5. All five recovery/concurrency scenarios pass.

Earlier reproduction failures are retained: direct equality initially compared fresh compiler collection UUIDs and their derived request/obligation hashes; the comparator now validates those joins and canonicalizes only opaque identities. Negative controls still detect removed edges, Coverage members and owned sources. A second assertion incorrectly required byte-identical index revisions even though the direct preflight harness legitimately republishes; the corrected test asserts at most one writer, unchanged content and a valid revision transition. Neither correction changes production code or relaxes semantic assertions. During implementation, the execution-admission suite also exposed a real callback migration omission: the Native semantic subclass still forwarded a boolean to the new syntax reader. Both factory paths and the subclass were corrected, the affected 141-test batch passed, and the complete final gates were rerun.

Durable regression owners are [Native evidence](../../packages/limina/src/__tests__/native-evidence-contract.spec.ts), [incremental contexts](../../packages/limina/src/__tests__/native-context-incremental.spec.ts), [input replay](../../packages/limina/src/__tests__/execution-input-replay.spec.ts), [Vue restoration](../../packages/limina/src/__tests__/vue-analysis-cache.spec.ts), [full cache](../../packages/limina/src/__tests__/full-analysis-cache.spec.ts), [config modules](../../packages/limina/src/__tests__/config-module-cache.spec.ts), [cache lifecycle](../../packages/limina/src/__tests__/analysis-cache-lifecycle.spec.ts), [execution admission](../../packages/limina/src/__tests__/execution-admission.spec.ts) and [publication failures](../../packages/limina/src/__tests__/output-publication-failures.spec.ts). Existing tests also cover tool/adapter identity, environment changes, same-content retargeting, failure propagation and publication fences. Changed assertions retain the original semantic requirements.

`$REPO` below denotes the Limina checkout root. This table records the final product-acceptance batch; formatting, bilingual links, privacy and repository gates are also checked after adding this paired report.

| Actual command                                                                                                                                                                                                                                                                                    | Result |   Elapsed |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------: |
| `pnpm run build`                                                                                                                                                                                                                                                                                  | passed |    3.76 s |
| `pnpm run test:unit`                                                                                                                                                                                                                                                                              | passed | 1492.32 s |
| `pnpm run test:tooling`                                                                                                                                                                                                                                                                           | failed |   10.61 s |
| `pnpm run test:integration`                                                                                                                                                                                                                                                                       | passed |  190.28 s |
| `pnpm run test:smoke`                                                                                                                                                                                                                                                                             | passed |  167.65 s |
| `pnpm run docs:build`                                                                                                                                                                                                                                                                             | passed |    4.99 s |
| `pnpm run typecheck`                                                                                                                                                                                                                                                                              | passed |  160.48 s |
| `pnpm run lint:check`                                                                                                                                                                                                                                                                             | passed |   94.95 s |
| `pnpm run check`                                                                                                                                                                                                                                                                                  | passed |  142.14 s |
| `pnpm run lint:packages`                                                                                                                                                                                                                                                                          | passed |   11.49 s |
| `pnpm run gates:check`                                                                                                                                                                                                                                                                            | passed |    0.19 s |
| `pnpm run docs:privacy --context-records .agents/docs`                                                                                                                                                                                                                                            | passed |    0.21 s |
| `git diff --check`                                                                                                                                                                                                                                                                                | passed |    0.04 s |
| `node --import tsx --test $REPO/packages/gates/src/commit/staged.spec.ts`                                                                                                                                                                                                                         | passed |    4.08 s |
| `node --import tsx --test $REPO/scripts/release/check-tag-cli.spec.ts $REPO/scripts/release/cli.spec.ts $REPO/scripts/release/publication.spec.ts $REPO/scripts/release/shared.spec.ts $REPO/scripts/release/workflow.spec.ts $REPO/scripts/docs/privacy.spec.ts $REPO/scripts/git/hooks.spec.ts` | passed |   78.15 s |

The complete product unit run passed 3,347 tests, with one existing Windows-only junction test skipped on macOS. Integration passed 316 tests and packed-consumer smoke passed 21. The gates Vitest portion passed 35 tests and failed one. Tooling is **failed**, not accepted: the unchanged pinned Vercel 65.4.0 artifact embeds Zod 4.1.11 while the existing gate requires at least 4.6.7. Independent Array, Set and Map probes reject oversized values but still visit all three elements. Dependency declarations, lockfile and this gate are outside the performance diff. The chained commit tests (2 passed) and release/docs/git tests (51 passed) were then run separately; their passes do not turn the complete tooling result green. The installed failing chunk is byte-identical to the registry tarball and the tarball integrity matches the lockfile, so reinstalling that pinned artifact is not a demonstrated remedy. No assertion, dependency or installed artifact was altered to hide this failure.

Not executed: native Windows/Linux filesystems and subprocesses, other Node versions, the full external TypeScript/Vue version matrix (packed smoke consumers did exercise TypeScript 5.8.2), remote CI, publication and deployment. Portable lexical tests and locally installed adapter tests do not prove those environments. The experiment does not prove atomic observation of external edits during one command; existing bounded-read and independent-fence contracts apply.

## Costs and remaining bottlenecks

| Round    |          Median active referenced bytes | Retained bytes at batch end |
| -------- | --------------------------------------: | --------------------------: |
| baseline | 29,028,902 (batch-end observation only) |                 185,676,178 |
| round1   |                              29,026,874 |                 372,096,401 |
| round2   |                              29,033,510 |                 558,551,960 |
| round3   |                              29,035,306 |                 841,025,248 |

Final peak-RSS medians change from 4,569.406 to 4,159.000 MiB cold (8.98% lower) and from 2,760.578 to 2,933.250 MiB hot (6.25% higher). Warm `checker:build` remains 4.37% slower than baseline, at 66.051 s. These costs remain visible despite the 4.80% warm end-to-end improvement; the current evidence does not establish that they are acceptable for every workload.

Active storage remains about 29 MB. Total retained storage includes unreachable blocks from repeated cold publications; the existing publication protocol has no garbage collector. These bytes are not an active-model size regression, but the disk growth is real and is not cleaned away to improve the report. No cache-format/schema change or dependency change is introduced.

The remaining bottleneck ranking separates cold graph preparation, downstream publication and warm restoration. Cold preparation is dominated by coloring/bounded context collection; warm restoration is dominated by qualification and binding/reconstruction, followed by repeated proof representation work. Scheduler waits are not established as the main cause.

The post-round-2 actual warm diagnostic records 9.031 s setup/read/qualification and 20.590 s graph task. Inclusive CPU includes cached graph binding 5.577 s, Vue reference reconstruction 5.132 s, proof fingerprinting 3.605 s and DTO freezing 2.939 s. Cold coloring remains about 59.20 s; 31 bounded Programs take about 15.00 s and 11 Vue Programs 4.09 s. Publication takes about 28.93 s in that cold diagnostic. These are diagnostic observations, not formal end-to-end samples or additive budgets. Full-check warm `checker:build` grows from baseline 63.286 s to round-2 74.565 s; retain the final phase comparison above. The current evidence does not isolate host contention from implementation effects on that regression.

The measured scope ends with the retained implementation reported here. Future changes require a new measured bottleneck hypothesis; neither unmet targets nor smaller microbenchmarks justify weakening restoration, admission or publication checks.
