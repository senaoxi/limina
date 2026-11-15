# Initialize a project

Initialization adds Limina configuration and build metadata to an existing
package without installing its dependencies.

## Sub-features

- `init-yes`: accept default initialization without prompts.
- `init-preserve`: preserve existing source inputs and an existing build script.
- `init-interactive`: answer adoption prompts and the optional skill prompt.

## How to get to it (user POV)

Run `limina init --yes` or `limina init` from the intended package directory.

## Driving it with control.py

Preconditions: use Launch with `setup ... --bare`. The package and TypeScript
bridges exist, but there is no `limina.config.mjs` or `.limina` state.

- **Initialize:** `python3 "$CONTROL" drive "$RUN" init limina init --yes`.
  Require exit 0, a created `limina.config.mts`, `.gitignore` coverage and a `limina:build`
  script containing `limina checker build` in `package.json`. Compare captured
  inputs: `src/index.ts` and `tsconfig.json` must be unchanged.
- **Check readiness:** `python3 "$CONTROL" drive "$RUN" init-check limina check`.
  The bare seed lacks typecheck coverage for the new config. Preserve exit 1,
  then run `python3 "$CONTROL" drive "$RUN" init-issues query check --issues --task proof:check --format json`.
  Require `LIMINA_PROOF_UNCOVERED_SOURCE_FILE` identifying `limina.config.mts`;
  report this unmet precondition rather than marking project readiness passed.
- **Cover the generated config:** explicitly add `limina.config.mts` to the
  `include` array in `$WORK/tsconfig.json`, preserving `src/**/*.ts`. Run
  `python3 "$CONTROL" drive "$RUN" init-repaired limina check`, then
  `python3 "$CONTROL" drive "$RUN" init-repaired-issues query check --issues --format json`.
  Require exit 0, a fresh passed run without issues and generated declarations.
  Retain both the failed journey and this input repair in the proof.
- **Preservation variant:** on a fresh bare seed, add
  `"limina:build": "node -e \"console.log('existing')\"` to `scripts` in the
  manifest before init. Run the same init command and require that exact script
  to survive; do not execute it as a substitute for `limina check`.
- **Interactive entry:** report untested with this recorder. Use an owned
  interactive PTY and capture the prompt/action sequence if this entry is in
  scope; do not infer prompt behavior from `--yes`.

## Gotchas

- Init clears the selected root's generated `.limina`; never use it as a repair
  command on a user's active project.
- `--yes` skips optional skill installation. A successful init does not prove
  installation of the consumer skill or dependency packages.
- The seed's dependencies are local bridges. A fresh-install claim needs the
  existing packed-consumer smoke path.
- Init creates `limina.config.mts`; it does not add that file to the seed's
  source-only tsconfig. The initial readiness failure is a missing coverage
  precondition. Do not suppress the proof rule or omit the failed attempt.
