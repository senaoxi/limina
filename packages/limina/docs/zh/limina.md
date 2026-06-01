# Limina

Limina 用来让 TypeScript monorepo 保持一致。它会检查源码依赖图、package 归属、类型检查覆盖、兼容 `paths` 和构建后的 package 产物是否真的描述着同一个项目。

小项目可能只需要 `tsc --noEmit`。但大型 workspace 通常会多出很多层：

- package 之间通过 `workspace:*` 相互依赖；
- TypeScript project references 描述构建图；
- Vue、Svelte、文档、工具脚本、测试和 runtime 代码可能需要不同 checker；
- 发布出去的 package 还需要正确的 `exports`、类型入口、依赖声明、README 和 license。

Limina 不替代这些工具。它负责把这些工具串起来，并在 CI 或发布前验证它们依赖的工程约束是否仍然一致。

你可以把 Limina 理解成 monorepo 的“架构体检”。它不负责写业务代码，也不决定你应该怎么发布；它负责在代码审查、CI 和发布前告诉你：现在源码图、类型检查图和最终 package 产物是不是还在讲同一个故事。

## Limina 检查什么

Limina 围绕一份 `limina.config.mjs` 配置工作，核心检查可以分成几类：

- **Graph checks**：确认真实 import、TypeScript project references 和 workspace 依赖规则一致。
- **Source checks**：确认源码文件没有跑出自己所属的 package，import 也写在正确的依赖声明里。
- **Nx checks**：让每个 package 的 `project.json` `dependsOn` 构建边与 `link:` 制品依赖保持同步。
- **Proof checks**：证明声明配置、本地 typecheck 配置、checker entry 和 allowlist 覆盖了应该覆盖的源码。
- **Checker runs**：根据图里的目标调用 `tsc`、`tsgo`、`vue-tsc`、`vue-tsgo` 或 `svelte-check`。
- **Path generation**：当 workspace 依赖按源码消费但 package exports 仍指向构建产物时，生成显式的 TypeScript `paths` 兼容文件。
- **Package checks**：从消费者安装后的视角检查构建产物，使用 `publint`、Are The Types Wrong 和 runtime import boundary scan。
- **Pipelines**：把 Limina 内置任务和 shell 命令组合成本地、PR、发布前工作流。

## 适合的仓库

Limina 适合以下仓库：

- 使用 pnpm workspace 管理多个 package；
- 已经使用 TypeScript project references，或准备迁移到 `tsc -b`；
- 需要约束生产代码、工具代码、测试代码、浏览器代码和 Node 代码之间的边界；
- 会发布 npm package，希望发布前检查构建产物；
- 有框架文件或文档项目，单靠普通 `tsc -b` 无法完整 typecheck。

Limina 不是 bundler、测试框架、发布工具，也不是隐藏 preset。它的目标是让 monorepo 规则显式、可审查，并能稳定放进 CI。

## 典型使用场景

- **PR 改了跨 package import**：`@acme/app` 新增 `import { createClient } from '@acme/core'`，但 `app` 的 declaration leaf 没有 reference `core`。`limina check` 会在 PR 中提示缺失 project reference 或缺失 `workspace:*` 依赖，避免代码合并后才发现构建图已经漂移。
- **浏览器代码误引 Node 依赖**：标记为 `runtime-client` 的项目不小心 import 了 `node:fs` 或 `@acme/internal-node`。Graph rule 会直接阻止这条边，避免浏览器 runtime 到上线后才因为 Node-only 依赖崩掉。
- **源码通过但发布产物不可用**：`tsc` 本地通过了，但 `dist/package.json` 的 `exports` 或 `types` 指向错误文件。`limina package check` 会从消费者安装后的视角检查构建产物，把发布事故挡在 npm publish 前。
- **workspace 依赖仍指向 `dist`**：某个 package 用 `workspace:*` 表示源码依赖，但 package exports 仍然指向构建目录。Limina 会提示这条边没有按源码消费，并可以生成显式的 `tsconfig.dts.paths.generated.json`，让兼容方案变成可审查的配置。

## 接入后的工作方式

接入 Limina 后，你会得到一组可以稳定放进本地、PR 和发布流程的检查：

- 本地开发时，快速知道改动有没有破坏 TypeScript graph 或 checker 覆盖；
- PR 中，reviewer 能看到架构边界变更是否写进了 `limina.config.mjs`、`package.json` 或 `tsconfig*.dts.json`；
- 发布前，能确认消费者真正安装到的 `dist` 产物有正确的 metadata、类型入口、README、license 和 runtime import 边界。

对第一次接触的用户来说，最直接的影响是：你不用先成为 monorepo 专家，也能用失败信息定位“这次应该补 reference、声明依赖、修 package exports，还是补 package output”。
