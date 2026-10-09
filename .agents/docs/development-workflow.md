# Development and acceptance workflow

[English](./development-workflow.md) | [简体中文](./zh/development-workflow.md)

This page owns repository setup, editing boundaries, path-test conventions and local acceptance. Read the applicable sections before changing files or running repository commands. The [architecture workflow](./architecture-workflow.md) owns invariant impact and semantic review; the [migration record](./migration.md) owns local migration scope and external acceptance gates.

## Setup and builds

Use the pnpm version pinned by [`packageManager`](../../package.json); the [toolchain record](./technology-stack.md) owns version and compatibility policies. Install explicitly with `pnpm install --frozen-lockfile`; never copy old `node_modules`. Dependency synchronization is an explicit operation because `verifyDepsBeforeRun: error` rejects an out-of-sync installation.

The [root scripts](../../package.json) define build ordering. `pnpm run build:tools` compiles private gates before build tools; `pnpm run build` builds those tools and both products. `test` builds before unit, tooling and integration tests; `smoke` builds before packed-consumer tests. `docs:build` builds both languages at base `/` with local build/commit metadata.

## Constraint discovery before implementation

Machine checks are authoritative for enforceable constraints, but constraints that materially narrow the valid design space must be available before implementation. Before choosing an architecture or implementation path, read the applicable agent instructions and project context and identify constraints that affect ownership, dependency direction, public/internal boundaries, generated-source authority, compatibility, or required workflow.

- Keep exact predicates, thresholds and rejection logic in types, tests, lints, scripts or CI rather than duplicating their implementation details in prose.
- Also preserve the durable intent of a machine-enforced constraint in the owning agent instruction or PCR when missing it could lead to a materially different implementation or substantial rework. Keep one prose owner and route to it instead of copying the rule across files.
- Purely mechanical, local constraints whose failure is cheap to correct may remain check-only.
- If a gate reveals an undocumented design constraint, fix the current change and update the appropriate prose owner in the same change when that constraint is durable. A prose description guides decisions but never replaces the executable guard; if prose and enforcement disagree, determine which side is stale and correct it.

## Editing boundaries

Inspect Git status before edits and preserve unrelated staged, unstaged and untracked work. Record the intended files' baseline and recheck it before writing so concurrent changes are preserved. Do not hand-edit generated `dist`, `.limina`, declarations or caches. Preserve managed markers and generated content.

Dependency versions belong in the [workspace catalogs](../../pnpm-workspace.yaml); generate lockfiles through pnpm. Before adding or replacing a third-party package, follow [dependency admission](./dependency-admission.md). Do not add reason-field governance exceptions; report the exact issue and alternatives for the user's decision.

When changing tests, use [test-audit](../skills/test-audit/SKILL.md). Preserve fixture repository boundaries and deliberately invalid fixture contents; a lint or formatting fix must not erase the condition a fixture exercises.

## Portable paths in tests

Limina absolute path values are canonical portable paths and use `/` separators on every platform. Keep `node:path` for filesystem and process inputs when platform-native behavior is relevant.

Preserve absolute Windows drive roots such as `C:/` when normalizing physical inputs. Resolver ancestor queries can reach a drive root on another volume; rewriting it to `/C:` inspects a different path and incorrectly reports analysis input drift. The [path regressions](../../packages/limina/src/__tests__/path.spec.ts) cover direct and parent-traversed drive roots while preserving POSIX paths.

For fixtures that compare expected paths with resolver realpaths, canonicalize the temporary root with `realpathSync.native()` before creating the fixture path resolver. Windows short-name aliases can survive `realpathSync()` while the resolver uses native long paths. The [analysis-cache regression](../../packages/limina/src/__tests__/analysis-cache.spec.ts) keeps exact target-path assertions before and after export-condition reordering.

Convert file URLs with Node's `fileURLToPath()` before passing local CLI entries to subprocesses. A URL's `pathname` retains the leading slash of a Windows drive URL and percent-encoded characters, so it is not a native filesystem path. The [configuration-module cache tests](../../packages/limina/src/__tests__/config-module-cache.spec.ts) retain real JSON/NDJSON query subprocesses after incomplete snapshot publication.

