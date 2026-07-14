# Limina 0.2.0 Architecture

This directory is the implementation contract for the 0.2.0 breaking redesign. It is not a description of the 0.1 public API and does not promise a plugin product in 0.2.0.

The dependency direction is `presentation -> application -> domain`; infrastructure implements ports consumed by application workflows. Domain aggregates never depend on the CLI, logger, process execution, a real filesystem, or a resolver implementation.

Analysis is split into explicit aggregates. `SourceDependencyGraph`, `DeclarationBuildGraph`, `OutputBuildGraph`, and `PackageArtifactGraph` remain separate because their node identity, edge meaning, ownership, failure policy, and consumers differ. There is no unified architecture graph.

Validation follows one path:

```text
aggregate -> generation-scoped projection -> immutable validation view
          -> typed validator -> report input -> issue assembler
```

`AnalysisRun` carries only run identity, generation, repository snapshot token, cancellation signal, and metrics. Each concrete provider owns and releases its generation cache. Workflows depend on providers explicitly; neither a session service locator nor a dynamic capability engine exists.

## Checker duration semantics

The default `limina check` pipeline can run synchronous graph, source, and proof analysis while checker child processes execute. Parent-side `close` callbacks may therefore be delayed by main-thread work and cannot provide accurate per-checker durations.

Per-checker durations are measured inside a shared checker host process (`typecheck/process-host.ts` client and `typecheck/host-process.ts` entry), whose event loop stays responsive while the parent performs analysis. A duration means the checker child-process lifetime from spawn to exit, not the parent's delayed observation time. When the host is disabled or dies, spawns run in-process with parent-side measurement and one degradation notice; `LIMINA_CHECKER_HOST=off` forces that path.

The checker host changes only measurement ownership. Graph, source, proof, preflight generation, provider ownership, task planning, and task-level wall time remain in the existing workflow. The host ships as the dedicated `checker-host-process.js` bundle output and resolves its source form through `tsx` in development.

Related decisions are frozen in the other files in this directory. Any implementation change that crosses one of these boundaries requires an ADR and corresponding invariant tests.
