# ESLint 10 migration validation

Historical local paths use redacted aliases: `$LIMINA_REPO` is the Limina checkout, `$SOURCE_REPO` the source checkout, and `$EVIDENCE_ROOT` the local reproduction root. Recorded results retain their original scope and dates; private raw evidence is not included in this repository.

This record describes the local migration of the current working tree to ESLint 10.11.0. It does not accept independent CI, publication or documentation deployment. Those gates remain governed by the repository's temporary Logaria dependency.

## Environment and baseline

- Evidence date: 2026-09-29–30. macOS 27.0 arm64, Node 24.21.0, pnpm 11.9.0, TypeScript 6.0.3, Rolldown 1.2.10 and Vitest 4.1.11. A separate official Node 22.18.0 arm64 distribution exercised the declared minimum runtime.
- Starting HEAD: `0c6a543db2a196b76aec44e75ce88ed3ebe0050a`. The initial unrelated root Logaria catalog change was preserved. The maintainer authorized only `logaria@0.0.4` as a release-age exception, the new Unicorn recommended rules across the repository, and parallel module remediation.
- Minimal reproduction: `$EVIDENCE_ROOT/eslint-10-migration-20260929/`. `baseline/` and `migrated/` use independently installed pnpm workspaces with the real private ESLint package, root config, TypeScript bases, catalogs, ESM module format and strict peer policy. No old `node_modules` were copied. The minimal workspaces do not reproduce the complete product or external consumers.
- The original non-fixing repository lint run processed 1,252 files with zero errors and warnings. The isolated original ESLint config build, its 19 tests and the language/guard exercise passed. Raw evidence lives in `logs/baseline-*`.

## Dependency and configuration change

| Dependency                                       | Final locked version |
| ------------------------------------------------ | -------------------- |
| eslint                                           | 10.11.0              |
| @eslint/js                                       | 10.0.1               |
| typescript-eslint / @typescript-eslint/parser    | 8.71.0               |
| eslint-plugin-unicorn                            | 76.0.0               |
| eslint-plugin-n                                  | 18.4.0               |
| eslint-plugin-pnpm                               | 1.9.1                |
| @html-eslint/eslint-plugin / @html-eslint/parser | 0.66.1               |
| eslint-plugin-prettier                           | 5.5.6                |
| eslint-config-flat-gitignore                     | 2.4.0                |
| eslint-config-prettier                           | 10.1.8               |
| eslint-plugin-regexp                             | 3.1.1                |
| jsonc-eslint-parser                              | 3.3.0                |
| yaml-eslint-parser                               | 2.1.0                |
| globals                                          | 17.12.0              |

