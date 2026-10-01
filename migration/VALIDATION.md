# Local migration validation

Historical local paths use redacted aliases: `$LIMINA_REPO` is the Limina checkout, `$SOURCE_REPO` the source checkout, and `$EVIDENCE_ROOT` the local reproduction root. Recorded results retain their original scope and dates; private raw evidence is not included in this repository.

Local migration is complete under the declared external Logaria dependency, using the monorepo layout. Full independent migration, native remote-platform acceptance, publication and deployment remain closed.

Implementation commit: `5dd3022d3b040a53794e26cd9fdb007da57528c9` (`build: configure standalone monorepo`).

## Final repository layout

The root `@limina/monorepo` is private and orchestrates commands. `packages/limina` is the only public product package; publication uses only `packages/limina/dist`. Root `docs`, `smoke` and `scripts` own documentation, packed consumers and release tooling. `packages/build-tools` and `packages/eslint-config` remain private. The product keeps lib/test/tools TypeScript leaves; the root has one tooling environment and therefore uses a default leaf `tsconfig.json`.

The migration establishes a monorepo with a private root and one public product package. The existing Rolldown toolchain and Limina governance semantics remain unchanged. New commit scopes identify the affected subsystem; cross-cutting commits may omit a scope. Imported historical commit messages are unchanged.

## Environment and source baseline

- Date: 2026-09-28. macOS 27.0 arm64, Node 24.21.0, pnpm 11.9.0, TypeScript 6.0.3, Rolldown 1.2.10, Vitest 4.1.11; existing Logaria dist 0.0.3.
- Fixed source: docs-islands `c09e12c1ef12f89e927cce4c41e714ee0539ada6`. Source checkout/shared Git storage were not filtered or modified. The target’s existing Git configuration and SSH origin were preserved.
- An isolated source archive used frozen offline installation with `--ignore-scripts` and only the existing authorized Logaria artifact. Running `node node_modules/vitest/vitest.mjs run --maxWorkers=2` from the product directory passed 118 files / 2,342 tests, with one existing skip.
- An initial baseline invocation from the monorepo cwd using `--root packages/limina` failed two Astro resolver cases. The correct product cwd passed. The failed invocation is retained as a cwd distinction, not a source regression.
- Full source-monorepo build/governance and other-product suites were not run. Current source-checkout changes made by other work were preserved and not used as migration inputs.

## Evidence ownership

Reproduction root: `$EVIDENCE_ROOT/limina-monorepo-migration/`. Final-layout raw logs and metadata are in `evidence/vite-layout/`. `validate-vite.py` records argv, cwd, exit codes, environment and durations; `replica-vite.py` creates independent copies. `vite-static.py` compares files, dependencies, public manifest fields and bilingual links.

The earlier root-package layout and its results are preserved in `evidence/root-layout-before-vite.tar.gz`, `evidence/root-layout-VALIDATION.md` and the original round logs. They are not used to claim acceptance of the final layout. The final layout was retested in all three independent lanes below.

## Round 1: cold build closure

Intent: disprove bootstrap independence from old Limina/tool outputs. Product/private-tool output directories, workspace node_modules, governance output and build caches were cleared. Installation used the shared package cache offline, with NODE_PATH and NODE_OPTIONS removed. Root release tooling links Logaria with `link:../docs-islands/packages/logaria/dist`; the product and build-tools use `link:../../../docs-islands/packages/logaria/dist`. These are the only old-repository build inputs.

| Command                                    | Exit | Evidence                  |
| ------------------------------------------ | ---- | ------------------------- |
| `pnpm install --frozen-lockfile --offline` | 0    | round1-01-install.log     |
| `pnpm run build`                           | 0    | round1-02-build.log       |
| `pnpm run typecheck`                       | 0    | round1-03-typecheck.log   |
| `pnpm run check`                           | 0    | round1-04-check.log       |
| `pnpm run lint:check`                      | 0    | round1-05-lint.log        |
| `pnpm run format:check`                    | 0    | round1-06-format.log      |
| `pnpm run test:unit --maxWorkers=3`        | 0    | round1-07-unit.log        |
| `pnpm run test:tooling`                    | 0    | round1-08-tooling.log     |
| `pnpm run test:integration --maxWorkers=3` | 0    | round1-09-integration.log |
| `pnpm run docs:build`                      | 0    | round1-10-docs.log        |
| `pnpm run lint:packages`                   | 0    | round1-11-packages.log    |

The negative control `python3 replica-vite.py missing-logaria` created an independent copy without a sibling Logaria directory. Frozen offline installation exited 0; build exited 2 with explicit TS2307 diagnostics for `logaria` and `logaria/helper`. It did not create the missing old repository or modify the authorized Logaria output.

Final counts: unit 118 files / 2,338 passed / one existing skip; integration 16 files / 262 passed; ESLint tooling 2 files / 19 passed; release tooling 6 passed. The unit count differs from baseline only because obsolete path-filter/Nx CI cases were replaced with whole-repository scheduling and pnpm-ordering coverage. Release tooling adds one contract for agreement between the private root, public manifest, governance entry and publication target. Test file counts are unchanged. All 1,140 fixture files retain baseline bytes; product implementation outside evidence metadata/tests is unchanged.

## Round 2: packed consumers

Intent: disprove source-checkout, local-protocol, loader or optional-peer contamination. `pnpm run test:smoke` packed real dist tarballs, installed them in external temporary consumers and passed 2 files / 10 tests. NODE_PATH/NODE_OPTIONS were removed and pnpm used its package cache offline. Tests exercise CLI, API, declarations, schema, subprocesses, generated shell commands and optional peers.

