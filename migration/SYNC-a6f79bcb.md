# Input topology synchronization

Source: docs-islands local main commit `a6f79bcb4528098f7bbf8c9f309216f176ffa826`, immediately following the initial extraction baseline. The original commit title is preserved. All 91 changed files are carried over: product paths stay under `packages/limina`, product documentation moves to root `docs`, and PCR remains under `.agents/docs`. Of these files, 88 match source bytes or source deletions exactly. The Rolldown configuration retains private build-tool imports and the two lifecycle records retain normalized documentation links. No dependency or public peer range was changed.

The change adds the packaged `migration-verify-process.js` entry, input topology preservation, optional-output trials, exact config isolation, consistency-group writes and fresh-process verification. The source commit's tests and complete English/Chinese documentation and PCR changes are retained without new test-only production interfaces. [File mapping](./upstream-a6f79bcb.json) records provenance; initial extraction evidence remains in [VALIDATION.md](./VALIDATION.md).

## Environment and reproduction

Evidence directory: `/Users/chenjiaxiang/Project/dev-server-repo/repros/limina-monorepo-migration/sync-a6f79bcb/`.

macOS 27 arm64, Node 24.21.0, pnpm 11.9.0, TypeScript 6.0.3, Rolldown 1.2.10 and Vitest 4.1.11. `run.py` records exact arguments, cwd, exit code and duration in `commands.jsonl`; individual command logs are retained. `repro.py` creates and commits independent fixture repositories, clears `NODE_PATH`/`NODE_OPTIONS`, and invokes the actual CLI.

The pre-sync dist was captured before rebuilding. `python3 repro.py baseline-dist/bin/limina.js baseline self-hiding` demonstrates the regression: migration exited 0 and adopted the self-hiding output, but graph preparation and repeat migration failed. The reproduction assertion exited 1 as expected for this negative baseline.

## Three independent adversarial rounds

All commands below run from the evidence directory; `CLI` denotes `/Users/chenjiaxiang/Project/limina/packages/limina/dist/bin/limina.js`.

| Round | Counterexample and independent boundary                                                                                                       | Actual command                                                       | Result                                                                                                                                                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Self-hiding native output versus a safe independent output; normal graph consumption and repeat byte identity                                 | `python3 repro.py "$CLI" candidate self-hiding`                      | Exit 0; unsafe output rejected, safe output accepted, both source members retained, graph and repeat migration pass with no config-byte changes                                 |
| 2     | Real dist tarball installed outside the target workspace; invalid config plus healthy solution-owned named source hidden by a proposed output | `python3 pack-consumer.py`                                           | Exit 0; tarball and pinned TypeScript installed offline, unsafe output rejected, healthy members retained, packed verification worker resolves, graph and repeat migration pass |
| 3     | Dynamic config that cannot persist required isolation, with cwd containing Chinese, spaces, exclamation mark, ampersand and single quote      | `python3 repro.py "$CLI" "中文 space ! & quote'" dynamic-incomplete` | Reproduction exit 0; CLI exits 1, dynamic config and invalid source remain intact, report explains missing persisted exclusions                                                 |

Round 2 initially lacked its own workspace boundary: pnpm selected an ancestor workspace and the expected consumer CLI was absent. That attempt is retained in `adversarial-packed.log` and is not product evidence. Adding the consumer's own `pnpm-workspace.yaml` isolates installation; `adversarial-packed-isolated.log` records the successful rerun. The existing ancestor manifests and lockfile were unchanged.

## Repository checks

| Command                                                                                                                                        | Exit | Observation                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------- |
| `pnpm run build`                                                                                                                               | 0    | Includes the new packaged verification worker |
| `pnpm --filter limina exec vitest run src/__tests__/{config,migration-config-edit,migration-topology,migration,migration-transaction}.spec.ts` | 0    | 5 files / 238 focused tests                   |
| `pnpm run test:unit --maxWorkers=2`                                                                                                            | 0    | 120 files / 2356 passed / 1 existing skip     |
| `pnpm run test:integration --maxWorkers=2`                                                                                                     | 0    | 17 files / 263 passed                         |
| `pnpm run typecheck`                                                                                                                           | 0    | Current checker coverage passes               |
| `pnpm run check`                                                                                                                               | 0    | Graph, source, proof and checker build pass   |
| `pnpm run lint:check`                                                                                                                          | 0    | No rule or exclusion weakened                 |
| `pnpm exec prettier --check <imported existing files>`                                                                                         | 0    | Exact file list in file-comparison.json       |
| `pnpm run docs:build`                                                                                                                          | 0    | English and Chinese site builds               |
| `pnpm run test:smoke`                                                                                                                          | 0    | 2 files / 10 packed-consumer tests            |
| `pnpm run lint:packages`                                                                                                                       | 0    | Tarball, publint, ATTW and boundary checks    |

The first full unit/integration runs overlapped with other heavyweight checks. Three unit cases exceeded the unchanged 30-second timeout; the run was stopped after those failures (exit 130). One integration registry case expected a tarball timeout but reached the earlier metadata timeout (50 ms) before any request reached its local server. These logs are retained. Both complete suites subsequently passed when run sequentially with two workers, without changing assertions, timeout settings or repository test configuration. The earlier failures did not recur under these conditions; this comparison supports load sensitivity but does not establish a universal absence of timing failures.

## Boundaries

The target Git configuration and source checkout are unchanged. All existing Logaria artifact digests match the pre-sync snapshot. The tarball contains the new worker and its manifest contains no local protocols, private tool packages or host paths. This proves local behavior under the declared Logaria dependency; it does not establish independent remote CI, Linux/Windows, other Node versions or the separate Vue semantic matrix. No push, publication, deployment or old-repository retirement was performed.
