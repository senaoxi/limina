# Preview source migration

The separate migration CLI shows proposed TypeScript configuration edits before
an explicitly authorized apply with fresh-process input verification.

## Sub-features

- `migration-preview`: inspect the complete proposed file plan without applying it.
- `migration-apply`: persist authorized edits and inspect the resulting project.
- `migration-interactive`: confirm scope through the prompt.

## How to get to it (user POV)

Use `limina-migrate --dry-run --yes` for preview, or `limina-migrate --yes` for
application. Omitting `--yes` uses the scope prompt. The deprecated
`limina migration` forwarder is a separate entry that can download a tool.

## Driving it with control.py

Preconditions: fresh configured seed, trusted neutral config, built migration
CLI and TypeScript bridge. The preview needs no Git repository.

- **Preview:** `python3 "$CONTROL" drive "$RUN" preview migrate --dry-run --yes`.
  Require exit 0 and a complete Preview file-operation plan. Compare
  `$RUN/preview/before/inventory.json` and `after/inventory.json` byte-for-byte;
  inspect the copied source config and absence of new `.limina/migration` audit
  files. This proves filesystem behavior only for the trusted seed.
- **Apply entry:** the seed is not an independently initialized clean Git
  repository. Report that precondition as unmet. If apply is requested, prepare
  an isolated clean repository using the existing migration fixture workflow,
  preserve its initial ref and status, then drive `migrate --yes`. Check each
  planned file against actual changes, retained audit records and a subsequent
  ordinary `limina check`; preview success does not substitute for these steps.
- **Interactive/forwarder entries:** report untested unless separately driven
  with prompt input or a known local matching forwarder target. Do not use the
  deprecated forwarder as an implicitly offline preview command.

## Gotchas

- `--yes` confirms scope; it does not approve dirty-worktree or hardlink writes.
- A dry run skips migration-controlled writes and audit publication, but config
  modules and third-party code can execute side effects. Do not generalize the
  seed's unchanged files to all configs, network, browser or Git-ref behavior.
- Apply verification uses the migration tool's embedded implementation. It is
  not a full run of the project's installed Limina or production build.
