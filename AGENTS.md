# General Guidelines for working with Limina

## Architecture knowledge maintenance

- Start from [the Limina PCR map](.agents/docs/limina.md) for architecture work; establish behavior from the current working tree before reconciling prose.
- When changing identity, authority, phase contracts, dependency relations, cache/context lifetime, failure semantics or artifact mutation, identify affected [core invariants](.agents/docs/limina-invariants.md) and update the owning PCR page and the nearest relevant executable guard in the same change.
- Use the [review workflow](.agents/docs/limina-architecture-workflow.md) to explain invariant impact, concrete counterexamples, validation and remaining uncertainty. A behavior-preserving move needs link maintenance, not a new architectural rule.
- Every PCR update must synchronously maintain the complete English/Chinese pair with the same filename in `.agents/docs/` and `.agents/docs/zh/`, both tracked by Git; follow the [repository bilingual rule](AGENTS.md#bilingual-pcr-maintenance).
- Keep each current truth in one prose owner. Do not turn unstamped interpretation into human intent or a permanent compatibility promise.

## Path contracts in tests

- Limina absolute path values are canonical portable paths and use `/` separators on every platform.
- Keep `node:path` for filesystem and process inputs when platform-native behavior is relevant.
- Never compare a Limina path value with a raw `node:path` `join`, `resolve`, `relative`, `normalize`, `dirname`, or `format` result.
- Use `fixture.path(...)` for fixture-owned absolute paths. Otherwise normalize comparisons with the helpers in `src/__tests__/helpers/path.ts`.
- Use `toPortableRelativePath()` or `toPortableRelativePaths()` for relative-path assertions.
- New test fixtures that expose `rootDir` should also expose a `path(...segments)` resolver created with `createFixturePathResolver()`.

The portable-path comparison ESLint rule is an intentional guardrail. Do not disable it to make a path assertion pass; normalize the compared value instead.

## Validation

After changing Limina tests or path behavior, run:

- `pnpm run test:unit`
- `pnpm run typecheck`
- `pnpm run lint:check`
- `git diff --check` for the touched files

## Repository workflow

Read `.agents/docs/README.md` and the relevant paired records before edits. Inspect Git status and preserve unrelated work. Use pnpm 11.28.3; install explicitly with `pnpm install --frozen-lockfile`. Build private tools with `pnpm run build:tools`; `pnpm run build` builds tools and the product. Never copy old node_modules or regenerate Logaria as part of this migration.

Run the relevant `test:unit`, `test:tooling`, `test:integration`, `test:smoke`, `docs:build`, `typecheck`, `check` and `lint:packages` scripts. Lint and formatting checks are `lint:check` and `format:check`; mutation is explicit through `lint:fix` and `format:write`. Use `.agents/skills/test-audit/SKILL.md` when changing tests. Preserve fixture repository boundaries and deliberately invalid fixture contents.

Do not hand-edit generated `dist`, `.limina`, declarations or caches. Dependency versions belong in catalogs; generate lockfiles through pnpm. Read the dependency-admission record before adding third-party dependencies. Do not add reason-field governance exceptions; report the exact issue and alternatives for the user's decision. Keep full English/Chinese PCR pairs synchronized; never add a vouch or decision ledger without explicit direction.

This repository consumes registry Logaria through the dev catalog. CI rejects temporary Logaria links; remote platform acceptance, npm publication and documentation deployment remain subject to their gates in `.agents/docs/migration.md`. Do not push, publish, replace old consumers or remove old source as part of local migration work. Finish with `git diff --check`, Git status, and an explicit list of executed and unexecuted validation.

## Commit messages

Follow the existing Git log when choosing Conventional Commit types, scopes and wording. Name the affected subsystem when a scope is useful. Omit the scope for cross-cutting changes; do not use `limina` as a universal scope. Preserve imported historical commit messages.

## Bilingual PCR maintenance

English topics live at `.agents/docs/<name>.md`; complete Chinese counterparts live at `.agents/docs/zh/<name>.md`. Maintain both editions in the same change, with matching filenames, meaning, examples, evidence dates, limitations and provenance. Both editions must be tracked by Git. Update both maps and cross-links together, compare sections and heading anchors, and do not treat translation as a new validation or vouch.
