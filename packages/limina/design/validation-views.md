# Validation Views

Views are stable-ID-driven, immutable, structured-clone-compatible DTOs. They contain no `Map`, `Set`, class instance, function, provider, cache, filesystem, resolver, scheduler, `AnalysisRun`, or aggregate object identity.

A projection subsystem owns a generation-scoped immutable reference pool for file, project, package, and location DTOs. Concrete views share those DTO references and allocate only domain-specific edges and indexes. Each kind is projected once per generation regardless of the number of rules.

Production freezes leaf DTOs and top-level arrays and records. It does not recursively deep-freeze a large graph or traverse it a second time. Tests recursively verify frozen plain data, attempt mutation, reject behavior-bearing values, and assert cross-view reference sharing.

Projection cost is `O(V + E)`. Metrics estimate bytes from entry counts and string lengths; they never serialize the complete view or invoke a heap profiler.
