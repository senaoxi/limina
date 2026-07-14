# Domain Model

The authoritative aggregates are:

- `WorkspaceTopology`: workspace roots, activated regions, nested boundaries, packages, scopes, and exclusion provenance.
- `ProjectCatalog`: source projects, checker projects, their dedicated ownership indices, and ownership conflicts.
- `ImportFacts`: syntax occurrences, resolution observations, semantic classification, and evidence.
- `SourceDependencyGraph`: classified source dependency edges.
- `DeclarationBuildGraph`: checker reference and declaration-provider edges.
- `OutputBuildGraph`: build-output production and consumption edges.
- `PackageArtifactGraph`: package public-export and artifact-consumption relationships.
- `PackageOutput`: built-output and external package-check findings.
- `ReleaseAssessment`: packing, registry baseline, and release-policy facts.

Source ownership is unique or conflicted; checker coverage is zero-to-many; output ownership is unique or conflicted; dependency authority is resolved from the nearest package boundary. These cardinalities are not represented by a shared owner abstraction.

Stable IDs, rather than object identity, cross aggregate, projection, diagnostics, snapshot, and future extension boundaries. Mutable indices, parser objects, compiler options, resolver caches, provider instances, and artifact plans remain internal.
