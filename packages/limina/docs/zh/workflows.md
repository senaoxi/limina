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

- 保持源码 `tsconfig.json` 聚合器经检查器解析后的文件集合为空，并直接声明 `references`；`files: []` 是最清楚的写法。
- Solution 配置应放在名称恰好为 `tsconfig.json` 的入口。解析后无文件且声明 `references` 的 `tsconfig.*.json` 虽然是 TypeScript solution，但不是 Limina 支持的 solution 名称。
- 保持源码 `tsconfig` 文件集合意图清晰，并让 Limina 管理 `.limina/` 下的声明构建配置。
- 工作区包导出要保持意图明确：源码入口被消费时，需要由真实导入或 `implicitRefs` 补充出对应引用；产物入口被消费时，会作为限定架构事实出现在 `limina graph export --view artifact` 中。
- 源码检查、包检查和发布检查覆盖不同层面；发布相关检查应放在产物构建之后运行。
- 允许清单保持少而清楚，并解释每个例外为什么安全。

:::

## 常见问题

### Limina 如何识别 solution 配置？

Limina 会使用当前检查器解析每个可达配置。解析后的有效文件列表为空、且配置直接声明 `references` 时，它就是 TypeScript solution；`extends` 或检查器支持的框架文件也会参与这个判断。只有路径 basename 恰好为 `tsconfig.json` 时，Limina 才会展开这个角色。迁移命令会先汇总所有可达的带名称 solution，再进行任何 worktree 或文件修改。可以把它重命名为 `tsconfig.json`，把引用合并到目录已有的默认入口，或移除 `references` 并把它改成具有明确源码边界的叶子配置。

### limina checker build 和 checker typecheck 如何选择目标？

`checker build` 会运行 final build owner，也就是 `tsc -b`、`tsgo -b` 和 `vue-tsc -b`。`tsgo` 由 Microsoft 的 `@typescript/native-preview` package 提供。`checker typecheck` 会对 final owner 为 Astro 或 Svelte 的 config 按 leaf 执行一次；solution closure 由 Limina 自己展开，共享 leaf 会去重。

Named checker entry 会锁定完整 terminal-leaf closure；自动 evidence 只处理仍为 pending 的 config。创建 target 前，solution leaf 与有效 declaration relation 会按 component 统一染色，因此每条内部 declaration-provider relationship 都使用完全相同的 build-checker identity。

Module semantics 会更早确定，并与 target ownership 分开冻结。只有显式 selection、checker-specific config、effective root file，或已确认的 pending framework dependency 可以锁定 semantic authority。Vue promotion、component coloring、fallback 与 final build owner 都不能改变它。例如，一个 TypeScript-semantic config 可以被染色进 `vue-tsc` build component，但其 import 不会因此被重新解释成 Vue source。

### 为什么包检查需要先构建？

::: warning
它检查的是 `package.entries[].outDir` 下的包输出。这个输出里必须已经有构建后的 `package.json`、`exports`、`JavaScript` 和声明文件。`release:check` 还会要求打包后的输出包含 `README.md` 和 `LICENSE.md`，且不包含源码映射。
:::

### 工作区导出可以指向 dist 吗？

可以。工作区包导出可以指向源码入口，也可以指向构建产物。Limina 会先要求当前解析配置能解析每个公开导出。只有实际导入的入口解析到声明项目管辖的源码时，生成图才要求对应引用；真实存在但静态导入无法证明的动态或虚拟边，可以用 `liminaOptions.implicitRefs` 补充。`dist/*.d.ts` 这类构建声明属于产物边界：它们不会创建 manifest `declaration-provider` edge、生成项目引用或 output-build 引用。Limina 可以为了类型证据或诊断把 managed declaration 反向归因到源码，但这类归因不是构建依赖，也不提供任务编排保证。

### Vue 或 Svelte 文件应该放进 TypeScript 图吗？

在自动 scope 中，包含 Vue root 的 type config 由 `vue-tsc` 负责；包含 Astro 或 Svelte root 的 config 由对应 framework checker 负责。显式 owner 则具有权威性：Astro 只在 TypeScript 基础上增加 `.astro` 观测，Svelte 只增加 `.svelte`；其他已配置源码扩展会成为 proof 覆盖缺口。Astro/Svelte-owned config 不生成声明，需要 emit declaration 的 TypeScript 必须拆到独立 `tsc`、`tsgo` 或 `vue-tsc` boundary。

对于 project dependency，locked semantic authority 才是边界。Vue 与 Astro dependency 来自各自 generated service script；Svelte dependency 来自所属 leaf 的公共 `svelte2tsx` peer 输出。Limina 使用 checker toolchain 枚举 generated TypeScript，要求严格反向 provenance 到源码，并把 synthetic generated import 限定为 observation。Checker-semantic miss 或 mapping failure 不会由 Oxc rescue。只有自动 config 仍处于 pending、且 TypeScript type evidence 为 `missing` 时，Oxc 才能用于识别 governed framework candidate。

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
