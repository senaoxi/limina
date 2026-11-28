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
- **Select the checker target.** On a fresh seed run
  `python3 "$CONTROL" drive "$RUN" explicit limina checker build tsconfig.json --preset tsc`.
  Require the same internal declaration and check that `src/index.js` is absent.
- **Compare artifact builds.** Run
  `python3 "$CONTROL" drive "$RUN" no-outputs limina build tsconfig.json` on
  the unmodified config. Expect exit 1 and the diagnostic about missing
  `liminaOptions.outputs`. Then run
  `python3 "$CONTROL" drive "$RUN" raw limina build tsconfig.json --raw --preset tsc`.
  Expect exit 0 and a new `src/index.js` exporting `answer = 42`.
- **Declare an output directory.** In a fresh seed, add
  `"liminaOptions": {"outputs": {"rootDir": "./src", "outDir": "./dist"}}`
  at the top level of `tsconfig.json`. Run
  `python3 "$CONTROL" drive "$RUN" managed limina build tsconfig.json`.
  Require exit 0, `dist/index.js` exporting `answer` and no `src/index.js`.
  See the [build contract](../../../../skills/limina/references/cli.md#build-targets)
  for supported targets.

## Gotchas

- Internal `.limina/dts` declarations are not the production bundle.
- Raw builds can emit beside source according to the user tsconfig; keep them
  inside an isolated project with explicit output expectations.
- Watch mode requires an owned live process and termination evidence, and is
  outside this finite recorder. The default seed does not prove tsgo/vue-tsc.
