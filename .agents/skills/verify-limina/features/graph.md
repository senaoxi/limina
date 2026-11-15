# Inspect and prepare the graph

Graph commands validate project relations, materialize internal configuration,
and export package relations for inspection.

## Sub-features

- `graph-check`: validate the current project model.
- `graph-prepare`: write managed graph files.
- `graph-export`: inspect `all`, `source` and `artifact` views.

## How to get to it (user POV)

Use `limina graph check`, `limina graph prepare`, or `limina graph export`.
The default `limina check` also runs graph validation; cover it separately when
claiming both standalone and orchestrated entry points.

## Driving it with control.py

Preconditions: fresh configured seed. Its single package has no cross-package
edge; an empty edges array is expected and is not evidence for edge inference.

- **Validate:** `python3 "$CONTROL" drive "$RUN" graph-check limina graph check`.
  Require exit 0 and `limina graph passed`.
- **Prepare:** `python3 "$CONTROL" drive "$RUN" graph-prepare limina graph prepare`.
  Require exit 0 and actual managed JSON configs under `.limina/tsconfig` in the
  after snapshot. Check does not by itself prove materialization.
- **Export:** `python3 "$CONTROL" drive "$RUN" graph-all limina graph export --view all --output graph-all.json`.
  Parse `$WORK/graph-all.json` and require the seeded package node and no edges.
  Repeat with labels `graph-source`, `graph-artifact`, matching `--view` and
  `--output` values. Each file must identify its requested view.
- **Invalid view:** `python3 "$CONTROL" drive "$RUN" graph-invalid limina graph export --view invalid --output invalid.json`.
  Require nonzero exit, a view validation diagnostic and no `invalid.json`.
- **Stdout entry:** omit `--output` with a new label and parse the JSON in the
  terminal text; keep the command result, not only the exported file path.

## Gotchas

- The single-package seed does not cover workspace edges, references, cycles or
  framework ownership. Add real producer/consumer fixtures for those claims.
- A standalone failure may write issue evidence. Do not describe graph checks as
  universally filesystem-pure.
- Export files go inside the disposable workspace so cleanup cannot remove an
  unrelated file; the helper retains their contents in the action snapshot.
