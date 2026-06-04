# 工作流

本页汇总日常命令序列、CI 示例、最佳实践、常见问题和维护者发布检查清单。这里的命令调用的是 [CLI 参考](./cli.md) 中说明的同一批检查；第一次接触 Limina 时，建议先看 [快速开始](./getting-started.md)。

## 推荐工作流

### 本地开发

```sh
pnpm exec limina checker build
pnpm exec limina checker typecheck
pnpm exec limina graph check
```

修改 TypeScript 配置或包边界时，可以先跑这两个。

产物消费关系变化时，同步 Nx 目标图。Limina 会从 `link:` 制品依赖，以及实际导入到 `dist` 的 `workspace:*` 导出推导这些边：

```sh
pnpm exec limina nx sync build docs:build
pnpm exec limina nx check build docs:build
```

### Pull Request

```sh
pnpm exec limina check
```

它会一起证明图、源码归属、Nx 项目同步、覆盖情况、一等公民检查器构建和二等公民检查器执行。

### 发布前

```sh
pnpm build
pnpm exec limina package check
pnpm exec limina release check --package <name>
pnpm exec limina check publish
```

::: warning
先构建，确保 `package.entries[].outDir` 中已经有消费者会安装到的文件。
:::

## CI 示例

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec limina check
```

## 最佳实践

::: tip

- 保持 `tsconfig.build.json` 为只包含 `files: []` 和 `references` 的纯聚合器。
- 声明叶子应靠近本地配套配置，并只额外添加声明输出设置。
- 工作区包导出要保持意图明确：源码入口被消费时需要引用，产物入口被消费时需要构建边。
- 源码检查、包检查和发布检查都要跑，它们保护的是不同层。
- 允许清单保持少而清楚，并解释每个例外为什么安全。

:::

## 常见问题

### `limina checker build` 和 `checker typecheck` 如何选择目标？

`checker build` 会从已配置入口运行一等公民构建执行预设（`tsc -b`、`tsgo -b` 和 `vue-tsc -b`）。`tsgo` 由 Microsoft 的 `@typescript/native-preview` 包提供。`checker typecheck` 会直接运行二等公民类型检查执行预设，目前是 `vue-tsgo --project <entry>` 和 `svelte-check --tsconfig <entry>`。Limina 有意不让 `vue-tsgo` 进入 `checker build`：当前 `vue-tsgo --build` 不能保持 TypeScript 项目引用边界，也不具备增量构建语义；但它配置的 tsconfig 入口仍会参与 Limina 图检查和覆盖证明。一等公民 Vue 构建检查优先使用 `vue-tsc`。

### 为什么包检查需要先构建？

::: warning
它检查的是 `package.entries[].outDir` 下的包输出。这个输出里必须已经有构建后的 `package.json`、exports、JavaScript 和声明文件。`release:check` 还会要求打包后的输出包含 README/license，且不包含源码映射。
:::

### 工作区导出可以指向 dist 吗？

可以。工作区包导出可以指向源码入口，也可以指向构建产物。Limina 会先要求 TypeScript 和 Oxc 能解析每个公开导出。只有实际导入的入口解析到声明项目管辖的文件时，图引用才要求项目引用；`dist/*.d.ts` 这类构建声明不要求项目引用。当某个 `workspace:*` 导入实际解析到 `dist` 时，`limina nx check` 会要求消费方包通过 `dependsOn` 指向生产方构建目标。

### Vue 或 Svelte 文件应该放进 TypeScript 图吗？

框架文件应该由对应框架检查器入口覆盖。Limina 可以通过 `vue-tsc`、`vue-tsgo` 或 `svelte-check` 证明覆盖，不需要把这些文件假装成普通 `tsc -b` 声明叶子。

### `--mode` 适合哪些配置？

当 `limina.config.mjs` 导出函数，并且本地、CI 或发布流程需要返回不同配置时使用。

## 维护者发布检查清单

发布 Limina 自身或由 Limina 管理的包前，建议确认：

- 常规测试通过；
- `pnpm exec limina check` 通过；
- 包构建已经运行；
- `pnpm exec limina package check --package <name>` 通过；
- `pnpm exec limina release check --package <name>` 通过。

## 延伸阅读

- [CLI 参考](./cli.md)：每条命令和参数。
- [流水线](./config/pipelines.md)：用内置任务和外部命令组合命名工作流。
- [包检查](./config/package-checks.md)：构建产物条目和 `publint` / `attw` / `boundary`。
- [发布检查](./config/release-checks.md)：tarball 和发布卫生。
