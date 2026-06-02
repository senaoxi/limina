# limina

<p align="center">
  <a href="https://docs.senao.me/docs-islands/limina" target="_blank" rel="noopener noreferrer">
    <img width="180" src="https://docs.senao.me/docs-islands/limina/logo.svg" alt="limina logo">
  </a>
</p>
<p align="center">
  <a href="https://npmjs.com/package/limina"><img src="https://img.shields.io/npm/v/limina.svg" alt="npm package"></a>
  <a href="https://nodejs.org/en/about/previous-releases"><img src="https://img.shields.io/node/v/limina.svg" alt="node compatibility"></a>
  <a href="https://github.com/XiSenao/docs-islands/actions/workflows/ci.yml"><img src="https://github.com/XiSenao/docs-islands/actions/workflows/ci.yml/badge.svg?branch=main" alt="build status"></a>
  <a href="https://github.com/XiSenao/docs-islands/blob/main/packages/limina/LICENSE.md"><img src="https://img.shields.io/npm/l/limina.svg" alt="license"></a>
</p>

English | [简体中文](./README.zh-CN.md)

> Architecture governance CLI for TypeScript monorepos

- Keep source dependency graphs aligned with type build graphs
- Guard package, runtime, and workspace boundaries
- Cover TypeScript and framework-specific checkers
- Manage compatibility paths for workspace source dependencies
- Validate package outputs before release
- Compose checks for local development, CI, and publishing

Limina helps teams turn drifting TypeScript monorepo constraints into explicit, reviewable, runnable checks. It keeps source relationships, type coverage, build coordination, package metadata, and publishable outputs aligned across everyday development, code review, and pre-release workflows.

Limina is not a bundler, test runner, or release tool, and it does not replace TypeScript or framework checkers. It runs those existing tools and verifies that the monorepo structure they rely on is still trustworthy.

[Read the Docs to Learn More](https://docs.senao.me/docs-islands/limina/)
