# Invariants

- A source file has at most one accepted source-project owner. Multiple candidates are a structured governance issue.
- Checker coverage is intentionally many-valued and must not be coerced into source ownership.
- An output source has at most one output-build owner.
- A real nested `pnpm-workspace.yaml` is an automatic owner-local governance boundary, never a public exclusion candidate.
- A workspace package belongs to one activated region after topology validation.
- Resolution is performed before validation. Validators never read files or resolve imports.
- Declaration-provider edges and declaration-reference edges retain checker identity.
- Generated declaration cycles are diagnosed from `DeclarationBuildGraph`; they are not hidden by a generic graph cycle rule.
- Check/export workflows are read-only. Only explicit generate/build application paths apply an `ArtifactPlan`.
- A generation observes one repository snapshot token. External commands and watched file changes create a new generation.
- A validation view is built at most once per kind and generation.
- Rules do not depend on rule order, other rule results, or mutable shared state.
