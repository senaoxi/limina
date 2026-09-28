# General Guidelines for working with Limina

## Architecture knowledge maintenance

- Start from [the Limina PCR map](../../.agents/docs/limina.md) for architecture work; establish behavior from the current working tree before reconciling prose.
- When changing identity, authority, phase contracts, dependency relations, cache/context lifetime, failure semantics or artifact mutation, identify affected [core invariants](../../.agents/docs/limina-invariants.md) and update the owning PCR page and the nearest relevant executable guard in the same change.
- Use the [review workflow](../../.agents/docs/limina-architecture-workflow.md) to explain invariant impact, concrete counterexamples, validation and remaining uncertainty. A behavior-preserving move needs link maintenance, not a new architectural rule.
- Every PCR update must synchronously maintain the complete English/Chinese pair with the same filename in `.agents/docs/` and `.agents/docs/zh/`, both tracked by Git; follow the [repository bilingual rule](../../AGENTS.md#bilingual-pcr-maintenance).
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

- `pnpm nx run limina:test:unit`
- `pnpm nx run limina:typecheck`
- `pnpm nx run limina:lint`
- `git diff --check` for the touched files
