# limina

<p align="center">
  <a href="https://docs.senao.me/docs-islands/limina/zh" target="_blank" rel="noopener noreferrer">
    <img width="180" src="https://docs.senao.me/docs-islands/limina/logo.svg" alt="limina logo">
  </a>
</p>

<p align="center">
  <a href="https://npmjs.com/package/limina"><img src="https://img.shields.io/npm/v/limina.svg" alt="npm package"></a>
  <a href="https://nodejs.org/en/about/previous-releases"><img src="https://img.shields.io/node/v/limina.svg" alt="node compatibility"></a>
  <a href="https://github.com/senaoxi/docs-islands/blob/main/packages/limina/LICENSE.md"><img src="https://img.shields.io/npm/l/limina.svg" alt="license"></a>
</p>

[English](./README.md) | 简体中文

> TypeScript 单体仓库架构治理工具。

先接入增量构建，再逐步打开架构治理。

Limina 面向大型 TypeScript monorepo，帮助团队把容易漂移的工程约束变成显式、可审查、可运行的检查。它基于现有 TypeScript 配置和源码依赖关系生成可复用的类型构建配置，并逐步覆盖依赖图、源码边界、检查覆盖和发布前校验。

## 能力概览

- 接入增量类型构建，生成可复用的构建配置并安排合理的构建顺序。
- 治理项目依赖图，检查项目引用、访问边界和依赖声明是否一致。
- 保护源码边界，发现跨包相对导入、未授权导入、漏写依赖和源码归属问题。
- 确认检查覆盖，找出未覆盖、重复覆盖或检查范围不一致的源码文件。
- 编排检查流程，将构建、依赖图、源码边界和检查覆盖组合进本地开发、CI 或发布流程。
- 补充发布前检查，验证 package metadata、类型入口、发布产物和打包内容。

## Limina 不是什么

Limina 不是 bundler、测试框架或发布工具，也不会替代 TypeScript 或框架专属 checker。它调用已有工具，并验证这些工具依赖的 monorepo 结构是否仍然可靠。

[阅读文档了解更多](https://docs.senao.me/docs-islands/limina/zh/)
