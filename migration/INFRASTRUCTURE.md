# Adapted infrastructure validation

Date: 2026-09-30. Target baseline: `196a9c7`. Source infrastructure inspected at `$SOURCE_REPO`, `e64ed491`. Host: macOS arm64, Node 24.21.0, pnpm 11.9.0. Floor experiments use the official checksum-verified Node 22.18.0 binary and the same pnpm JS entry, with `pnpm exec node` asserted to report 22.18.0.

Local integration is complete. Normal local quality gates pass. The dependency-audit gate correctly fails on six pre-existing high advisory entries. This does not establish remote CI, publication or deployment acceptance.

## Adaptation and scope

- Reviewed Renovate updates operate on the current catalogs and lockfile, preserve checker tuples and Vite 5, and exclude independent fixtures. No second dependency bot is installed.
- Dependency review shares the existing bundle-license policy. CodeQL scopes the two products, private tooling and scripts. Gitleaks scans reachable history with a checksum-pinned CLI and redacted evidence. The pnpm audit parser fails on transport/schema errors and uses returned advisory details after existing exclusions.
- Linux quality reuses same-commit Linux package artifacts; native platform jobs still build independently. CI aggregation includes every CI job. Invalid inherited artifact-action pins and an undeclared matrix property are repaired.
- Actual bundler inputs produce a dependency inventory. Actual npm tarballs produce size/integrity reports, license reports and scoped CycloneDX 1.6 SBOMs for `limina` and `limina-migrate`. External consumer-selected versions are not invented.
- Manual publication and documentation deployment retain independent repository/variable/environment/tag gates. GitHub release assets follow the existing same-version npm group and compare immutable registry integrity. Documentation deployment requires an explicitly supplied HTTPS origin and separate Vercel project credentials.
- Deployment tooling is a private `packages/deploy-tools` workspace. Vercel CLI 56.3.1 and parent-specific patches are cataloged and frozen. The pnpm ESLint adapter recognizes parent/version-qualified override references without suppressing genuinely unused entries. `path-to-regexp` has a named duplicate-catalog lint allowance for its required major 6 and 8 APIs.
- English contribution/security policies, repository templates, editor configuration and paired PCR ownership are integrated. No product identity/authority invariant is changed.

Nx orchestration/cache, the old utility package, environment/postinstall bootstrapping, agent symlinks, multi-site aggregation, preview publication, autofix/report messaging and additional update bots are not imported. No commit, push, npm publication, GitHub release, Vercel deployment, repository-administration change, old-consumer replacement or old-source removal was performed.

## Baseline and final audit

The captured pre-integration report returned **17 advisory entries: 6 high, 8 moderate, 3 low, 0 critical**. Its registry metadata counted 7 high and 1 critical, plus other excluded entries. Those metadata counts are not the effective gate result.

Adding the unpatched deployment CLI introduced additional high/critical entries. Parent-specific catalog overrides update tar 7.5.21, path-to-regexp 6.3.0/8.4.0, Ajv 8.20.0 and once 2.0.1 only in that deployment graph. The final audit again returns **17 entries, with the same advisory URL set as the captured baseline** and no newly introduced high/critical finding. `security:audit` exits 1 because the six existing high entries remain:

| Package         | High advisory identifiers                |
| --------------- | ---------------------------------------- |
| fast-uri        | GHSA-qw65-cvwx-89v3; GHSA-58mr-gqgx-xq4g |
| undici          | GHSA-rfgv-xxqx-mfg5; GHSA-w293-vg96-wgc3 |
| brace-expansion | GHSA-qhr7-859c-m2p7; GHSA-6j4f-fj2g-mc7p |

Existing GHSA, trust, release-age and deprecated-package policies are retained; no new exception is added to those policies. The baseline captured JSON and final returned set were compared in `evidence/audit-comparison.json` in the reproduction directory. Reports live under `.reports/security/`.

Vercel 60.1.3/61.0.0 upgrade candidates were rejected by the existing pnpm trust policy. The selected 56.3.1 CLI's registry, source tag and downloaded archive agree on Apache-2.0; its archive SHA-512 agrees with registry metadata. It launches on Node 22.18.0. The upstream deprecated `stream-to-promise` 2.2.0 remains a maintenance limitation, not a deprecation exception. pnpm's peer deduplication adds optional Vercel peers to host Vitest/Astro contexts; their package versions and independent fixture workspaces remain unchanged. Full host suites were rerun after introducing those contexts.

## Executed local checks

| Commands                                                                  | Result                                                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                          | Pass with pnpm 11.9.0 after catalog/lockfile generation                                              |
| `pnpm run build:tools`; `pnpm run build`                                  | Pass; both public artifacts rebuilt before package/smoke evidence                                    |
| `pnpm run infrastructure:check`; `pnpm run artifacts:report`              | Pass; actual tarball hashes and inventories checked                                                  |
| `pnpm --filter limina run test:unit --maxWorkers=2`                       | 114 files; 2,223 passed, 1 skipped                                                                   |
| `pnpm --filter limina-migrate run test:unit --maxWorkers=2`               | 7 files; 138 passed                                                                                  |
| `pnpm run test:integration`                                               | Core: 16 files, 264 passed; migration: 1 file, 1 passed                                              |
| `pnpm run test:tooling`                                                   | ESLint: 4 files, 24 passed; root Node tests: 14 passed; also passes on Node 22.18.0                  |
| `pnpm run test:smoke`                                                     | 3 files, 11 passed                                                                                   |
| `pnpm run typecheck`; `pnpm run check`; `pnpm run lint:packages`          | Pass                                                                                                 |
| `pnpm run lint:check`; `pnpm run format:check`; `pnpm run docs:build`     | Pass                                                                                                 |
| `pnpm run security:audit`                                                 | Expected failure: six existing high entries, zero returned critical entries                          |
| actionlint 1.7.12, with shellcheck/pyflakes integrations disabled         | All workflow syntax/expression checks pass                                                           |
| Gitleaks 8.30.1, full reachable Git history and a current-change snapshot | No leak detected                                                                                     |
| `git diff --check`; final Git status inspection                           | Clean whitespace; the new PCR pair is tracked together, other implementation changes remain unstaged |

