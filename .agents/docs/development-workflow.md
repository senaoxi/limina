# Development and acceptance workflow

[English](./development-workflow.md) | [简体中文](./zh/development-workflow.md)

This page owns repository setup, editing boundaries, path-test conventions and local acceptance. Read the applicable sections before changing files or running repository commands. The [architecture workflow](./architecture-workflow.md) owns invariant impact and semantic review; the [migration record](./migration.md) owns local migration scope and external acceptance gates.

## Setup and builds

Use the pnpm version pinned by [`packageManager`](../../package.json); the [toolchain record](./technology-stack.md) owns version and compatibility policies. Install explicitly with `pnpm install --frozen-lockfile`; never copy old `node_modules`. Dependency synchronization is an explicit operation because `verifyDepsBeforeRun: error` rejects an out-of-sync installation.

The [root scripts](../../package.json) define build ordering. `pnpm run build:tools` compiles private gates before build tools; `pnpm run build` builds those tools and both products. `test` builds before unit, tooling and integration tests; `smoke` builds before packed-consumer tests. `docs:build` builds both languages at base `/` with local build/commit metadata.

ESLint and release exports from `@limina/gates` load compiled output. After changing shared configuration or rules, rebuild tools from current source before inspecting effective ESLint configuration; product acceptance also requires the subsequent product build. Use the actual root config with representative production, declaration, test and script files. Final configuration inspection proves composition only; direct lint examples and the underlying tool checks complement Limina's own check orchestration and detect stale build output.

## Constraint discovery before implementation

Machine checks are authoritative for enforceable constraints, but constraints that materially narrow the valid design space must be available before implementation. Before choosing an architecture or implementation path, read the applicable agent instructions and project context and identify constraints that affect ownership, dependency direction, public/internal boundaries, generated-source authority, compatibility, or required workflow.

- Keep exact predicates, thresholds and rejection logic in types, tests, lints, scripts or CI rather than duplicating their implementation details in prose.
- Also preserve the durable intent of a machine-enforced constraint in the owning agent instruction or PCR when missing it could lead to a materially different implementation or substantial rework. Keep one prose owner and route to it instead of copying the rule across files.
- Purely mechanical, local constraints whose failure is cheap to correct may remain check-only.
- If a gate reveals an undocumented design constraint, fix the current change and update the appropriate prose owner in the same change when that constraint is durable. A prose description guides decisions but never replaces the executable guard; if prose and enforcement disagree, determine which side is stale and correct it.

## Editing boundaries

Inspect Git status before edits and preserve unrelated staged, unstaged and untracked work. Record the intended files' baseline and recheck it before writing so concurrent changes are preserved. Do not hand-edit generated `dist`, `.limina`, declarations or caches. Preserve managed markers and generated content.

Dependency versions belong in the [workspace catalogs](../../pnpm-workspace.yaml); generate lockfiles through pnpm. Before adding or replacing a third-party package, follow [dependency admission](./dependency-admission.md). Do not add reason-field governance exceptions; report the exact issue and alternatives for the user's decision.