Registry metadata was refreshed on September 30 in `registry-final.json`. Regexp 3.3.1 is excluded because its transitive parser requires Node `^22.22.2 || >=24.15.0`, above the repository floor. Catalog range `~3.1.1` retains the latest compatible line. Prettier config and globals were already current. The official [ESLint release](https://eslint.org/blog/2026/09/eslint-v10.11.0-released/) and [v10 migration guide](https://eslint.org/docs/latest/use/migrate-to-10.0.0) describe the core release and file-based lookup change.

pnpm generated the lockfile; subsequent Prettier formatting preserved the dependency graph and frozen installation succeeded. `logs/importer-delta.json` reports no unexpected direct importer version changes outside the lint stack and approved Logaria change. The obsolete HTML parser wildcard hook and its unreachable minimatch 3 overrides/patch were removed; the other three patches remain.

The complete Unicorn 76 recommended preset applies to JavaScript and TypeScript, followed by the existing explicit overrides. Global plugin registration remains available to those overrides. Language scoping avoids applying JavaScript comment fixes to YAML nodes. The root imports explicit `rootFileConfigs` instead of filtering the composed root preset, which previously reapplied recommended rules after overrides. The portable-path and logger guards remain active; fixtures and generated distributions remain ignored. Root commands retain an explicit config path.

## Three independent adversarial rounds

The proposition tested is that the migrated lint stack retains the intended language, override and custom-guard behavior on the supported runtime floor. All rounds used the final dependency versions, including typescript-eslint 8.71.0. Set `repro_root` to the absolute reproduction path above; run the first commands from `$repro_root/migrated`.

| Round                                   | Intent and independence                                                                                                                                                                                                                                | Commands                                                                                                                                                                                                                                        | Observed result                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: parser and fix controls              | Try to break typed TS, HTML, YAML, JSON/catalog, regexp and custom rules using clean and invalid inputs. Deliberate config mutations challenge language scoping and override order rather than repeating clean lint.                                   | `node "$repro_root/exercise.mjs"`; `node "$repro_root/mutation-controls.mjs"`                                                                                                                                                                   | Twelve language/rule checks plus logger controls passed. Fixtures/dist were ignored. Removing Unicorn language scoping corrupted the YAML comment and produced a fatal parse error; replaying composed root entries re-enabled `unicorn/no-null`. Correct configurations retained YAML comments and the existing override. |
| 2: real file lookup and cwd             | Try to select the wrong configuration through a nested workspace path containing spaces, Unicode and `!`, a different cwd, explicit root config, and invalid on-disk YAML. This uses the ESLint CLI and disk inputs instead of API lintText.           | `node "$repro_root/lookup.mjs"`                                                                                                                                                                                                                 | All five checks passed: automatic file lookup selected the nearest config from both directories; explicit root config produced the expected `no-undef`/`no-console` errors; duplicate catalog YAML produced its intended diagnostics.                                                                                      |
| 3: minimum runtime and compiled package | Try to falsify engine/API compatibility by running the independent Node 22.18.0 binary against the final stack, compiling the private config and executing RuleTester/config tests. This changes the runtime and exercises compiled/config test paths. | `"$repro_root/runtime/node-v22.18.0-darwin-arm64/bin/node" "$repro_root/exercise.mjs"`; from `packages/eslint-config`, use the same binary with `node_modules/typescript/bin/tsc -p tsconfig.dts.json` and `node_modules/vitest/vitest.mjs run` | All language/guard checks, config compilation and 22 tests passed. This is minimum-runtime evidence for the lint stack, not the full product suite.                                                                                                                                                                        |

Evidence: `logs/round-{1,2,3}-final.json`, `logs/config-mutation-final.json`, `logs/round-3-build-final.log`, and `logs/round-3-tooling-final.log`. Expected negative diagnostics are successful controls, not ignored failures.

## Source remediation and counterexamples

Whole-repository remediation includes naming with retained public export aliases, boolean expressions, async composition, class ordering, iterator/collection APIs and string sorting. Granular TypeScript libraries expose supported APIs while the emit target remains ES2023. `Promise.try` is unavailable at Node 22.18 and was replaced with the existing asynchronous deferral behavior. Mutable state remains at its original module lifetime; cache/promise identity and write-queue cleanup were reviewed.

`semantic-controls.mjs` transpiles the actual HEAD/current owner modules. Both Node versions passed 10,019 integer boundary/random IEEE754 samples against `Number.isInteger`, 14 Unicode/surrogate/string sorting inputs against native code-unit sort, literal wildcard captures and error-cause/reflection controls. The baseline misexpanded `$&`, `` $` ``, `$'` and `$$` wildcard filenames; the migrated callback keeps captures literal. Malformed Knip JSON now retains its original cause. `replacement-semantics.mjs` passed 130 inputs against native replacement expansion on both runtimes. Fixture helper substitution expansion remains unchanged. Built public export reflection was also checked on both Node versions.

The tests protect these changes at their existing owner boundaries: package imports, Knip parsing, fixture replacement, migration transaction retries, and ESLint config fixes. Deliberate mutations or HEAD controls demonstrate the intended pre-fix failures where applicable. No test-only production seam was added and no tests were deleted to achieve rule compliance. HTTP rejection inputs changed by automatic `prefer-https` fixes were restored as HTTP values. Diagnostic producer metadata was synchronized with renamed symbols without changing public issue codes or serialized keys.

The preflight manager still owns artifact materialization. Implementation extraction into `preflight/materialization.ts` preserves I09–I11; the architecture guard checks both the sole materializer caller and the manager's sole invocation of its helper. The paired lifecycle record describes these call edges. The guard's existing limitations for aliases, dynamic calls and re-export tracing remain.

Source review checked public exports, type aliases, manifests, serialized keys and high-risk async/state transformations. It found and repaired constructor reflection and two private build-tool type aliases. This is targeted source review, not a formal proof of all source equivalence. All 1,140 tracked fixture files remain byte-identical to HEAD (`logs/fixture-byte-boundary.json`); deliberately invalid fixture contents retain their own repository boundaries.

## Executed repository validation

| Command                     | Result       | Coverage                                                                        |
| --------------------------- | ------------ | ------------------------------------------------------------------------------- |
| `pnpm run build`            | PASS         | private tools, core, migration and declarations                                 |
| `pnpm run test:unit`        | PASS         | 114 core files: 2,223 passed / one existing skip; 7 migration files: 138 passed |
| `pnpm run test:tooling`     | PASS         | 22 ESLint tests and 9 release tests                                             |
| `pnpm run test:integration` | PASS         | 264 core tests and one migration test                                           |
| `pnpm run test:smoke`       | PASS (rerun) | 3 files / 11 tests, after independent linked-input version assertion repair     |
| `pnpm run docs:build`       | PASS         | English/Chinese documentation build                                             |
| `pnpm run typecheck`        | PASS         | vue-tsc and tsgo checker paths                                                  |
| `pnpm run check`            | PASS         | graph, source, proof and checker governance                                     |
| `pnpm run lint:packages`    | PASS         | package manifests and distribution checks                                       |
| `pnpm run lint:check`       | PASS         | whole repository, zero errors / warnings                                        |
| `pnpm run format:check`     | PASS         | whole repository                                                                |

The full rerun is recorded by `run-validation.py` in `logs/validation-results.json` and `logs/final-*.log`. The smoke repair/rerun is recorded in `logs/smoke-input-version-final.log`. After changing only the smoke assertion and paired records, final type/lint/format checks are also recorded separately.

The first full pass exposed duplicate assertion variables, a contextual return annotation, stale architecture/producer indexes, and two negative HTTP inputs. These were repaired and the four focused regression suites passed 37 tests before the full rerun. The first smoke attempt failed during npm registry requests with `ECONNRESET`/metadata-fetch failures and a consumer install timeout; `logs/validation-pass-1/` preserves that attempt. The next smoke run reached a pre-existing fixed `0.0.3` assertion while the independent linked input and generated manifest both contained `0.0.4`. The assertion now reads the declared linked input, rather than copying a generated output or the unrelated root catalog. The original smoke command and installation configuration then passed all 11 tests. HEAD contains the same former fixed assertion and projection logic, but no full HEAD smoke rebuild was executed.

## Boundaries and repository state

Linux/Windows, Node 24.11.0, the complete product unit/integration/smoke suite under Node 22.18.0, editor integrations and remote CI were not executed. Coverage percentages and exhaustive source equivalence were not measured. Remaining product/build-tool Logaria links were consumed as declared and not rebuilt. This local work does not authorize publication, replacing old consumers, deployment or source retirement.

Final checks and Git state are recorded in `logs/final-state.json`, `logs/final-git-status.txt` and `logs/final-diff-check.log`. The root Logaria catalog change and the remaining temporary links retain their distinct ownership.

The existing staged boundary is preserved. Final validation applies to the complete working tree, including newer unstaged fixes and renamed/new files. No commit, push, publish or deployment occurred. Paired technology-stack, system-model, lifecycle and repository architecture PCR pages were maintained together without adding a vouch or decision ledger.