Pass local ESM preloads to `--import` as `pathToFileURL(path).href`. A Windows drive path otherwise triggers Node's unsupported URL-scheme error before the CLI runs. The [process-cache integration regression](../../packages/limina/integration/tests/config-process-cache.spec.ts) preserves native paths for `--require` and bare package imports, and asserts startup admission before configuration evaluation or snapshot replacement.

- Never compare a Limina path value with a raw `node:path` `join`, `resolve`, `relative`, `normalize`, `dirname`, or `format` result.
- Use `fixture.path(...)` for fixture-owned absolute paths. Otherwise normalize comparisons with the [path helpers](../../packages/limina/src/__tests__/helpers/path.ts).
- Use `toPortableRelativePath()` or `toPortableRelativePaths()` for relative-path assertions.
- New test fixtures that expose `rootDir` should also expose a `path(...segments)` resolver created with `createFixturePathResolver()`.

The [portable-path comparison ESLint rule](../../packages/gates/src/eslint/plugins/portable-path-plugin/rules/portable-path-comparison-rule.ts) is an intentional guardrail. Do not disable it to make a path assertion pass; normalize the compared value instead. The [helper tests](../../packages/limina/src/__tests__/helpers/path.spec.ts) and [rule tests](../../packages/gates/src/eslint/plugins/portable-path-plugin/__tests__/portable-path-comparison-rule.spec.ts) cover the executable boundary.

The [repository gates](./gates.md) package owns executable repository checks. Before a commit, `gates:staged` reviews the actual index through the tracked pre-commit hook; `gates:check` reviews the working tree and is required by CI. Comments do not establish configuration consistency.

## Validation and handoff

Discover available scripts from the [root manifest](../../package.json) and the owning package's `package.json`. Run the relevant `test:unit`, `test:tooling`, `test:integration`, `test:smoke`, `docs:build`, `typecheck`, `check` and `lint:packages` scripts for the change. Follow any applicable package instructions as well. Run a relevant narrow check as soon as the affected boundary becomes testable when failure could invalidate the chosen implementation; do not defer that feedback until commit or handoff. Final acceptance still reruns every required gate for the completed change.

- After changing Limina tests or path behavior, run `pnpm run test:unit`, `pnpm run typecheck`, `pnpm run lint:check` and `git diff --check` for the touched files.
- For governed production source/config changes, run `pnpm run check`; on failure, inspect `pnpm exec limina check --issues --format json`.
- For tests or executable guards, run the required unit, typecheck and lint checks.
- `lint:check` and `format:check` are read-only checks. Mutation is explicit through `lint:fix` and `format:write`.
- PCR-only changes require formatting, complete English/Chinese content parity, local links, heading and source anchors, relevant semantic evidence and Git boundary checks. They do not automatically require a full build, package or release run. Follow [bilingual maintenance](./README.md#bilingual-publishing-and-maintenance) and [writing/privacy review](./README.md#writing-and-privacy-review), including `pnpm run docs:privacy --context-records .agents/docs`.

Keep independent cross-process corruption gates in separate cases with fresh fixtures and positive restoration controls. The [configuration-module cache regression](../../packages/limina/src/__tests__/config-module-cache.spec.ts) previously grouped nine gates and twenty runner starts into one case, exceeding the unchanged per-case deadline on Linux, macOS and Windows CI. Each gate still asserts its rejection reason, no old-input adoption, validation short-circuit where applicable, and subsequent restoration after cold publication.

Before handoff or an authorized commit, review the intended diff. For PCR and saved audit results, review both language editions for privacy and technical meaning using [project-context-writing](../skills/project-context-writing/SKILL.md); report credentials only by location/category. Finish with `git diff --check`, Git status and an explicit list of executed and unexecuted validation, including failures and remaining uncertainty. Local success does not satisfy the [migration and external gates](./migration.md).
