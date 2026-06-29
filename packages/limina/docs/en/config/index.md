# Config Reference

Limina configuration starts from `limina.config.mjs` inside the workspace. Read the reference by topic:

- [Config File](./config-file.md): `defineConfig`, function config, `mode`, and `command`.
- [Checker Entries](./checkers.md): auto mode, `config.checkers.<name>`, `preset`, `include`, `exclude`, and fixed extensions.
- [Checker Entries](./checkers.md#vue-import-parsing): `config.imports.vue` — Vue SFC import parsing mode.
- [Source Boundary](./source-boundary.md): `config.source.include` / `exclude` — the managed source boundary for source coverage checks.
- [Source Checks](./source-checks.md): top-level `source.knip` — dependency, module, and ordinary tsconfig ownership checks.
- [Graph Rules](./graph-rules.md): `liminaOptions.graphRules`, `liminaOptions.implicitRefs`, `deny.refs`, `deny.deps`, `allow.refs`.
- [Condition Domains](./condition-domains.md): `graph.conditionDomains` — condition sets checked against declaration reference trees.
- [Proof Allowlist](./proof-allowlist.md): source coverage exceptions (`file`, `reason`).
- [Package Checks](./package-checks.md): built-output entries, `publint` / `attw` / `boundary`.
- [Release Checks](./release-checks.md): `release.contentHash`, tarball and publish hygiene.
- [Pipelines](./pipelines.md): named workflows of built-in tasks and external commands.
- [Execution Concurrency](./execution.md): concurrency limits for `execution.tasks`, checkers, package checks, and release checks.

If you only want the first check running, start with [Config File](./config-file.md) and [Checker Entries](./checkers.md). If you are preparing to publish packages, add [Package Checks](./package-checks.md).