The full product unit/integration runs followed the private CLI and host peer-context addition. The final deployment-only catalog patches and private ESLint adapter were followed by another full build, configuration/artifact reports, lint/format/typecheck/check/package checks, tooling, packed smoke, docs build and Node 22 adversarial rounds. Public tarball bytes/integrities remained identical across that final private-tooling adjustment. No fixture or product source was changed in that adjustment.

The final reports contain `limina` 0.4.0: 686,592 packed bytes, 3,312,863 unpacked bytes, 35 bundled dependencies; `limina-migrate` 0.4.0: 60,597 packed bytes, 253,497 unpacked bytes, 9 bundled dependencies. These local version-0.4.0 artifacts are measurement inputs, not approval to republish imported historical tags.

## Minimal reproduction and independent adversarial rounds

Reproduction: `$EVIDENCE_ROOT/limina-infrastructure/`. It has an explicit workspace boundary, its own generated fixtures, official schemas and recorded command/condition/exit/output evidence. No old node_modules is copied. The runner imports the target's current implementation and installed dependency versions.

Run from `$LIMINA_REPO`:

```sh
/tmp/limina-node22-runtime/bin/node --import ./node_modules/tsx/dist/loader.mjs $EVIDENCE_ROOT/limina-infrastructure/run.mts configuration
/tmp/limina-node22-runtime/bin/node --import ./node_modules/tsx/dist/loader.mjs $EVIDENCE_ROOT/limina-infrastructure/run.mts artifacts
/tmp/limina-node22-runtime/bin/node --import ./node_modules/tsx/dist/loader.mjs $EVIDENCE_ROOT/limina-infrastructure/run.mts failure-boundaries
/tmp/limina-node22-runtime/bin/node --import ./node_modules/tsx/dist/loader.mjs $EVIDENCE_ROOT/limina-infrastructure/run.mts release-tags
```

| Round                    | Intent and independent observation path                                                                                                 | Actual conditions and outcome                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1: configuration         | Falsify workflow/configuration validity through independent actionlint, official Renovate JSON Schema and docs-origin inputs            | Current configuration passes. A nonexistent matrix dimension, string-valued automerge, HTTP/credential/path/query origins fail. Clean HTTPS and unset local origin pass. 8 observations recorded.                                                              |
| 2: artifacts             | Falsify artifact contents and license coverage through tar extraction, SHA-512, official CycloneDX schema and actual Rolldown execution | Both tarballs/inventories/SBOMs pass. Flipped archive bytes and invalid bomFormat fail. MIT development code enters the inventory; missing/GPL license makes the actual bundle fail. 10 observations recorded.                                                 |
| 3: failure boundaries    | Falsify fail-closed semantics through subprocess outputs and Git history, independently of the configuration/bundler paths              | High advisory with exit 0 still fails; moderate with exit 1 passes; registry exit 2 fails and clears stale success JSON. A clean tree passes while a deleted synthetic secret in history fails with redaction. Historical tag fails. 19 observations recorded. |
| Supplement: release tags | Seek competing Git-identity/ancestry explanations through real annotated/lightweight tags and local source manifests                    | Matching tag/HEAD/source group on simulated origin/main passes; wrong HEAD, non-main ancestry, source mismatch and imported tag fail. 21 observations recorded.                                                                                                |

All three required rounds and the supplementary tag round passed on Node 22.18.0 after the final implementation. Evidence is in `evidence/*-v22.18.0.json`. The ESLint regression separately demonstrates native 1.9.1 false positives and adapted results for both parent-qualified and scoped/version-qualified selectors, while preserving an unrelated unused item.

## Validation boundaries and unexecuted gates

- Native Linux/Windows/macOS hosted matrices and Vue semantic matrix CI were not run remotely. Local macOS evidence does not establish their acceptance.
- Hosted CodeQL, dependency-review availability, Renovate onboarding, branch protection, labels, private security reporting and protected environments were not enabled or executed. Configuration/schema checks are not service acceptance.
- Actual trusted npm publication, GitHub draft/assets promotion and Vercel build/deployment were not run. The tag experiment uses a simulated local `origin/main`; CLI launch does not prove remote deployment. Those workflows remain disabled until their independent gates are enabled and accepted.
- SBOMs cover actual bundled code plus declared external ranges, not an exhaustive resolved consumer dependency graph. The schema experiment covers the generated subset and does not claim internationalized-email validation.
- The six existing high advisory entries and deprecated deployment transitive dependency remain explicit limitations. Audit failure blocks publication and deployment; it was not bypassed.

The pre-existing untracked `utils/src/demo.md` in docs-islands and unrelated dev-server-repo state were preserved. Product invariants I01–I12 remain governed by their existing owners and executable guards; local infrastructure evidence creates no human vouch or cutover authority.
