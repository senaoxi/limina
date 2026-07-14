# Architecture Policy Use Cases

This matrix fixes the minimum field contract. Each policy is implementable from one future public hook; endpoint summaries prevent mutable state shared across hooks.

| Policy                    | View                             | Required fields                                                                     |
| ------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| Layered dependency        | `SourceDependencyValidationView` | source/target project and package IDs, labels, edge kind, evidence                  |
| Team/domain boundary      | `SourceDependencyValidationView` | endpoint project summaries, team/domain labels, stable IDs, boundary classification |
| Contract package          | `PackageArtifactValidationView`  | package role, public/private export, source/artifact edge, dependency direction     |
| Node built-in restriction | `SourceDependencyValidationView` | `node-builtin` target, specifier, importer project/package, location                |
| Public exports boundary   | `PackageArtifactValidationView`  | exports, selected subpath, resolved target kind, access outcome                     |
| Declaration cycle         | `DeclarationBuildValidationView` | reference/provider edges, SCC membership, checker/build engine identity             |
| Dependency depth          | `SourceDependencyValidationView` | stable roots, nodes, edges, project/package summaries                               |
| Workspace region policy   | `WorkspaceValidationView`        | regions, boundaries, package membership, exclusion provenance                       |

Raw syntax occurrences are unnecessary for these policies. If a later occurrence-level policy proves otherwise, the existing internal import-facts view may be exposed separately without changing import collection or graph inference.
