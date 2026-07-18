# 工作流

这里汇总日常命令序列、`CI` 示例、最佳实践、常见问题和维护者发布检查清单，调用的是 [`CLI` 参考](./cli.md) 中说明的同一批检查。第一次接触 Limina 时，建议先看 [快速开始](./getting-started.md)。

## 推荐工作流

### 本地开发

```sh
pnpm exec limina checker build
pnpm exec limina checker typecheck
pnpm exec limina graph check
```

修改 `TypeScript` 配置或包边界时，可以先运行这些命令，确认生成图、检查器构建和非构建型检查器入口仍然可用。

产物消费关系变化时，可以导出依赖图。Limina 会在被检查的 `tsconfig` 域内，从实际导入和解析结果里推导产物边：

```sh
pnpm exec limina graph export --view artifact --output .limina/dependency-graph.json
```

### Pull Request

```sh
pnpm exec limina check
```

它会一起检查图关系、源码归属、覆盖情况、构建类检查器和只做类型检查的执行器。

### 发布前

```sh
pnpm build
pnpm exec limina package check
pnpm exec limina release check --package <name>
pnpm exec limina check publish
```

::: warning
先构建，确认 `package.entries[].outDir` 中已经有消费者会安装到的文件。
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
          node-version: 22.18.0
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec limina check
```

## 最佳实践

::: tip

- 保持源码 `tsconfig.json` 聚合器只包含 `files: []` 和 `references`。
- 保持源码 `tsconfig` 文件集合意图清晰，并让 Limina 管理 `.limina/` 下的声明构建配置。
- 工作区包导出要保持意图明确：源码入口被消费时，需要由真实导入或 `implicitRefs` 补充出对应引用；产物入口被消费时，会作为限定架构事实出现在 `limina graph export --view artifact` 中。
- 源码检查、包检查和发布检查覆盖不同层面；发布相关检查应放在产物构建之后运行。
- 允许清单保持少而清楚，并解释每个例外为什么安全。

:::

## 常见问题

### limina checker build 和 checker typecheck 如何选择目标？

`checker build` 会运行支持构建模式的预设，也就是 `tsc -b`、`tsgo -b` 和 `vue-tsc -b`。`tsgo` 由 `Microsoft` 的 `@typescript/native-preview` 包提供。`checker typecheck` 会运行只做类型检查的预设，目前是 `vue-tsgo --project <entry>` 和 `svelte-check --tsconfig <entry>`。Limina 有意不让 `vue-tsgo` 进入 `checker build`：当前 `vue-tsgo --build` 不能保持 `TypeScript` 项目引用边界，也不具备增量构建语义；但它配置的 `tsconfig` 入口仍会参与 Limina 图检查和覆盖证明。`Vue` 的构建类检查优先使用 `vue-tsc`。

### 为什么包检查需要先构建？

::: warning
它检查的是 `package.entries[].outDir` 下的包输出。这个输出里必须已经有构建后的 `package.json`、`exports`、`JavaScript` 和声明文件。`release:check` 还会要求打包后的输出包含 `README.md` 和 `LICENSE.md`，且不包含源码映射。
:::

### 工作区导出可以指向 dist 吗？

可以。工作区包导出可以指向源码入口，也可以指向构建产物。Limina 会先要求当前解析配置能解析每个公开导出。只有实际导入的入口解析到声明项目管辖的文件时，生成图才要求对应引用；真实存在但静态导入无法证明的动态或虚拟边，可以用 `liminaOptions.implicitRefs` 补充。`dist/*.d.ts` 这类构建声明不要求项目引用。当某个导入实际解析到 `dist` 时，Limina 会在导入方 `tsconfig` 的条件域内报告产物边。这条边可用于审查和诊断，但不是任务编排保证。

### Vue 或 Svelte 文件应该放进 TypeScript 图吗？

框架文件应该由对应框架检查器入口覆盖。Limina 可以通过 `vue-tsc`、`vue-tsgo` 或 `svelte-check` 证明覆盖，不需要把这些文件假装成普通 `tsc -b` 声明构建项目。

### `--mode` 有什么用途？

当 `limina.config.mts` 导出函数，并需要为本地、`CI` 或发布流程返回不同配置时，使用 `--mode`。

## 维护者发布检查清单

发布 Limina 本身或受 Limina 管理的包之前，确认：

- 常规测试通过；
- `pnpm exec limina check` 通过；
- 包构建已经完成；
- `pnpm exec limina package check --package <name>` 通过；
- `pnpm exec limina release check --package <name>` 通过。

## 相关内容

- [CLI 参考](./cli.md)——全部命令和参数。
- [流水线](./config/pipelines.md)——用内置任务和外部命令组合命名工作流。
- [包检查](./config/package-checks.md)——构建产物条目和 `publint` / `attw` / `boundary`。
- [发布检查](./config/release-checks.md)——`tarball` 与发布卫生检查。