Artifact scan found no local/workspace/catalog protocol, private package or host-path leak. Public bin/exports remain intact, Logaria metadata is 0.0.3, and same-build `packages/limina/LICENSE.md` and `packages/limina/dist/LICENSE.md` bytes match.

Retained local candidate: `evidence/vite-layout/limina-0.4.0.tgz`; shasum `e4ba544df5140110cb71d20387fb4994c5843b65`, packed size 686,957 bytes. Version 0.4.0 is a local candidate, not an approved new release version.

## Round 3: path and cwd

Intent: disprove dependence on a simple checkout path or repository cwd. An independent copy under `vite 路径 space ! & quote'/limina` used its own Git metadata, frozen installation and build. Only the authorized Logaria artifact was connected as the declared sibling dependency.

| Command                                                                                                                                                                                                                                        | Exit | Evidence           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------ |
| `pnpm install --frozen-lockfile --offline`                                                                                                                                                                                                     | 0    | install            |
| `pnpm run build`                                                                                                                                                                                                                               | 0    | build              |
| `pnpm run test:unit src/__tests__/atomic-writer.spec.ts src/__tests__/path-filters.spec.ts src/__tests__/shell-command.spec.ts src/__tests__/standalone-invocation-command.spec.ts src/__tests__/migration-transaction.spec.ts --maxWorkers=2` | 0    | path-unit          |
| `pnpm --dir smoke exec vitest run generated-command.spec.ts`                                                                                                                                                                                   | 0    | generated-consumer |
| `node $EVIDENCE_ROOT/limina-monorepo-migration/vite 路径 space ! & quote'/limina/packages/limina/dist/bin/limina.js --help`                                                                                                                    | 0    | different-cwd      |

The focused atomic-write, portable-path, shell-command, standalone-invocation and migration-transaction suite passed 5 files / 75 tests. Generated-command consumers passed 9 tests against installed tarballs. The absolute dist CLI also ran from an unrelated cwd. This establishes native macOS arm64 / Node 24.21.0 behavior only.

## Additional validation and repaired counterexamples

- `pnpm --dir packages/limina/fixtures/vue-semantic-matrix install --frozen-lockfile --ignore-scripts --offline` and `pnpm --dir packages/limina/fixtures/vue-semantic-matrix matrix` passed all five installed-artifact tuples.
- All 18 public source-manifest contract fields match baseline, including Node/peer ranges, runtime dependencies, imports, exports and bin. [File mapping](file-mapping.json) covers all 2,388 original product files; only three obsolete Nx project configs were dropped, and docs/smoke/shared ownership is explicit.
- [Lock comparison](lock-comparison.json): 1,093 retained resolutions from the 1,722-package source lock, with no new/changed version or integrity and all four patch identities preserved. Metadata-only optional-peer range changes result from removing overrides for absent axios/less consumers; they change no installed resolution. pnpm generated the lockfile. Prettier formatting changed no parsed dependency data.
- Product worker and build-helper effective ESLint rule maps exactly match their source-owner configurations; portable-path and license-logger constraints remain active. All 12 PCR topics have complete English/Chinese pairs and resolving file/heading links, without new vouches or a decision ledger.
- First-layout attempts exposed an absent notices-file dependency, stale evidence anchors, a relative cross-package config import, a missing root `cac` declaration and an invalid single-environment solution tsconfig. The license generator now creates notices when absent; tests use real configuration loading; manifests and source ownership were corrected. No rule was disabled, fixture rewritten, dependency upgraded or reason-field exception added.
- CI uploads package artifacts relative to `packages` and downloads them back there, following [upload-artifact’s wildcard path behavior](https://github.com/actions/upload-artifact#upload-using-multiple-paths-and-exclusions). Native remote CI has not run. A local CI-contract invocation with `--reporter=default --reporter=junit --outputFile=../../.smoke/test-results/unit.xml` passed five tests and produced the expected root JUnit artifact. CI includes hidden files for this narrowly scoped evidence directory.
- The actual CI setup gate was executed in four isolated manifest layouts: a remaining Logaria link in root, product or build-tools each failed with exit 1; the all-registry control exited 0. These synthetic controls did not replace the real links or establish registry availability. See `ci-link-gates.json`.
- Final targeted ESLint, full typecheck and formatting passed. Full staged `git diff --cached --check` reports inherited whitespace in the byte-identical imported patch payloads; those bytes remain unchanged to preserve patch identity. The same staged check outside `patches/*.patch` passes. `staged-whitespace.json` and its raw log record both exit codes; no whitespace rule was disabled. Release dry-run `pnpm run release limina --version 0.4.1 --yes --dry-run` points to `packages/limina/dist` and explains manual gated workflow dispatch; it did not change versions, tags or files. The preview version is an example, not a maintainer release decision.

## Remaining gates

Independent Logaria consumption must be approved before clean builds without the old repository, full remote CI or publication can be accepted. Existing Logaria output was not modified, rebuilt or published. Native Linux/Windows, Node 22.18.0/24.11.0, online fresh downloads, npm publisher authority and Vercel project/domain/deployment permissions remain unverified. Coverage percentages were not measured.

The publish workflow is dispatch-only and closed by the release variable; setup/release scripts reject temporary Logaria links in root, product or build-tools. Publication checks npm 11.5.2+, real product dist identity and package/tag/version agreement. GitHub release creation is not automated. Historical tags do not trigger publication.

Selecting an unpublished version, freezing the old publisher, changing registry consumers, retiring old source and switching documentation/redirects remain later cutover steps. No push, publish, online deployment or source retirement occurred.
