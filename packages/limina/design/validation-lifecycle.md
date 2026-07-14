# Validation Lifecycle

1. Load, parse, validate, and resolve configuration.
2. Resolve enabled built-in registrations and validate all rule options.
3. Create an `AnalysisRun` for a repository snapshot and generation.
4. Group registrations by internal input kind.
5. Construct required fixed stage tasks with explicit provider dependencies.
6. Providers build aggregates; projectors build one immutable view per kind.
7. Validators run locally and report through the minimal context.
8. The assembler creates and sorts governance issues.
9. Renderers consume issues without business decisions.
10. Provider lifecycle releases the completed generation.

Reports become governance issues. Invalid options are configuration errors. A thrown validator or provider/projector failure is an execution failure. Aborted work is a cancellation failure. Dispatcher receives constructed tasks and never owns providers.
