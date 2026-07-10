# General Guidelines for working with Limina

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
