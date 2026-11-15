# Limina verification map

Use the [launch instructions](../SKILL.md#launch), read this index, then select a
feature. These are executable journey recipes, not claims that every entry has
already been tested.

## Baseline preconditions

- A successful current build, Python 3 on POSIX, and a fresh helper-owned run.
- `REPO`, `CONTROL`, `RUN`, `WORK` and `EVIDENCE_ROOT` are set as in Launch.
- The seed has one package, `src/index.ts`, strict NodeNext checking and real
  TypeScript libraries. Configured seeds use `export default {}`.
- Each recipe starts from a fresh seed unless it explicitly continues a prior
  action. Never compensate for a missing precondition by weakening the journey.

## Driving conventions

Use `python3 "$CONTROL" drive "$RUN" LABEL limina ARGS...` for terminal actions,
`migrate` for the separate migration binary, and `query` for stored findings.
Keep labels unique. Inspect `result.json` and terminal text; inspect query JSON
semantics rather than accepting its process exit. Record exact input edits and
entry points. Run cleanup after every attempt and check evidence survives.

## Proof and skip reporting

Each proof includes the action, resulting state, and expected side effects.
Retain failed captures. Report unmet prerequisites, attempted commands, skipped
entries and untested platforms. One successful entry does not cover its siblings.
Run applicable baseline and adversarial rounds from active AGENTS; the map does
not replace repository acceptance or existing unit/integration/smoke suites.

## Features

- [Initialization](initialization.md): noninteractive adoption and preserved inputs.
- [Graph](graph.md): validation, materialization and JSON export views.
- [Checks and findings](checks.md): default/standalone checks and stored queries.
- [Builds](builds.md): real declaration checking, failures and output boundaries.
- [Migration](migration.md): separate CLI preview and explicit apply prerequisites.

Package/release checks need configured package entries, real distributable
outputs and, for some release checks, registry state. They are not seeded here;
use [package guidance](../../../../skills/limina/references/package-checks.md)
and the existing packed-consumer/release fixtures when requested. The public
configuration API and documentation website also need their own verification
surface. This map makes no claim of exhaustive CLI coverage.
