---
name: verify-limina
description: 'Drive the real Limina CLI in disposable projects, capture terminal and filesystem evidence, and verify initialization, graph, checks, builds or migration previews. Use for user-journey verification; use limina-change-verification for repository acceptance and test selection.'
---

# Verify Limina through its CLI

Read the [feature map](features/README.md), then the requested feature. This is
the repository's local CLI control skill. The separately installable
[consumer skill](../../../skills/limina/SKILL.md) owns adoption guidance;
[limina-change-verification](../limina-change-verification/SKILL.md) owns change
acceptance. Public configuration APIs and the documentation website are secondary
surfaces and are outside this terminal harness.

## Launch

Run from the Limina checkout in a POSIX shell. Use the Node range and pnpm pin in
`package.json`; Python 3 with `pty` is also required. No service, port, account,
database, or authentication is needed. Build once, then each drive gets its own
PTY and 60-second watchdog through the existing
[terminal recorder](../../../scripts/docs/capture-terminal.py).

```sh
REPO=$(pwd -P)
CONTROL="$REPO/.agents/skills/verify-limina/scripts/control.py"
EVIDENCE_ROOT="$HOME/Project/dev-server-repo"
mkdir -p "$EVIDENCE_ROOT/repros/verify-limina"
pnpm install --frozen-lockfile > "$EVIDENCE_ROOT/repros/verify-limina/install.log" 2>&1
pnpm run build > "$EVIDENCE_ROOT/repros/verify-limina/build.log" 2>&1
RUN=$(python3 "$CONTROL" setup "$EVIDENCE_ROOT/repros/verify-limina")
WORK="$RUN/workspace"
python3 "$CONTROL" doctor "$RUN" > "$RUN/doctor.json"
```

Stop if installation or build fails; retain the logs. Use distinct log names when
another run is active. Set `EVIDENCE_ROOT` to the evidence workspace required by
the active AGENTS if it differs. `setup` creates a unique run directory, a minimal
ESM package, strict NodeNext TypeScript input with ordinary standard libraries,
and a neutral Limina config. For initialization, append `--bare` to `setup`.

Readiness means doctor passes and the selected journey's first real command
reaches its expected result. `ready: true` alone proves tool availability, not
validity of the input project. Use `drive ... limina check` for the seeded
configured project's full readiness check. Cleanup below applies after failures
as well as success; there is no daemon to leave running.

The seed bridges the checkout's built Limina and installed TypeScript via local
`node_modules` links and a `tsc` executable link. It does not install a standalone
consumer package, invoke a registry, or prove packaging completeness. Use the
existing `pnpm run test:smoke` for packed-consumer validation. Build before setup;
doctor detects subsequent distribution drift, not source edits omitted from a
build. Rebuild and start a new run after source changes.

## Doctor

```sh
python3 "$CONTROL" doctor "$RUN"
```

This read-only check verifies workspace ownership, absence of a competing driver,
Node identity, both built distributions' hashes, dependency link targets and
TypeScript version, core help and migration version. Core `--version` currently
prints nothing; use the built manifest plus hashes and working help. Missing
config is expected only before init. Run doctor first whenever a drive looks off.

## Drive

```sh
python3 "$CONTROL" drive "$RUN" check limina check
python3 "$CONTROL" drive "$RUN" issues query check --issues --format json
```

Use a new lowercase evidence label per action. `limina` and `migrate` invoke the
real built binaries in isolated PTYs; `query` captures stdout/stderr separately
for machine-readable `check --issues` results. The helper returns the child's
exit code, so expected failures must be handled explicitly in a script. A query
exit code of zero is not a successful check: inspect its inventory and run result.

Each run owns one workspace and refuses concurrent drives through `.busy`.
Use separate `setup` results for simultaneous journeys. Never point the harness
at the user's project, share a mutable workspace, or run watch mode through its
finite watchdog. The distributions and TypeScript installation are shared read
inputs: finish active drives before rebuilding or reinstalling them. The recorder
is POSIX-only; native Windows PTY behavior requires
a separate Windows run. Interactive prompt journeys need an agent-owned PTY
that accepts input; this recorder exercises `--yes` paths, not prompt answers.

## Evidence

Artifacts live in `$RUN`, outside `$RUN/workspace`:

- `owner.json`, `seed/`, and `doctor.json` identify the build and original inputs.
- Each action directory records argv/cwd/transport, terminal chunks and text or
  separate query streams, exit code, and before/after file copies with SHA-256
  inventories. `node_modules`, `.git`, and the ownership marker are excluded;
  symlinks elsewhere are recorded without traversal.
- `cleanup-*/state/` preserves final inputs, outputs and `.limina` records.
  `cleanup.json` records removal of the workspace.

Exercise the user command and inspect the resulting files and a second public
view where available. Do not replace a CLI journey with internal setters, mocked
checkers, or precomputed results. A compiler failure must include its diagnostic;
an unrelated startup failure is not the intended negative control. Framework
tasks marked disabled are not framework coverage. Captures are local evidence;
review paths and metadata before publishing them.

Follow the active verification protocol: record a baseline and at least three
independent adversarial rounds, with intent, differing conditions, exact commands
and results, before a definitive empirical claim. Useful challenges are compiler
type errors, uncovered source plus stale-query controls, and independent graph
export or preview side-effect observations. Scope conclusions to the journeys
actually executed. Read the map's omitted-entry notes before claiming a feature
complete. A dry-run name is insufficient: compare inventories, and observe
network/Git/browser effects separately when the claim covers them. Executable
config is not sandboxed; use only the trusted seed here.

## Cleanup

```sh
python3 "$CONTROL" cleanup "$RUN"
test ! -e "$WORK"
test -s "$RUN/check/terminal.json"
test -s "$RUN/issues/stdout.txt"
test -s "$RUN/cleanup.json"
```

Adjust the evidence checks to the labels actually driven. Cleanup saves a final
snapshot and removes only the owned `workspace`; it is repeatable and keeps all
proof artifacts. The existing recorder terminates its own process group on
timeout/error and waits for it. Do not kill processes by name. If the controller
itself was force-killed, inspect its recorded argv and live process ownership
before terminating those processes and removing a stale `.busy` directory;
cleanup deliberately refuses while that lock exists. A timeout's `error.json`
is failed evidence; the upstream recorder may not retain partial terminal chunks.

## Helpers

[scripts/control.py](scripts/control.py) is executable and uses Python's standard
library plus the repository's existing PTY recorder. Its four commands are shown
above: `setup`, `doctor`, `drive`, `cleanup`. It adds no package dependency or
production hook. Existing subprocess integration fixtures own automated CLI
regressions; this helper supplies persistent, reviewable user-journey artifacts.

Use `/maintain-verification-skill` to keep the feature map aligned with changes.
