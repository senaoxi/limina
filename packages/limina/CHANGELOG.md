<!-- markdownlint-disable MD024 -->

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
