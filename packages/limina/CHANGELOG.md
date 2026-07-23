<!-- markdownlint-disable MD024 -->

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