Review structure by [responsibility and lifetime](./architecture.md#implementation-cohesion-and-boundaries), not a file-count or line-count target. Before merging or moving implementation, trace static/type/dynamic imports, package mappings, build and process entries, resource-relative paths, test discovery and documentation consumers. Preserve runtime initialization, module state, error/Promise identity and owned-versus-borrowed cleanup. Keep independent capability boundaries even when their files are small; remove forwarding layers only when they add no contract. Behavior-preserving moves do not justify changing failure states, permissions, cache identity or invalidation.

When changing tests, use [test-audit](../skills/test-audit/SKILL.md). Preserve fixture repository boundaries and deliberately invalid fixture contents; a lint or formatting fix must not erase the condition a fixture exercises.

## Portable paths in tests

Limina absolute path values are canonical portable paths and use `/` separators on every platform. Keep `node:path` for filesystem and process inputs when platform-native behavior is relevant.

Preserve absolute Windows drive roots such as `C:/` when normalizing physical inputs. Resolver ancestor queries can reach a drive root on another volume; rewriting it to `/C:` inspects a different path and incorrectly reports analysis input drift. The [path regressions](../../packages/limina/src/__tests__/path.spec.ts) cover direct and parent-traversed drive roots while preserving POSIX paths.

For fixtures that compare expected paths with resolver realpaths, canonicalize the temporary root with `realpathSync.native()` before creating the fixture path resolver. Windows short-name aliases can survive `realpathSync()` while the resolver uses native long paths. The [analysis-cache regression](../../packages/limina/src/__tests__/analysis-cache.spec.ts) keeps exact target-path assertions before and after export-condition reordering.

The [semantic repair fixtures](../../packages/limina/src/__tests__/helpers/semantic-repair.ts), [type-evidence fixtures](../../packages/limina/src/__tests__/type-evidence.spec.ts) and [packed consumers](../../smoke/helpers.ts) also use native realpaths. Direct fixture project descriptors must normalize config paths and root filenames to portable paths before constructing a compiler Program; Windows backslashes otherwise defeat exact root membership even when resolution finds the same source. Keep the request's proven absence assertion rather than accepting unknown evidence.

Production file candidates must have one portable spelling before entering a path-keyed Set or Map. The scoped `no-restricted-imports` guard in [`eslint.config.mjs`](../../eslint.config.mjs) keeps native path builders out of framework configuration discovery; [configuration tests](../../packages/limina/src/__tests__/framework-config-inputs.spec.ts) exercise mixed separators through the real collector. Use explicit `path.win32` / `path.posix` inputs and compiler Host case policy for host-independent lexical regressions. The type-evidence suite constructs real Programs for both path flavors and case policies: roots retain proven absence, while a resolved non-root without composite scope remains unknown. These tests do not establish filesystem, loader or subprocess behavior on Windows. Native paths at OS boundaries, module identifiers/file URLs, lexical comparison keys and physical identity evidence remain separate contracts; do not globally lowercase, realpath or normalize them through one function.

Convert file URLs with Node's `fileURLToPath()` before passing local CLI entries to subprocesses. A URL's `pathname` retains the leading slash of a Windows drive URL and percent-encoded characters, so it is not a native filesystem path. The [configuration-module cache tests](../../packages/limina/src/__tests__/config-module-cache.spec.ts) retain real JSON/NDJSON query subprocesses after incomplete snapshot publication.

Pass local ESM preloads to `--import` as `pathToFileURL(path).href`. A Windows drive path otherwise triggers Node's unsupported URL-scheme error before the CLI runs. The [process-cache integration regression](../../packages/limina/integration/tests/config-process-cache.spec.ts) preserves native paths for `--require` and bare package imports, and asserts startup admission before configuration evaluation or snapshot replacement.

- Never compare a Limina path value with a raw `node:path` `join`, `resolve`, `relative`, `normalize`, `dirname`, or `format` result.
- Use `fixture.path(...)` for fixture-owned absolute paths. Otherwise normalize comparisons with the [path helpers](../../packages/limina/src/__tests__/helpers/path.ts).
- Use `toPortableRelativePath()` or `toPortableRelativePaths()` for relative-path assertions.
- New test fixtures that expose `rootDir` should also expose a `path(...segments)` resolver created with `createFixturePathResolver()`.

The [portable-path comparison ESLint rule](../../packages/gates/src/eslint/plugins/portable-path-plugin/rules/portable-path-comparison-rule.ts) is an intentional guardrail. Do not disable it to make a path assertion pass; normalize the compared value instead. The [helper tests](../../packages/limina/src/__tests__/helpers/path.spec.ts) and [rule tests](../../packages/gates/src/eslint/plugins/portable-path-plugin/__tests__/portable-path-comparison-rule.spec.ts) cover the executable boundary.

The [repository gates](./gates.md) package owns executable repository checks. Before a commit, `gates:staged` reviews the actual index through the tracked pre-commit hook; `gates:check` reviews the working tree and is required by CI. Comments do not establish configuration consistency.

## Validation and handoff

Real HTTP timeout fixtures need a client budget that admits initial client and process scheduling, with a server delay longer than that budget. The [metadata](../../packages/limina/fixtures/detectors/release/registry-metadata-timeout/case.mts) and [tarball](../../packages/limina/fixtures/detectors/release/registry-tarball-timeout/case.mts) timeout fixtures retain exact request counts and identities plus typed timeout evidence, including the configured budget. Scale both timing inputs together while retaining the deliberate timeout; production limits and test-runner deadlines remain independent.

Discover available scripts from the [root manifest](../../package.json) and the owning package's `package.json`. Run the relevant `test:unit`, `test:tooling`, `test:integration`, `test:smoke`, `docs:build`, `typecheck`, `check` and `lint:packages` scripts for the change. Follow any applicable package instructions as well. Run a relevant narrow check as soon as the affected boundary becomes testable when failure could invalidate the chosen implementation; do not defer that feedback until commit or handoff. Final acceptance still reruns every required gate for the completed change.

- After changing Limina tests or path behavior, run `pnpm run test:unit`, `pnpm run typecheck`, `pnpm run lint:check` and `git diff --check` for the touched files.
- For governed production source/config changes, run `pnpm run check`; on failure, inspect `pnpm exec limina check --issues --format json`.
- For tests or executable guards, run the required unit, typecheck and lint checks.
- `lint:check` and `format:check` are read-only checks. Mutation is explicit through `lint:fix` and `format:write`.
- PCR-only changes require formatting, complete English/Chinese content parity, local links, heading and source anchors, relevant semantic evidence and Git boundary checks. They do not automatically require a full build, package or release run. Follow [bilingual maintenance](./README.md#bilingual-publishing-and-maintenance) and [writing/privacy review](./README.md#writing-and-privacy-review), including `pnpm run docs:privacy --context-records .agents/docs`.

Keep independent cross-process corruption gates in separate cases with fresh fixtures and positive restoration controls. The [configuration-module cache regression](../../packages/limina/src/__tests__/config-module-cache.spec.ts) previously grouped nine gates and twenty runner starts into one case, exceeding the unchanged per-case deadline on Linux, macOS and Windows CI. Each gate still asserts its rejection reason, no old-input adoption, validation short-circuit where applicable, and subsequent restoration after cold publication.

The [library projection regression](../../packages/limina/src/__tests__/library-projection.spec.ts) separately covers unchanged restoration, higher-priority replacement invalidation across processes, and restoration of the graph published after invalidation. Each uses a fresh fixture, exact selected-library checks and at most two runner starts. The publication control seeds and replaces bindings through separately disposed managers in one child, then verifies restoration and selected-library identity in a fresh child; the independent invalidation case retains the actual process boundary. Those three cases have a 60-second budget because even two real Node/TypeScript starts exceeded 30 seconds on Windows CI. The global test deadline stays unchanged. Teardown terminates and awaits outstanding children before removing their working directories, preventing timeout cleanup from racing a live Windows process.

The declaration-governance cases in [full-analysis-cache](../../packages/limina/src/__tests__/full-analysis-cache.spec.ts) omit default libraries that their local declaration inputs do not use, retaining Coverage, explicit-choice, independent types-contribution and checking-option revocation assertions. Their three-to-five fresh runners plus candidate Checker processes receive a 60-second case budget. The real CommonJS managed-refresh case in [execution-admission](../../packages/limina/src/__tests__/execution-admission.spec.ts) also receives 60 seconds for its Node loader and framework generations; unrelated cases retain their existing budgets. [Vue cache regressions](../../packages/limina/src/__tests__/vue-analysis-cache.spec.ts) keep the existing 60-second budget by separating Pending appearance/removal and output-target restoration/change into fresh fixtures with two or three runner starts. Adapter-version rejection retains its cold seed and restoration after rebuilding; ordinary unchanged restoration has independent coverage. These fixture changes preserve real process boundaries and semantic rejection controls, without changing production execution limits.

Decode binary `load` hook source as UTF-8 before transforming it in a fixture. Node 22.18.0 and 24.11.0 can return a `Uint8Array`; `String(source)` produces comma-separated byte values rather than JavaScript text, losing configuration exports. The configuration-module cache regression preserves string source, decodes binary source with `TextDecoder`, and checks the newly published source provenance and digest before asserting warm restoration. An old snapshot's completeness alone does not prove publication of the transformed configuration. Keep the two transform-toggle directions in separate fresh fixtures, each with positive restoration controls before and after the change, so four runner starts remain within the unchanged per-case deadline.

Before handoff or an authorized commit, review the intended diff. For PCR and saved audit results, review both language editions for privacy and technical meaning using [project-context-writing](../skills/project-context-writing/SKILL.md); report credentials only by location/category. Finish with `git diff --check`, Git status and an explicit list of executed and unexecuted validation, including failures and remaining uncertainty. Local success does not satisfy the [migration and external gates](./migration.md).
