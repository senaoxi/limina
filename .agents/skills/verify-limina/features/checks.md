# Run checks and inspect findings

Users run governance checks, then query the stored result without rerunning the
checks. A successful query can describe an unsuccessful or older run.

## Sub-features

- `check-default`: run the five default tasks.
- `check-standalone`: run source or proof validation directly.
- `check-findings`: query current issues in JSON, NDJSON or human output.
- `check-pipeline`: run an explicitly configured named pipeline.
- `check-profile`: capture an analysis report for one check invocation.

## How to get to it (user POV)

Use `limina check`, `limina source check`, `limina proof check`, or
`limina check --issues`. A named pipeline uses `limina check <name>` and must
exist in the config; the default seed defines none.

## Driving it with control.py

Preconditions: fresh configured seed with no `scripts/tool.ts`.

- **Baseline:** `python3 "$CONTROL" drive "$RUN" check limina check`.
  Require exit 0, `limina check passed`, four passed tasks and a disabled
  framework typecheck; inspect emitted internal declarations.
- **Read:** `python3 "$CONTROL" drive "$RUN" issues query check --issues --format json`.
  Require a completed inventory with a passed run and no issues. Match its
  command and timestamp to the captured action. Compare before/after inventories
  to establish this query did not write project state.
- **Create an omission:** `mkdir -p "$WORK/scripts"` then
  `printf 'export const tool = true;\n' > "$WORK/scripts/tool.ts"`.
  Run `python3 "$CONTROL" drive "$RUN" uncovered limina check`; require exit 1
  and a proof coverage failure, not an import/startup failure.
- **Read the failure:** `python3 "$CONTROL" drive "$RUN" uncovered-issues query check --issues --task proof:check --format json`.
  Require `LIMINA_PROOF_UNCOVERED_SOURCE_FILE` identifying `scripts/tool.ts`.
  Repeat with `--format ndjson` and a new label to exercise streaming records;
  `--verbose` without `--format` exercises human findings.
- **Repair:** remove only `$WORK/scripts/tool.ts`, rerun `check` with label
  `repaired`, then query with label `repaired-issues`. Require a fresh passed
  inventory without the old issue.
- **Standalone entries:** on a fresh configured seed run
  `python3 "$CONTROL" drive "$RUN" source limina source check` and
  `python3 "$CONTROL" drive "$RUN" proof limina proof check`. Require exit 0
  and each command's pass result. For a standalone failure, use the invocation
  query printed by that command. A query without `--invocation` reads the
  latest default or named check.
- **Named pipeline.** Set `$WORK/limina.config.mjs` to
  `export default { pipelines: { audit: ['proof:check'] } };` on a fresh seed.
  Run `python3 "$CONTROL" drive "$RUN" audit limina check audit`, then
  `python3 "$CONTROL" drive "$RUN" audit-issues query check --issues --format json`.
  Require `run.command` to be `limina check audit`, a passed result and
  `proof:check` as the only pipeline step. The inventory also records preparation.
- **Analysis profile.** On a fresh seed run
  `python3 "$CONTROL" drive "$RUN" forced limina check --force --profile-output ../profiles`.
  Require exit 0 and one JSON file under `$RUN/profiles/`. Check
  `schemaVersion: 2` and the invocation's `command` (`limina check`),
  `result` (`passed`) and `cachePolicy` (`forced`).
  Run `python3 "$CONTROL" drive "$RUN" query-profile query check --issues --profile --format json`.
  Expect exit 1 and a profiling diagnostic on stderr. See the
  [profiling options](../../../../docs/en/cli.md#profile-analysis) for supported commands.

## Gotchas

- Config import failure can leave an earlier completed inventory visible. Keep
  the attempted action's stderr/exit and compare recorded command/time.
- To challenge query independence, replace the disposable config with
  `throw new Error('query must not import this');`, then use `query ... check
--issues --format json`. It should read prior evidence. An ordinary new check
  should fail; do not call the older passed inventory current success.
- The seed has no Astro/Svelte targets or Knip policy. Disabled checks are not
  coverage of those features. `--format json` is a query flag, not execution JSON.
