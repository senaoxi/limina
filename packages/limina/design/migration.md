# 0.2.0 Breaking Migration

The redesign intentionally removes the 0.1 internal core, generic preflight cache, string-derived diagnostics, and coupled runner APIs. Callers must move to the 0.2 command and programmatic workflow surface; there is no fallback or dual execution path.

Config, issue output, generated manifests, and command names are versioned as new contracts. Migration documentation must record each shipped change as old behavior, defect, new behavior, rationale, and the required user edit. It must be generated from the final implementation, not from intermediate design examples.

Generated files are reconciled through an artifact plan. A check or export invocation never updates generated state as a side effect.
