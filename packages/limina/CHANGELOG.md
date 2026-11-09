<!-- markdownlint-disable MD024 -->

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0-beta.3] - 2026-11-09

### Features

- feat(checker): separate graph authority from tsgo execution ([e9049e9b](https://github.com/senaoxi/limina/commit/e9049e9b))

### Bug Fixes

- fix: compare declaration requests by compiler key ([e0d1b244](https://github.com/senaoxi/limina/commit/e0d1b244))
- fix: preserve compiler path identity for declarations ([cd74e44e](https://github.com/senaoxi/limina/commit/cd74e44e))
- fix: cover formal verification inputs in CI ([51cf25c8](https://github.com/senaoxi/limina/commit/51cf25c8))
- fix(cache): bound snapshot publication memory ([6fe3edaa](https://github.com/senaoxi/limina/commit/6fe3edaa))
- fix(checker): qualify tsgo external-input compatibility ([6d420843](https://github.com/senaoxi/limina/commit/6d420843))
- fix(graph): qualify type directives for tsgo ([a27aa221](https://github.com/senaoxi/limina/commit/a27aa221))
- fix(graph): reject outFile before declaration projection ([cc7c13fd](https://github.com/senaoxi/limina/commit/cc7c13fd))

### Documentation

- docs: add Codex skills and Pstack workflow routing ([aa3574ac](https://github.com/senaoxi/limina/commit/aa3574ac))
- docs: update metadata ([d6074b84](https://github.com/senaoxi/limina/commit/d6074b84))

### Maintenance

- test: add model checks and implementation replays ([8cb2db5a](https://github.com/senaoxi/limina/commit/8cb2db5a))
- build: remove bundled dependency inventory ([d90c32f6](https://github.com/senaoxi/limina/commit/d90c32f6))

## [0.5.0-beta.2] - 2026-11-02

### Breaking Changes

- **BREAKING:** collect Native compiler evidence with a physical Coverage-bounded Program.
  TypeScript runtime `require`, `createRequire`, and `require.resolve` no longer automatically
  generate Native project references or checker-coloring relationships; source/package governance
  retains its separate runtime collector. Every reached declaration requires current Source Config
  Coverage, without package, standard-library or generated-output exemptions. Compilation obligation,
  reference structure and declaration readiness are independent. Schema 9 rebuilds old Native
  analysis snapshots without deleting checker caches. See the [English reference guide](../../docs/en/import-resolution-to-declaration-build-graph.md)
  and [中文引用指南](../../docs/zh/import-resolution-to-declaration-build-graph.md).

- **BREAKING:** group governance settings under `scope` and rename `execution` to `concurrency`.
  Move `config.source`, `config.checkers`, and `regions` into `scope`.
  `graph`, `source`, `proof`, `package`, `release`, `pipelines`, `concurrency`, and `cache`
  are top-level fields; `checks` and `execution` wrappers are not accepted.
  Old fields and mixed structures are rejected with migration guidance. Existing values, path bases,
  command contracts, and defaults are preserved. Replace `SharedLiminaConfig` with `ScopeConfig`.
  Old analysis implementation snapshots rebuild on demand without clearing checker caches.
  See the current [English configuration structure](../../docs/en/config/config-file.md#configuration-structure)
  or [中文配置结构](../../docs/zh/config/config-file.md#configuration-structure).

### Features

- feat(checker): build producers before Svelte consumer checks ([f8f4f80](https://github.com/senaoxi/limina/commit/f8f4f80))
- feat(checker)!: assign ownership per source config ([be7b2bc](https://github.com/senaoxi/limina/commit/be7b2bc))
- feat: unify declaration context governance ([8f406ed](https://github.com/senaoxi/limina/commit/8f406ed))
- feat(checker): qualify Pending resolution supplements ([f0d743d](https://github.com/senaoxi/limina/commit/f0d743d))
- feat!: govern declaration configuration contexts ([9ebdaf0](https://github.com/senaoxi/limina/commit/9ebdaf0))
- feat!: select default checks from configured domains ([dbedd0a](https://github.com/senaoxi/limina/commit/dbedd0a))
- feat!: select default checks from configured domains ([e7f9737](https://github.com/senaoxi/limina/commit/e7f9737))
- feat(native)!: collect bounded compiler evidence ([d1ee8a8](https://github.com/senaoxi/limina/commit/d1ee8a8))
- feat: extend declaration dependency resolution ([817a4a7](https://github.com/senaoxi/limina/commit/817a4a7))
- feat(graph)!: persist programless dependency graphs ([af74018](https://github.com/senaoxi/limina/commit/af74018))
- feat(migrate)!: support defaults and migration previews ([3866f4d](https://github.com/senaoxi/limina/commit/3866f4d))
- feat(graph)!: remove condition-domain governance ([24c8c95](https://github.com/senaoxi/limina/commit/24c8c95))
- feat(config)!: reorganize configuration domains ([f46f054](https://github.com/senaoxi/limina/commit/f46f054))
- feat(config): configure persistent analysis caching ([70130d5](https://github.com/senaoxi/limina/commit/70130d5))
- feat(cache): observe configuration module inputs ([126f21d](https://github.com/senaoxi/limina/commit/126f21d))
- feat(cli)!: replace cache opt-out with forced refresh ([09459c6](https://github.com/senaoxi/limina/commit/09459c6))
- feat(docs): refine article typography and code blocks ([13d14aa](https://github.com/senaoxi/limina/commit/13d14aa))
- feat(analysis): restore complete native analysis models ([97f8121](https://github.com/senaoxi/limina/commit/97f8121))
- feat(analysis): persist native TypeScript analysis ([94334d5](https://github.com/senaoxi/limina/commit/94334d5))
- feat(release): enable independent publication ([0dc3bcb](https://github.com/senaoxi/limina/commit/0dc3bcb))
- feat(docs): unify article reading theme ([349dad5](https://github.com/senaoxi/limina/commit/349dad5))

### Bug Fixes

- fix(checker): preserve Svelte drive resolution ([f228c1d](https://github.com/senaoxi/limina/commit/f228c1d))
- fix(checker): reject unproved compiler input admission ([8f5698e](https://github.com/senaoxi/limina/commit/8f5698e))
- fix(checker): retain compiler requests without source maps ([62ec273](https://github.com/senaoxi/limina/commit/62ec273))
- fix(checker): qualify unresolved versioned requests ([64c4cd4](https://github.com/senaoxi/limina/commit/64c4cd4))
- fix(graph): validate retained declaration and JSON inputs ([d9f2226](https://github.com/senaoxi/limina/commit/d9f2226))
- fix(graph): preserve declaration package formats ([7f71920](https://github.com/senaoxi/limina/commit/7f71920))
- fix(graph): require declared local JSON emit inputs ([27cadd9](https://github.com/senaoxi/limina/commit/27cadd9))
- fix(graph): qualify tsgo versioned type conditions ([c817e8b](https://github.com/senaoxi/limina/commit/c817e8b))
- fix(graph): reject changed package module projections ([4819a7a](https://github.com/senaoxi/limina/commit/4819a7a))
- fix(graph): preserve external type entry loading identity ([c95df43](https://github.com/senaoxi/limina/commit/c95df43))
- fix(graph): preserve effective config path semantics ([deea259](https://github.com/senaoxi/limina/commit/deea259))
- fix(graph): reject unproved output compilation relations ([bccc59d](https://github.com/senaoxi/limina/commit/bccc59d))
- fix(graph): honor effective JSON path defaults ([0012aa8](https://github.com/senaoxi/limina/commit/0012aa8))
- fix(checker): normalize Native candidate path keys ([87f83b7](https://github.com/senaoxi/limina/commit/87f83b7))
- fix(graph): prove compiler coverage before graph admission ([fb76936](https://github.com/senaoxi/limina/commit/fb76936))
- fix!: restore fixed default governance checks ([830337d](https://github.com/senaoxi/limina/commit/830337d))
- fix: preserve cycle attribution and bound CI tests ([f08aa9e](https://github.com/senaoxi/limina/commit/f08aa9e))
- fix: preserve compiler reference obligations ([020ee30](https://github.com/senaoxi/limina/commit/020ee30))
- fix: enforce project reference semantics ([cdf7583](https://github.com/senaoxi/limina/commit/cdf7583))
- fix(checker): preserve TypeScript library selections ([27b6838](https://github.com/senaoxi/limina/commit/27b6838))
- fix: preserve TS extension imports in dts builds ([f6d8e03](https://github.com/senaoxi/limina/commit/f6d8e03))
- fix: normalize portable configuration identities ([a0db590](https://github.com/senaoxi/limina/commit/a0db590))
- fix: restore portable CI validation ([2319bf2](https://github.com/senaoxi/limina/commit/2319bf2))
- fix(graph): correct declaration context validation ([7855fb9](https://github.com/senaoxi/limina/commit/7855fb9))
- fix: recheck source consumers and reuse analysis ([63d05ae](https://github.com/senaoxi/limina/commit/63d05ae))
- fix(cache): restore Vue references from qualified contexts ([f9c394f](https://github.com/senaoxi/limina/commit/f9c394f))
- fix: qualify native compilation obligation proofs ([39f6463](https://github.com/senaoxi/limina/commit/39f6463))
- fix(checker): bind execution admission to current inputs ([fd8393d](https://github.com/senaoxi/limina/commit/fd8393d))
- fix: preserve Vue output analysis and cache validity ([07d919d](https://github.com/senaoxi/limina/commit/07d919d))
- fix(cache): validate pnpm multi-document lock coverage ([be6f8c4](https://github.com/senaoxi/limina/commit/be6f8c4))
- fix(proof): preserve the active project-config cache ([3a8e673](https://github.com/senaoxi/limina/commit/3a8e673))
- fix(migrate): verify commands in fresh processes ([6fe4b84](https://github.com/senaoxi/limina/commit/6fe4b84))
- fix: repair security audit and Windows path roots ([c6ce2be](https://github.com/senaoxi/limina/commit/c6ce2be))
- fix(cli): reject pipeline runtime arguments ([d5c83f2](https://github.com/senaoxi/limina/commit/d5c83f2))
- fix(git): preserve commit message paths on Windows ([9039fa6](https://github.com/senaoxi/limina/commit/9039fa6))
- fix(release): correct prerelease channel planning ([92cd92f](https://github.com/senaoxi/limina/commit/92cd92f))
- fix(docs): prevent private attribution in context records ([6d8d7e5](https://github.com/senaoxi/limina/commit/6d8d7e5))
- fix(docs): prevent private paths in published artifacts ([a6cbb15](https://github.com/senaoxi/limina/commit/a6cbb15))

### Documentation

- docs: refresh references after privacy history rewrite ([daca311](https://github.com/senaoxi/limina/commit/daca311))
- docs: remove historical interface explanations ([7999093](https://github.com/senaoxi/limina/commit/7999093))
- docs: clarify bilingual user documentation ([d74c2d1](https://github.com/senaoxi/limina/commit/d74c2d1))
- docs: define dependency delivery policy ([14c22d5](https://github.com/senaoxi/limina/commit/14c22d5))
- docs(native): document Program evidence boundaries ([a82d952](https://github.com/senaoxi/limina/commit/a82d952))
- docs: explain programless graph contracts ([af00cd5](https://github.com/senaoxi/limina/commit/af00cd5))
- docs(skills): limina skill ([87a3cf5](https://github.com/senaoxi/limina/commit/87a3cf5))
- docs(config): explain configuration cache dependencies ([e23c8d5](https://github.com/senaoxi/limina/commit/e23c8d5))
- docs: clarify bilingual adoption and checking guides ([6ef3cce](https://github.com/senaoxi/limina/commit/6ef3cce))
- docs(deps): define dependency admission workflow ([dff4c4f](https://github.com/senaoxi/limina/commit/dff4c4f))
- docs: reorganize repository guidance ([a1738d6](https://github.com/senaoxi/limina/commit/a1738d6))
- docs: define commit message convention ([e920264](https://github.com/senaoxi/limina/commit/e920264))

### Maintenance

- ci: restore complete platform validation ([1e62268](https://github.com/senaoxi/limina/commit/1e62268))
- build: upgrade Vercel and rebalance Windows CI ([4b9ff03](https://github.com/senaoxi/limina/commit/4b9ff03))
- test: separate framework compiler control budgets ([8609fca](https://github.com/senaoxi/limina/commit/8609fca))
- refactor: consolidate modules by capability and lifetime ([7e68d2f](https://github.com/senaoxi/limina/commit/7e68d2f))
- build: check generated declarations after bundling ([6090e51](https://github.com/senaoxi/limina/commit/6090e51))
- test: extend real Astro semantic test deadlines ([0349e9c](https://github.com/senaoxi/limina/commit/0349e9c))
- build(deps): upgrade Vercel to 65.2.0 ([dc7dec8](https://github.com/senaoxi/limina/commit/dc7dec8))
- build: unify Astro test dependency baselines ([39d98a5](https://github.com/senaoxi/limina/commit/39d98a5))
- refactor: consolidate modules and relax size lint rules ([71a79a3](https://github.com/senaoxi/limina/commit/71a79a3))
- chore: bump deps ([9882052](https://github.com/senaoxi/limina/commit/9882052))
- build(deps): raise Vite floor to 8.3.4 ([f671644](https://github.com/senaoxi/limina/commit/f671644))
- chore(agents): remove legacy HTML publisher shim ([eabb98e](https://github.com/senaoxi/limina/commit/eabb98e))
- chore(agents): add shared HTML publisher compatibility ([f829e3e](https://github.com/senaoxi/limina/commit/f829e3e))
- test: stabilize cache and dependency regressions ([51a4376](https://github.com/senaoxi/limina/commit/51a4376))
- build(migrate): refresh bundled license notices ([3d6f769](https://github.com/senaoxi/limina/commit/3d6f769))
- chore(docs): sidebar layout adjustment of docs ([80ee306](https://github.com/senaoxi/limina/commit/80ee306))
- build!: raise Node.js floors and upgrade pnpm ([c8e4558](https://github.com/senaoxi/limina/commit/c8e4558))
- test(cache): isolate gates and fix process paths ([ccfcea8](https://github.com/senaoxi/limina/commit/ccfcea8))
- chore(git): limit commit body and footer line lengths ([037f65a](https://github.com/senaoxi/limina/commit/037f65a))
- test(migrate): corrupt embedded versions through the AST ([c37e479](https://github.com/senaoxi/limina/commit/c37e479))
- test: bound unit test subprocess concurrency ([4313262](https://github.com/senaoxi/limina/commit/4313262))
- test(gates): exclude dependencies from fixture commits ([0c8e3ed](https://github.com/senaoxi/limina/commit/0c8e3ed))
- build(gates): centralize repository governance ([ecd003a](https://github.com/senaoxi/limina/commit/ecd003a))
- chore: route repository checks through Limina pipelines ([820947d](https://github.com/senaoxi/limina/commit/820947d))

### Other Changes

- perf: reduce repeated startup analysis work ([efb4086](https://github.com/senaoxi/limina/commit/efb4086))
- perf(cache): reuse immutable analysis facts and graph views ([9e2660f](https://github.com/senaoxi/limina/commit/9e2660f))
- perf: reuse admission proofs and cache coverage ([10b9fa5](https://github.com/senaoxi/limina/commit/10b9fa5))
- perf(checker): reuse input reads within prerequisite phases ([17f79d0](https://github.com/senaoxi/limina/commit/17f79d0))
- perf(cache): avoid duplicate publication input scans ([fc02919](https://github.com/senaoxi/limina/commit/fc02919))
- perf(cache): index bounded evidence during validation ([b58b0ec](https://github.com/senaoxi/limina/commit/b58b0ec))
- perf(vue): index declaration closure dependency facts ([80a4ca4](https://github.com/senaoxi/limina/commit/80a4ca4))
- perf(cache): shard analysis snapshots by project scope ([ee1ae5b](https://github.com/senaoxi/limina/commit/ee1ae5b))
- perf(cache): reuse verified installation coverage ([c2f3ac2](https://github.com/senaoxi/limina/commit/c2f3ac2))
- perf: bound file identity hashing memory ([cc176ae](https://github.com/senaoxi/limina/commit/cc176ae))
- perf(cache): reuse persistent Vue and mixed graph analysis ([2618645](https://github.com/senaoxi/limina/commit/2618645))
- perf(analysis): reuse reads within bounded analysis scopes ([7dfe87c](https://github.com/senaoxi/limina/commit/7dfe87c))

## [0.5.0-beta.1] - 2026-10-04

### Bug Fixes

- fix(docs): replay recorded interactive terminal output ([9812c6d4](https://github.com/senaoxi/limina/commit/9812c6d4fdfcbf3dd006c35ac104d033a599ebb8))
- fix(release): wait for new npm metadata and preserve first-package latest ([43e07e19](https://github.com/senaoxi/limina/commit/43e07e1945f39ea8d711aaac587435a4b340facd), [23c1df5a](https://github.com/senaoxi/limina/commit/23c1df5a59d3d27260629388fb19c9b194a503f2))
- fix(ci): build private release tools before cold tag checks ([c0ed626c](https://github.com/senaoxi/limina/commit/c0ed626c55f82f4dced5f8bbc69e402d4e81c55b))

## [0.5.0-beta.0] - 2026-10-03

### Features

- feat(docs): enhanced console effect demonstration ([63636b38](https://github.com/senaoxi/limina/commit/63636b38))
- feat(migrate): checkpoint standalone distribution for cloud validation ([ca7d9fd0](https://github.com/senaoxi/limina/commit/ca7d9fd0))
- feat: upgrade to eslint 10 ([c899258a](https://github.com/senaoxi/limina/commit/c899258a))
- feat: upgrade to eslint 10 ([2a044eef](https://github.com/senaoxi/limina/commit/2a044eef))
- feat: extract migration into standalone limina-migrate package ([797df8d8](https://github.com/senaoxi/limina/commit/797df8d8))
- feat(limina): preserve input topology during migration ([55089e2b](https://github.com/senaoxi/limina/commit/55089e2b))
- feat(limina): enforce registry authority and response limits ([d54e133c](https://github.com/senaoxi/limina/commit/d54e133c))

### Bug Fixes

- fix(ci): restore read-only formatting script ([9bae0228](https://github.com/senaoxi/limina/commit/9bae0228))
- fix(migrate): preserve healthy sources and native relations ([dcee83a1](https://github.com/senaoxi/limina/commit/dcee83a1))

### Documentation

- docs(home): add scroll-synced terminal landing page ([6d04d565](https://github.com/senaoxi/limina/commit/6d04d565))
- docs: record monorepo migration and validation ([2996cb3c](https://github.com/senaoxi/limina/commit/2996cb3c))

### Maintenance

- chore: finalize standalone repository migration ([eb6ae071](https://github.com/senaoxi/limina/commit/eb6ae071))
- refactor: replace migration bridge with internal module exports ([bb3a8549](https://github.com/senaoxi/limina/commit/bb3a8549))
- chore: harden tests and patch Astro dependencies ([58ced243](https://github.com/senaoxi/limina/commit/58ced243))
- build(checker): allow the @astrojs/check 0.9 peer range ([5d34ef02](https://github.com/senaoxi/limina/commit/5d34ef02))
- chore: update documentation links and redact local paths ([ab35f06c](https://github.com/senaoxi/limina/commit/ab35f06c))
- chore: document site path updated ([1774ab17](https://github.com/senaoxi/limina/commit/1774ab17))
- build: integrate standalone monorepo infrastructure ([32bae75e](https://github.com/senaoxi/limina/commit/32bae75e))
- build: configure standalone monorepo ([5dd3022d](https://github.com/senaoxi/limina/commit/5dd3022d))
- refactor: move Limina product to repository root ([5ad61842](https://github.com/senaoxi/limina/commit/5ad61842))
- refactor(limina): separate dependency and package export validation ([ba7b926a](https://github.com/senaoxi/limina/commit/ba7b926a))

## [0.4.0] - 2026-09-25

### Features

- feat(limina)!: make governance roots config-anchored ([0bfa8deb](https://github.com/senaoxi/docs-islands/commit/0bfa8deb))
- feat(limina): support multi-manager workspace discovery ([530d8c38](https://github.com/senaoxi/docs-islands/commit/530d8c38))

### Bug Fixes

- fix(limina): preserve Node builtin specifier identity ([9badd196](https://github.com/senaoxi/docs-islands/commit/9badd196))
- fix(limina): harden validation and build semantics ([60d0b3ec](https://github.com/senaoxi/docs-islands/commit/60d0b3ec))
- fix(limina): preserve module specifier identity and checker authority ([68899f86](https://github.com/senaoxi/docs-islands/commit/68899f86))
- fix(limina): align native evidence with canonical source ownership ([64319a6d](https://github.com/senaoxi/docs-islands/commit/64319a6d))

### Maintenance

- chore(limina): harden standalone invocation shell transport ([ad7d0ed1](https://github.com/senaoxi/docs-islands/commit/ad7d0ed1))

### Other Changes

- perf(limina): reuse TypeScript syntax facts across analyses ([40912066](https://github.com/senaoxi/docs-islands/commit/40912066))

## [0.3.1] - 2026-09-15

### Features

- feat(limina): preserve semantic dependency requirements in graph ([9b781acb](https://github.com/senaoxi/docs-islands/commit/9b781acb))

### Bug Fixes

- fix(limina): enforce validated workspace authority in lookups ([16ca9975](https://github.com/senaoxi/docs-islands/commit/16ca9975))
- fix(limina): correct resource resolution and graph preflight cleanup ([561683d2](https://github.com/senaoxi/docs-islands/commit/561683d2))

### Documentation

- docs(limina): establish architecture knowledge model ([3321c890](https://github.com/senaoxi/docs-islands/commit/3321c890))

### Performance

- perf(limina): index workspace regions with a sparse trie ([fb365aab](https://github.com/senaoxi/docs-islands/commit/fb365aab))

## [0.3.0] - 2026-09-03

### Features

- feat(limina)!: make checker governance semantic-first (#97) ([e1e7ee40](https://github.com/senaoxi/docs-islands/commit/e1e7ee40))

### Bug Fixes

- fix(limina): avoid CLI test timeouts on Windows ([92a07b70](https://github.com/senaoxi/docs-islands/commit/92a07b70))
- fix(limina): align dependency analysis with TypeScript semantics ([7b2ecc40](https://github.com/senaoxi/docs-islands/commit/7b2ecc40))
- fix(limina): preserve portable paths across analysis ([b0451964](https://github.com/senaoxi/docs-islands/commit/b0451964))
- fix(limina): respect configured typeRoots and prioritize @types ([7db3f420](https://github.com/senaoxi/docs-islands/commit/7db3f420))
- fix(limina): manage declarationDir output paths ([082368fa](https://github.com/senaoxi/docs-islands/commit/082368fa))

### Other Changes

- perf(limina): reuse project dependency semantic facts ([15f0d00b](https://github.com/senaoxi/docs-islands/commit/15f0d00b))

## [0.2.3] - 2026-08-04

### Features

- feat(limina): make knip source checks explicit opt-in ([fb7719ff](https://github.com/senaoxi/docs-islands/commit/fb7719ff))

### Bug Fixes

- fix(limina): preserve shell command during CLI screen clearing ([aea5a7b7](https://github.com/senaoxi/docs-islands/commit/aea5a7b7))
- fix(limina): avoid blank lines after migration removes fields ([7c7e67ed](https://github.com/senaoxi/docs-islands/commit/7c7e67ed))

## [0.2.2] - 2026-08-01

### Features

- feat(limina): add JSONC migration utilities and improve checker source accuracy ([088088f1](https://github.com/senaoxi/docs-islands/commit/088088f1))

### Bug Fixes

- fix(limina): harden build consistency and reproducibility ([33935071](https://github.com/senaoxi/docs-islands/commit/33935071))
- fix(limina): prevent duplicate materialization after replanning ([c2ae34e3](https://github.com/senaoxi/docs-islands/commit/c2ae34e3))
- fix(limina): harden analysis and artifact state ([b06fca9a](https://github.com/senaoxi/docs-islands/commit/b06fca9a))

## [0.2.1] - 2026-07-28

### Bug Fixes

- fix(limina): prevent Windows CLI test timeouts ([ebe9ade9](https://github.com/senaoxi/docs-islands/commit/ebe9ade9))
- fix(limina): harden runtime checks and integration coverage ([2119b531](https://github.com/senaoxi/docs-islands/commit/2119b531))

### Documentation

- docs: adopt Project Context Records (PCR) for agent workflow ([0939343c](https://github.com/senaoxi/docs-islands/commit/0939343c))

### Maintenance

- ci: add autofix and scheduled dependency-update workflows ([02361888](https://github.com/senaoxi/docs-islands/commit/02361888))
- refactor(limina): decompose monolithic modules into focused units ([76e93ced](https://github.com/senaoxi/docs-islands/commit/76e93ced))

## [0.2.0] - 2026-07-23

### Features

- feat(limina): add resource module governance ([2a1789e3](https://github.com/senaoxi/docs-islands/commit/2a1789e3))
- feat(limina): verify registry tarball integrity ([42642b8b](https://github.com/senaoxi/docs-islands/commit/42642b8b))
- feat(limina)!: make manifest linting opt-in ([edcd6752](https://github.com/senaoxi/docs-islands/commit/edcd6752))
- feat(limina): add progressive issue diagnostics ([a559dffe](https://github.com/senaoxi/docs-islands/commit/a559dffe))
- feat(limina): add isolated issue invocation records ([411df861](https://github.com/senaoxi/docs-islands/commit/411df861))
- feat(limina)!: scope ambient declarations to activated package islands ([b1847be2](https://github.com/senaoxi/docs-islands/commit/b1847be2))
- feat(limina)!: model workspace governance as activated package islands ([5f48cf3d](https://github.com/senaoxi/docs-islands/commit/5f48cf3d))
- feat(limina): support governed shared ambient declarations ([944d76c7](https://github.com/senaoxi/docs-islands/commit/944d76c7))
- feat(limina)!: region-scope checker entries and harden migration writes ([3322c896](https://github.com/senaoxi/docs-islands/commit/3322c896))
- feat(limina)!: redesign validation core around layered aggregates ([017ef494](https://github.com/senaoxi/docs-islands/commit/017ef494))
- feat(limina)!: require explicit kind on regions.exclude rules ([36ae956e](https://github.com/senaoxi/docs-islands/commit/36ae956e))
- feat(limina): harden workspace, import, and release checks ([d468f1bd](https://github.com/senaoxi/docs-islands/commit/d468f1bd))
- feat(eslint-config): add portable-path comparison rule and enforce it in limina ([44d7773a](https://github.com/senaoxi/docs-islands/commit/44d7773a))
- feat(limina)!: introduce workspace region governance model ([82e84738](https://github.com/senaoxi/docs-islands/commit/82e84738))
- feat(limina)!: align config.source defaults with TypeScript semantics ([18c3d50a](https://github.com/senaoxi/docs-islands/commit/18c3d50a))
- feat(limina)!: rework source import authority as owner-keyed root grants ([c85e8f55](https://github.com/senaoxi/docs-islands/commit/c85e8f55))
- feat(limina): split duplicate graph coverage from source owner checks ([0c32010d](https://github.com/senaoxi/docs-islands/commit/0c32010d))
- feat(limina): enforce engine-safe cross-checker build boundaries ([4327016b](https://github.com/senaoxi/docs-islands/commit/4327016b))
- feat(limina): skip optional checks when their tools are missing ([002c4e28](https://github.com/senaoxi/docs-islands/commit/002c4e28))
- feat(limina): add migration command to govern tsconfig outputs ([f06a862b](https://github.com/senaoxi/docs-islands/commit/f06a862b))
- feat(limina): attribute managed output declarations to project refs ([49a502d1](https://github.com/senaoxi/docs-islands/commit/49a502d1))
- feat(limina): config loader ([f163c232](https://github.com/senaoxi/docs-islands/commit/f163c232))

### Bug Fixes

- fix(limina): drop unused exports and harden cross-platform tests ([a29ca2e8](https://github.com/senaoxi/docs-islands/commit/a29ca2e8))
- fix(limina): bypass pnpm shim in cmd queries ([9cab2a36](https://github.com/senaoxi/docs-islands/commit/9cab2a36))
- fix(limina): bound registry requests ([90b4d007](https://github.com/senaoxi/docs-islands/commit/90b4d007))
- fix(limina): measure terminal display width correctly ([b4c47bc9](https://github.com/senaoxi/docs-islands/commit/b4c47bc9))
- fix(limina): make standalone queries shell-specific ([274876aa](https://github.com/senaoxi/docs-islands/commit/274876aa))
- fix(limina): enforce managed mutation boundaries ([68562bf7](https://github.com/senaoxi/docs-islands/commit/68562bf7))
- fix(limina): reject removed root tsconfig metadata ([c73398d2](https://github.com/senaoxi/docs-islands/commit/c73398d2))
- fix(limina): validate overlaps after workspace package exclusions ([c82977d8](https://github.com/senaoxi/docs-islands/commit/c82977d8))
- fix(ci): stabilize cross-platform builds and tests ([8b8b5eb7](https://github.com/senaoxi/docs-islands/commit/8b8b5eb7))
- fix(limina): source import authority for alias dependencies ([1252f9e7](https://github.com/senaoxi/docs-islands/commit/1252f9e7))
- fix(limina): stop inferring declaration references from require.resolve imports ([4f032ebc](https://github.com/senaoxi/docs-islands/commit/4f032ebc))

### Documentation

- docs(limina): align docs and skill with current behavior ([b5dfcec3](https://github.com/senaoxi/docs-islands/commit/b5dfcec3))
- docs(limina): remove pre-0.2.0 migration guidance ([aef1f0a8](https://github.com/senaoxi/docs-islands/commit/aef1f0a8))

### Maintenance

- refactor(limina): enforce detector issue contracts (#89) ([8726ce3a](https://github.com/senaoxi/docs-islands/commit/8726ce3a))
- test(limina): harden real fixture integration coverage ([b26f93cd](https://github.com/senaoxi/docs-islands/commit/b26f93cd))
- ci(limina): validate build and smoke across supported platforms ([45eb8036](https://github.com/senaoxi/docs-islands/commit/45eb8036))
- refactor(limina): make execution config schema declarative ([55020dd9](https://github.com/senaoxi/docs-islands/commit/55020dd9))
- refactor(limina): consolidate reporting primitives ([2f85aea4](https://github.com/senaoxi/docs-islands/commit/2f85aea4))
- refactor(limina): consolidate strongly connected components ([b13fb95c](https://github.com/senaoxi/docs-islands/commit/b13fb95c))
- test(limina): cover external checker build lifecycle ([add0d86c](https://github.com/senaoxi/docs-islands/commit/add0d86c))
- test(limina): add external workspace graph fixture ([f3919ad8](https://github.com/senaoxi/docs-islands/commit/f3919ad8))
- test(limina): add isolated integration fixture harness ([b4d8aa1e](https://github.com/senaoxi/docs-islands/commit/b4d8aa1e))
- refactor(limina): drop legacy check snapshot readers ([7d327a31](https://github.com/senaoxi/docs-islands/commit/7d327a31))
- refactor(limina): enforce current config and CLI key contracts ([7f9d96dc](https://github.com/senaoxi/docs-islands/commit/7f9d96dc))
- chore(limina): improve workspace export resolution diagnostics ([9e9ea95a](https://github.com/senaoxi/docs-islands/commit/9e9ea95a))
- chore(limina): optimize diagnostic display ([3f52ed8c](https://github.com/senaoxi/docs-islands/commit/3f52ed8c))
- chore(limina): limina.config.mts as primary config format ([c9f44429](https://github.com/senaoxi/docs-islands/commit/c9f44429))
- chore: align node 24 baseline with LTS ([3adc2b85](https://github.com/senaoxi/docs-islands/commit/3adc2b85))

### Other Changes

- perf(limina): group workspace export resolution execution ([162e9a0a](https://github.com/senaoxi/docs-islands/commit/162e9a0a))
- perf(limina): compile workspace export resolution profiles ([f348afbc](https://github.com/senaoxi/docs-islands/commit/f348afbc))
- perf(limina): index workspace path classification by directory ([efe048a3](https://github.com/senaoxi/docs-islands/commit/efe048a3))
- perf(limina): share module resolution results across checks ([023e1b4d](https://github.com/senaoxi/docs-islands/commit/023e1b4d))
- perf(limina): reuse resolver state within analysis runs ([505999c9](https://github.com/senaoxi/docs-islands/commit/505999c9))
- perf(limina): add module resolution profiling metrics ([2c78e624](https://github.com/senaoxi/docs-islands/commit/2c78e624))
- perf(limina): reduce redundant check pipeline and workspace lookup work ([2f5ac069](https://github.com/senaoxi/docs-islands/commit/2f5ac069))

## [0.1.3] - 2026-07-04

### Features

- feat(limina)!: manage output build info and add declarationMap option ([67c92467](https://github.com/senaoxi/docs-islands/commit/67c92467))
- feat(limina): copy local declaration inputs for managed output builds ([58c66341](https://github.com/senaoxi/docs-islands/commit/58c66341))

### Documentation

- docs(limina): clarify generated reference graph and governance model ([f40e441e](https://github.com/senaoxi/docs-islands/commit/f40e441e))
- docs(limina): trim ceremonial framing and drop migration notes ([4c9d6aab](https://github.com/senaoxi/docs-islands/commit/4c9d6aab))

### Maintenance

- build: refresh toolchain and define Node and pnpm baselines ([54e66b2f](https://github.com/senaoxi/docs-islands/commit/54e66b2f))
- chore(ci): migrate dependency updates to Renovate ([b98bee81](https://github.com/senaoxi/docs-islands/commit/b98bee81))

## [0.1.2] - 2026-06-29

### Features

- feat(limina): detect generated reference cycles ([24bc1baa](https://github.com/senaoxi/docs-islands/commit/24bc1baa))
- feat(limina): optimize flow output and flow logical reorganization ([2ba4b7cb](https://github.com/senaoxi/docs-islands/commit/2ba4b7cb))
- feat(limina): split checker and output build surfaces ([ff75b328](https://github.com/senaoxi/docs-islands/commit/ff75b328))

### Documentation

- docs(limina): update user documentation ([17fada0b](https://github.com/senaoxi/docs-islands/commit/17fada0b))
- docs(limina): document build command and refresh zh/en guides ([254b1683](https://github.com/senaoxi/docs-islands/commit/254b1683))

### Other Changes

- perf(limina): ownership lookup cache ([6002c6d7](https://github.com/senaoxi/docs-islands/commit/6002c6d7))

## [0.1.1] - 2026-06-23

### Bug Fixes

- fix(limina): stabilize Windows unit tests ([f078b418](https://github.com/senaoxi/docs-islands/commit/f078b418))
- fix(release): stabilize package publish validation ([d23b3702](https://github.com/senaoxi/docs-islands/commit/d23b3702))

### Documentation

- docs(limina): update user documentation and skills ([63abd91e](https://github.com/senaoxi/docs-islands/commit/63abd91e))

## [0.1.0] - 2026-06-22

### Highlights

Limina 0.1.0 lowers the cost of adding build capability to complex monorepos.
It derives checker build graphs from source `tsconfig.json` scopes, imports,
package boundaries, and `liminaOptions.implicitRefs`, so projects can keep the
source graph as the main authored input instead of maintaining build graph state
by hand.

This release adds `limina checker build` for managed or raw builds with `tsc`,
`tsgo`, and `vue-tsc`, including watch mode, dependency preflight,
provider-aware ordering, and cache warnings. The same architecture model now
powers graph, source, proof, checker, package, and release checks across
ownership, import authority, public access, build dependencies, source
reachability, and publishable output.

`limina check` now provides summary-first reporting with shared preflight,
resource-aware execution, stable issue codes, saved snapshots, and
`limina check --issues`. `limina graph export --view source|artifact|all`
exposes source and artifact relationships to external task tooling, and the
docs/scripts were updated for the source-first build model.

### Features

- feat(limina)!: generate checker graphs and restructure check pipeline (#75) ([bb1a9c7](https://github.com/senaoxi/docs-islands/commit/bb1a9c7))

### Bug Fixes

- fix(limina): stabilize flow renderer spinner test ([a76f375](https://github.com/senaoxi/docs-islands/commit/a76f375))

### Maintenance

- chore: repository username change ([336faa4](https://github.com/senaoxi/docs-islands/commit/336faa4))

## [0.0.6] - 2026-06-10

### Features

- feat(limina): expand configurable validation checks ([4fc5755](https://github.com/senaoxi/docs-islands/commit/4fc5755))
- feat(limina): nearest barename tsconfig owner constraint ([169a441](https://github.com/senaoxi/docs-islands/commit/169a441))
- feat(limina): workspace exports pre-parsing governance ([f931f9a](https://github.com/senaoxi/docs-islands/commit/f931f9a))

### Documentation

- docs: reorganize document layout and optimize document description ([406d321](https://github.com/senaoxi/docs-islands/commit/406d321))
- docs: layout standardization ([6b50be2](https://github.com/senaoxi/docs-islands/commit/6b50be2))

### Maintenance

- chore(limina): respect knip for tsconfig.build.json ([86e0531](https://github.com/senaoxi/docs-islands/commit/86e0531))
- chore(deps): bump deps ([fe4a98a](https://github.com/senaoxi/docs-islands/commit/fe4a98a))
- chore(utils): build for tsc ([fb77b83](https://github.com/senaoxi/docs-islands/commit/fb77b83))
- chore(limina): enhance static module dependency analysis capabilities ([52f5a22](https://github.com/senaoxi/docs-islands/commit/52f5a22))
- chore(limina): oxc resolver explicit tsconfig ([0463eff](https://github.com/senaoxi/docs-islands/commit/0463eff))
- chore(limina): nx checks workspace exports artifact edge ([e235080](https://github.com/senaoxi/docs-islands/commit/e235080))
- chore(limina): workspace package must provide a name field ([0c453ca](https://github.com/senaoxi/docs-islands/commit/0c453ca))
- chore(limina): redefine the default scope of source code ([8fbdfd9](https://github.com/senaoxi/docs-islands/commit/8fbdfd9))
- chore: remove javaScriptConfigFilePattern fallback ([6a698a6](https://github.com/senaoxi/docs-islands/commit/6a698a6))
- chore(limina): remove paths generation and relax workspace package exports conventions ([58db465](https://github.com/senaoxi/docs-islands/commit/58db465))

## [0.0.5] - 2026-06-03

### Features

- feat(limina): accelerate parsing with oxc ([f97d657](https://github.com/senaoxi/docs-islands/commit/f97d657))
- feat(limina): source:check integrates Knip to implement package-level dependency detection ([48a1092](https://github.com/senaoxi/docs-islands/commit/48a1092))
- feat(limina): expose graph and source checking APIs ([628e3a4](https://github.com/senaoxi/docs-islands/commit/628e3a4))
- feat(limina): implement unused dependency checking ([3407954](https://github.com/senaoxi/docs-islands/commit/3407954))
- feat(limina): implementing check for unused workspace dependencies using graph ([0d8c603](https://github.com/senaoxi/docs-islands/commit/0d8c603))
- feat(limina): support nx sync and nx check ([a0e27e5](https://github.com/senaoxi/docs-islands/commit/a0e27e5))
- feat(limina): experimental support for tsgo and vue-tsgo ([1c190db](https://github.com/senaoxi/docs-islands/commit/1c190db))
- feat(release): require changelog review before publishing and lint package.json ([4589d96](https://github.com/senaoxi/docs-islands/commit/4589d96))

### Bug Fixes

- fix(limina): tighten proof source validation ([4b9312a](https://github.com/senaoxi/docs-islands/commit/4b9312a))

### Documentation

- docs: update README.md ([5909e2e](https://github.com/senaoxi/docs-islands/commit/5909e2e))
- docs(limina): detailed description of built-in tasks ([2762ee8](https://github.com/senaoxi/docs-islands/commit/2762ee8))
- docs: refresh package branding assets ([eb15e8a](https://github.com/senaoxi/docs-islands/commit/eb15e8a))
- docs(limina): document nx check and path defaults ([08c86a2](https://github.com/senaoxi/docs-islands/commit/08c86a2))
- docs(limina): document source checking and unused dependencies ([5dbd6f8](https://github.com/senaoxi/docs-islands/commit/5dbd6f8))

### Maintenance

- refactor: standardize tsconfig configurations across workspace ([c17ac0c](https://github.com/senaoxi/docs-islands/commit/c17ac0c))
- test(limina): expand test coverage for graph, source, and proof modules ([98104e5](https://github.com/senaoxi/docs-islands/commit/98104e5))
- build(limina): add ESLint config and tsconfig schema ([34b26bc](https://github.com/senaoxi/docs-islands/commit/34b26bc))
- chore(build): arrange tasks through nx ([162d492](https://github.com/senaoxi/docs-islands/commit/162d492))
- chore(build): core package has the ability to build and remove invalid references ([12ebc13](https://github.com/senaoxi/docs-islands/commit/12ebc13))
- chore(deps): update pnpm and node version constraints ([48b547e](https://github.com/senaoxi/docs-islands/commit/48b547e))
- chore(release): enhance the criteria for publishing dependency packages ([d6e0b89](https://github.com/senaoxi/docs-islands/commit/d6e0b89))
- chore(deps): update the dependency method for limina ([b2e66b4](https://github.com/senaoxi/docs-islands/commit/b2e66b4))

### Other Changes

- perf(limina): cache tsconfig\*.json final governing modules and module resolution dependencies ([879d5b9](https://github.com/senaoxi/docs-islands/commit/879d5b9))

## [0.0.4] - 2026-05-26

### Features

- feat: limina (#67) ([e190fb1](https://github.com/senaoxi/docs-islands/commit/e190fb1))

## [0.0.3] - 2026-05-25

### Features

- feat(limina): release dependency consistency check ([04749e4](https://github.com/senaoxi/docs-islands/commit/04749e4))
- feat(limina): vue-tsc as a first-class citizen ([e640742](https://github.com/senaoxi/docs-islands/commit/e640742))

### Documentation

- docs: enhance document readability ([77cffd7](https://github.com/senaoxi/docs-islands/commit/77cffd7))
- docs: optimize theme display ([339ae89](https://github.com/senaoxi/docs-islands/commit/339ae89))

### Maintenance

- chore(deps): switch limina to production package ([e543810](https://github.com/senaoxi/docs-islands/commit/e543810))

## [0.0.2] - 2026-05-24

### Features

- feat: limina init ([e202100](https://github.com/senaoxi/docs-islands/commit/e202100))
- feat: rename @docs-islands/lattice to linima ([3a16713](https://github.com/senaoxi/docs-islands/commit/3a16713))

### Documentation

- docs: rewrite the document content and provide limina skills documentation ([dd87229](https://github.com/senaoxi/docs-islands/commit/dd87229))

### Maintenance

- chore(deps): switch logaria to production package ([7d26034](https://github.com/senaoxi/docs-islands/commit/7d26034))
- refactor: rename @docs-islands/logger to logaria and site layout reconstruction ([273b996](https://github.com/senaoxi/docs-islands/commit/273b996))
- chore: limina check built-in best practice detection workflows ([d7d00e9](https://github.com/senaoxi/docs-islands/commit/d7d00e9))
- refactor: unified deny.deps ([a0b0eaa](https://github.com/senaoxi/docs-islands/commit/a0b0eaa))
- chore: remove deprecated configuration items ([608de8e](https://github.com/senaoxi/docs-islands/commit/608de8e))
