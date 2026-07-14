# Public API Boundary

0.2.0 exports the redesigned configuration and programmatic command surface only. Validation registries, providers, projections, internal input kinds, and views are not public extension APIs.

The future architecture policy surface selects six stable views: workspace, projects, source dependencies, declaration build, output build, and package artifacts. `ImportFactsValidationView` remains internal because occurrence and resolver semantics are less stable. Package-output and release validation belong to separate future product surfaces.

Public issue output is assembled from `GovernanceIssue`. Rule ID, severity, message, stable issue ID, origin, documentation, sorting, and machine-readable representation come from one descriptor-driven path.

There is no compatibility export for the 0.1 config, issue snapshot, generated manifest, CLI hierarchy, or internal core classes.
