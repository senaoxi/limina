# limina

<p align="center">
  <a href="https://docs.senao.me/docs-islands/limina/" target="_blank" rel="noopener noreferrer">
    <img width="180" src="https://docs.senao.me/docs-islands/limina/logo.svg" alt="limina logo">
  </a>
</p>

<p align="center">
  <a href="https://npmjs.com/package/limina"><img src="https://img.shields.io/npm/v/limina.svg" alt="npm package"></a>
  <a href="https://nodejs.org/en/about/previous-releases"><img src="https://img.shields.io/node/v/limina.svg" alt="node compatibility"></a>
  <a href="https://github.com/senaoxi/docs-islands/blob/main/packages/limina/LICENSE.md"><img src="https://img.shields.io/npm/l/limina.svg" alt="license"></a>
</p>

English | [简体中文](./README.zh-CN.md)

> Architecture governance for TypeScript monorepos.

Start with incremental type builds, then progressively enable architecture governance.

Limina is designed for large TypeScript monorepos where project references, source boundaries, check coverage, and release artifacts can drift over time. It builds on existing TypeScript configuration and source dependency relationships to generate reusable type-build configuration, then adds checks for dependency graphs, source boundaries, coverage, and release readiness.

## What Limina does

- Adopts incremental type builds by generating reusable build configuration and deriving a build order from source dependencies.
- Governs the dependency graph by checking project references, access boundaries, and dependency declarations.
- Protects source boundaries by detecting cross-package relative imports, unauthorized imports, missing dependency declarations, and source ownership issues.
- Verifies check coverage by finding source files that are uncovered, covered more than once, or covered by a scope that does not match the source boundary.
- Composes check pipelines for local development, CI, and release workflows, with independent tasks running concurrently when dependencies allow.
- Adds release checks for package metadata, type entry points, build output, and packed package contents.

## Non-goals

Limina is not a bundler, a test framework, or a publishing tool. It does not replace TypeScript or framework-specific checkers. Instead, it runs alongside existing tools and verifies that the monorepo structure they depend on remains consistent and reviewable.

[Read the Docs to Learn More](https://docs.senao.me/docs-islands/limina/)
