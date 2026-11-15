# Build with the checker

Users can build internal declarations, execute framework checking, or request
user-facing output builds with a different output contract.

## Sub-features

- `checker-build`: compile internal declaration entries with the real compiler.
- `checker-failure`: surface a source type error and recover after repair.
- `checker-typecheck`: run applicable framework leaves.
- `artifact-build`: build explicitly declared user outputs or raw compiler input.

## How to get to it (user POV)

Use `limina checker build`, `limina checker build <config> --preset tsc`,
`limina checker typecheck`, `limina build <config>`, or
`limina build <config> --raw --preset tsc`. `limina check` includes internal
checker work. These entry points do not have interchangeable output contracts.

## Driving it with control.py

Preconditions: fresh configured seed and its real TypeScript executable bridge.

- **Build:** `python3 "$CONTROL" drive "$RUN" checker limina checker build`.
  Require exit 0 and a declaration under `.limina/dts` exporting
  `answer: number`; inspect the after snapshot rather than accepting a pass line.
- **Break the type:** `printf 'export const answer: number = "wrong";\n' > "$WORK/src/index.ts"`.
  Run `python3 "$CONTROL" drive "$RUN" checker-error limina checker build`.
  Require nonzero exit and TS2322 identifying the source; pre-existing output
  files alone must not turn a failed build into success.
- **Repair:** `printf 'export const answer: number = 42;\n' > "$WORK/src/index.ts"`.
  Run with label `checker-repaired`; require exit 0 and the declaration again.
- **Framework entry:** `python3 "$CONTROL" drive "$RUN" framework limina checker typecheck`.
  The seed has no framework targets: a disabled result is expected but does not
  prove framework checking. Add a real supported framework fixture first.
- **Other build entries:** inspect `limina build --help` and the
  [build contract](../../../../skills/limina/references/cli.md#build-targets).
  Managed outputs and explicit checker configurations are not seeded. Record
  this missing precondition rather than running a different build as proof.

## Gotchas

- Internal `.limina/dts` declarations are not the production bundle.
- Raw builds can emit beside source according to the user tsconfig; keep them
  inside an isolated project with explicit output expectations.
- Watch mode requires an owned live process and termination evidence, and is
  outside this finite recorder. The default seed does not prove tsgo/vue-tsc.
