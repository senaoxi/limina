# limina

<p align="center">
  <a href="https://docs.senao.me/docs-islands/limina/zh" target="_blank" rel="noopener noreferrer">
    <img width="180" src="https://docs.senao.me/docs-islands/limina/logo.svg" alt="limina logo">
  </a>
</p>
<p align="center">
  <a href="https://npmjs.com/package/limina"><img src="https://img.shields.io/npm/v/limina.svg" alt="npm package"></a>
  <a href="https://nodejs.org/en/about/previous-releases"><img src="https://img.shields.io/node/v/limina.svg" alt="node compatibility"></a>
  <a href="https://github.com/XiSenao/docs-islands/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/limina.svg" alt="license"></a>
</p>

[English](./README.md) | 简体中文

> TypeScript monorepo 的架构治理 CLI

- 保持源码依赖图与类型构建图一致
- 守住 package、运行时与工程边界
- 覆盖 TypeScript 与框架专属 checker
- 管理 workspace 源码依赖的兼容路径
- 验证发布前 package 产物
- 组合适合本地、CI 与发布流程的检查

Limina 帮助团队把 TypeScript monorepo 中容易漂移的工程约束变成显式、可审查、可运行的检查。它让源码关系、类型覆盖、构建协作、package metadata 和发布产物保持一致，适合放进日常开发、代码审查和发布前流程。

Limina 不是 bundler、测试框架或发布工具，也不会替代 TypeScript / framework checker。它调用这些已有工具，并验证它们依赖的 monorepo 结构是否仍然可靠。

[阅读文档了解更多](https://docs.senao.me/docs-islands/limina/zh/)
