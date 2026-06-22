# 什么是 Limina

Limina 是面向 TypeScript monorepo 的项目引用图编译器与架构治理 CLI。它先把 TypeScript project references 这类构建关系从人工维护变成可生成、可校验、可增量执行的 build 能力，再把同一组事实延伸到源码依赖、包边界、检查器覆盖、工作区导出和发布产物。

小项目可能只需要 `tsc --noEmit`。但大型 workspace 通常会多出很多层：

- 包之间通过声明过的包依赖相互访问；
- TypeScript 项目引用描述构建图；
- Vue、Svelte、文档、工具脚本、测试和运行时代码可能需要不同检查器；
- 发布出去的包还需要正确的 `exports`、类型入口、依赖声明、README 和 license。

Limina 不替代这些工具。它负责把这些工具串起来，并在 CI 或发布前验证它们依赖的工程约束是否仍然一致。

你可以把 Limina 理解成单体仓库的“架构体检”。它不负责写业务代码，也不决定你应该怎么发布；它负责在代码审查、CI 和发布前告诉你：现在源码图、类型检查图和最终包产物是不是还在讲同一个故事。

## 先从 build 能力接入

对第一次接触 Limina 的团队来说，最适合的入口通常不是立刻打开全套检查，而是先使用 `limina:build`。`limina init` 会写入轻量配置、确保生成目录被忽略，并在根 `package.json` 中添加 `limina:build` 脚本。

这个脚本对应 `limina checker build`。它会从启用的源码 `tsconfig.json` 入口出发，准备 Limina 管辖的类型构建图，然后运行支持构建模式的检查器，例如 `tsc -b`、`tsgo -b` 或 `vue-tsc -b`。

这条路径的价值很直接：

- 用户先得到可增量的 TypeScript build，而不是先被全套治理规则拦住；
- project references 由真实源码导入、源码配置和检查器范围推导出来，不需要长期手动同步；
- 等 build 路径稳定后，再逐步打开 `limina check`、包检查和发布检查，把同一张事实图扩展到架构治理。

## Limina 检查什么

Limina 围绕一份 `limina.config.mjs` 配置工作，核心检查可以分成几类：

- **图检查**：确认真实导入、TypeScript 项目引用和工作区依赖规则一致。
- **源码检查**：确认源码文件没有跑出自己所属的包，导入也写在正确的依赖声明里。
- **依赖图导出**：把真实导入和解析结果推导出的 source/artifact 关系导出成限定范围内的 JSON 视图。
- **覆盖证明**：证明声明配置、本地类型检查配置、检查器入口和允许清单覆盖了应该覆盖的源码。
- **检查器运行**：根据图里的目标调用 `tsc`、`tsgo`、`vue-tsc`、`vue-tsgo` 或 `svelte-check`。
- **包检查**：从消费者安装后的视角检查构建产物，使用 `publint`、Are The Types Wrong 和运行时导入边界扫描。
- **发布检查**：打包 npm 发布包并校验发布卫生——必需的 README 与 license 文件、不发布源码映射、打包后清单一致性，以及与 npm registry 内容比对的工作区发布依赖一致性。
- **流水线**：把 Limina 内置任务和 shell 命令组合成本地、PR、发布前工作流。

## 适合的仓库

Limina 适合以下仓库：

- 使用 pnpm 工作区管理多个包；
- 已经使用 TypeScript 项目引用，或准备迁移到 `tsc -b`；
- 需要约束生产代码、工具代码、测试代码、浏览器代码和 Node 代码之间的边界；
- 会发布 npm 包，希望发布前检查构建产物；
- 有框架文件或文档项目，单靠普通 `tsc -b` 无法完整类型检查。

::: tip
Limina 不是打包器、测试框架、发布工具，也不是隐藏预设。它的目标是让单体仓库规则显式、可审查，并能稳定放进 CI。
:::

## 典型使用场景

- **先接入增量构建**：团队已经想使用 `tsc -b`，但不想长期手写和同步 project references。`limina:build` 会从现有源码配置和真实导入准备类型构建图，让仓库先获得可运行、可增量的 build 入口。
- **PR 改了跨包导入**：`@acme/app` 新增 `import { createClient } from '@acme/core'`，但类型构建图没有表达这条源码关系。`limina check` 会在 PR 中提示缺失项目引用或缺失包依赖声明，避免代码合并后才发现构建图已经漂移。
- **浏览器代码误引 Node 依赖**：标记为 `runtime-client` 的项目不小心导入了 `node:fs` 或 `@acme/internal-node`。图规则会直接阻止这条边，避免浏览器运行时到上线后才因为仅 Node 依赖崩掉。
- **源码通过但发布产物不可用**：`tsc` 本地通过了，但 `dist/package.json` 的 `exports` 或 `types` 指向错误文件。`limina package check` 会从消费者安装后的视角检查构建产物，把发布事故挡在 npm publish 前。
- **工作区导出同时包含源码和 `dist` 入口**：`@acme/core` 的 `.` 暴露 `src`，`./runtime` 暴露 `dist`。只要 TypeScript 和 Oxc 都能解析，Limina 接受这两类入口。实际导入源码入口时要求项目引用；实际导入 `dist` 入口时，会在依赖图导出中形成 artifact 边。

## 接入后的工作方式

接入 Limina 后，你会得到一组可以稳定放进本地、PR 和发布流程的检查：

- 本地开发时，先用 `pnpm limina:build` 验证 TypeScript 项目引用构建是否还能增量跑通；
- PR 中，评审者能看到架构边界变更是否写进了 `limina.config.mjs`、`package.json` 或源码 `tsconfig`；
- 发布前，能确认消费者真正安装到的 `dist` 产物有正确的元数据、类型入口、README、license 和运行时导入边界。

对第一次接触的用户来说，最直接的影响是：你不用先成为单体仓库专家，也能用失败信息定位“这次应该补引用、声明依赖、修包导出，还是补包产物”。

## 下一步

阅读[为什么是 Limina](./why.md) 了解动机，或直接前往[快速开始](./getting-started.md)。
