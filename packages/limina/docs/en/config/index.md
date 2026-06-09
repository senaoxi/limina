# Config Reference

Limina configuration starts from `limina.config.mjs` inside the workspace. Read the reference by topic:

- [Config File](./config-file.md): `defineConfig`, function config, `mode`, `command`, and `strict`.
- [Checker Entries](./checkers.md): `config.checkers.<name>`, `preset`, `entry`, and fixed extensions.
- [Source Boundary](./source-boundary.md): `config.source.include` / `exclude` — the governed-file boundary for proof coverage.
- [Source Checks](./source-checks.md): top-level `source.knip` / `tsconfigOwnership` — dependency, module, and ordinary tsconfig ownership checks.
- [Graph Rules](./graph-rules.md): `graph.rules.<label>`, `deny.refs`, `deny.deps`, `allow.refs`.
- [Condition Domains](./condition-domains.md): `graph.conditionDomains` — bundler condition sets aligned with declaration reference trees.
- [Proof Allowlist](./proof-allowlist.md): source coverage exceptions (`file`, `reason`).
- [Package Checks](./package-checks.md): built-output entries, `publint` / `attw` / `boundary`.
- [Release Checks](./release-checks.md): `release.contentHash`, tarball and publish hygiene.
- [Pipelines](./pipelines.md): named workflows of built-in tasks and external commands.

If you only want the first check running, start with [Config File](./config-file.md) and [Checker Entries](./checkers.md). If you are preparing to publish packages, add [Package Checks](./package-checks.md).
