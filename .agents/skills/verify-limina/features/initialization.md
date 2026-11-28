# Initialize a project

Initialization adds Limina configuration and build metadata to an existing
package without installing its dependencies.

## Sub-features

- `init-yes`: accept default initialization without prompts.
- `init-preserve`: keep source inputs and unrelated scripts when initializing.
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
- **Existing scripts.** On a fresh bare seed, set `scripts.build` to
  `echo local-build` and `scripts["limina:build"]` to `echo custom-limina-build`
  in `package.json`. Run the same `init --yes` drive and compare the captured
  manifests. Expect `build` to retain its value and `limina:build` to become
  `limina checker build`. The `--yes` flag accepts the overwrite prompt.
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
