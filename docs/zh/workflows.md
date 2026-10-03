# 工作流

本页列出日常命令、持续集成示例、配置建议、常见问题和发布检查清单。命令详情见[命令行参考](./cli.md)，初次接入可按[快速开始](./getting-started.md)操作。

## 推荐工作流

配置迁移请使用与 Limina 同版本的独立 `limina-migrate` 包；行为与边界见[迁移契约](./cli.md#limina-migration)。该工具的发布产物内嵌同版本核心包的输入读取实现；配置如果导入公开的 `limina`，仍须在配置解析依赖的位置安装它。`limina migration` 是弃用的转调入口，使用本地匹配版本的工具，或通过 npm 获取与核心包版本完全一致的工具。仅供工作区使用的 `limina/internal/*` 入口会从核心包发布清单的 `exports` 中移除。

迁移后查看 `.limina/migration/latest.json`，再运行 `limina check`。迁移会验证新进程能在 `check` 和 `graph` 命令配置下读取已写入的输入拓扑，并保留受保护成员的可达性；这不执行完整的图治理或检查器，也不承诺等价的原生 `tsc -b` 行为。依赖比较不完整时，会保留仍在范围内的显式源码关系，不把缺失事实当成空推导图。

### 本地开发

```sh
pnpm exec limina checker build
pnpm exec limina checker typecheck
pnpm exec limina graph check
```

修改 `TypeScript` 配置或包边界后，运行这些命令可检查图，并执行选中的检查器构建和类型检查目标。

产物消费关系变化时，可以导出依赖图。Limina 会在被检查的 `tsconfig` 范围内，从实际导入和解析结果里推导产物边。分类先依据源码归属，再依据 `liminaOptions.outputs` 或包产物条目声明并通过验证的输出根。`lib/` 等自定义输出可以产生这类产物边；仅有 `dist/` 目录名不能证明文件是产物，其中受管源码仍归为源码。

```sh
pnpm exec limina graph export --view artifact --output .limina/dependency-graph.json
```

### 拉取请求 {#pull-request}

```sh
pnpm exec limina check
```

默认流水线会一起检查图关系、源码归属、覆盖情况、构建类检查器和只做类型检查的执行器。需查看任务和检查项的结果：禁用（`disabled`）、受阻（`blocked`）或跳过（`skipped`）的工作没有通过相应检查。包检查和发布检查需要单独的命令或已配置的流水线任务。

### 发布前

```sh
pnpm build
pnpm exec limina package check
pnpm exec limina release check --package <name>
pnpm exec limina check publish
```

这里的 `pnpm build` 是项目自身的构建脚本，`<name>` 是已配置的包产物条目名称，最后一条命令要求用户定义 `pipelines.publish`。没有内置 `publish` 流水线。包检查和发布检查命令不会执行发布；项目脚本和流水线会运行你配置的命令。

::: warning 注意
先构建，确认选中的 `package.entries[].outDir` 中已经有消费者会安装到的文件。需配置并启用所需的包／发布检查；不可用的可选分析器可能被跳过，命令成功本身不能证明它已执行。
:::

## 持续集成示例 {#ci-示例}

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

::: tip 提示

- 保持源码 `tsconfig.json` 聚合器经检查器解析后的文件集合为空，并直接声明 `references`；`files: []` 是最清楚的写法。
- 聚合配置应放在名称恰好为 `tsconfig.json` 的入口。解析后无文件且声明 `references` 的 `tsconfig.*.json` 虽然是 TypeScript 意义上的聚合配置，但不是 Limina 支持的聚合配置名称。
- 明确配置源码 `tsconfig` 的文件集合，由 Limina 生成 `.limina/` 下的声明构建配置。
- 按实际消费关系检查工作区导出：被消费的源码入口可能需要声明提供者引用或 `implicitRefs`；位于已验证输出根的被消费产物可以出现在 `limina graph export --view artifact` 中。未使用的导出不会创建这些边。
- 源码检查、包检查和发布检查覆盖不同层面；发布相关检查应放在产物构建之后运行。
- 允许清单只保留所需例外，并解释每个例外为什么安全。

:::

## 常见问题

### Limina 如何识别聚合配置？ {#limina-如何识别-solution-配置}

Limina 使用实际检查器解析每个可达配置。有效文件集合为空且直接声明 `references` 时，配置具有 TypeScript 的聚合配置语义；`extends` 和检查器支持的框架文件仍影响文件集合。Limina 只展开文件名恰好为 `tsconfig.json` 的聚合配置。迁移可将文件名不是 `tsconfig.json`、仅用于聚合成员的包装配置展开到保留的聚合父配置，重定位路径并保护源码成员关系；也可以剪除仅含路径的包装节点或聚合环边，再补偿保留源码的可达性。包装节点带有实质 Limina 声明，或引用属性无法传播或安全删除时，仍需手动转换，详见[迁移](./cli.md#limina-migration)。

### `limina checker build` 和 `checker typecheck` 如何选择目标？

`checker build` 会运行最终负责构建的检查器，也就是 `tsc -b`、`tsgo -b` 和 `vue-tsc -b`。`tsgo` 由 Microsoft 的 `@typescript/native-preview` 包提供。`checker typecheck` 会对最终由 Astro 或 Svelte 检查器负责的配置，按叶子配置执行一次；聚合配置的引用闭包由 Limina 自己展开，共享的叶子配置会去重。

显式命名的检查器入口会锁定末端叶子配置的完整引用闭包；自动发现的证据只处理仍待判定的配置。创建目标前，聚合配置的叶子配置与有效声明关系会按连通分量统一分配检查器，因此每条内部声明提供者关系都使用完全相同的构建检查器标识。

模块语义会更早确定。解析源码时确定的语义判定依据，与目标的检查器归属分开冻结：只有显式选择、检查器专用配置、有效根文件，或待判定阶段已确认的框架依赖，才能锁定这一依据。Vue 提升、按连通分量统一分配检查器、回退选择与最终负责构建的检查器都不能改变它。例如，按 TypeScript 语义解析的配置可以被分配到由 `vue-tsc` 构建的连通分量，但其导入不会因此被重新解释成 Vue 源码。

### 为什么包检查需要先构建？

::: warning 注意
它检查选中的 `package.entries[].outDir` 下的包输出。每个输出需要可读的 `package.json` 及其发布清单声明的文件；JavaScript、声明文件和 `exports` 的要求取决于该包公开提供的入口和文件。启用发布包归档检查时，打包后的输出还必须包含 `README.md` 和 `LICENSE.md`，且不能包含源码映射文件或 JavaScript `sourceMappingURL` 指令。
:::

### 工作区导出可以指向构建产物吗？ {#工作区导出可以指向-dist-吗}

可以。工作区包导出可以指向源码入口，也可以指向构建产物。图检查按导入方检查器的解析配置处理实际被导入消费的入口；未使用的损坏导出不会使图检查失败。被消费的源码关系具有声明提供者需求，且有合法的受管声明提供者时，生成图才要求对应引用；真实存在但静态导入无法证明的动态或虚拟边，可以用 `liminaOptions.implicitRefs` 补充。`dist/*.d.ts` 这类构建声明属于产物边界：它们不会创建清单中的 `declaration-provider`（声明提供者）边、生成项目引用或输出构建引用。Limina 可以为了类型证据或诊断把受管声明反向归因到源码，但这类归因不是构建依赖，也不提供任务编排保证。

### Vue 或 Svelte 文件应该放进 TypeScript 图吗？

在自动发现范围内，包含 Vue 根文件的类型配置由 `vue-tsc` 负责；包含 Astro 或 Svelte 根文件的配置由对应框架检查器负责。显式指定的检查器归属则具有权威性：Astro 只在 TypeScript 基础上增加 `.astro` 观测，Svelte 只增加 `.svelte`；其他已配置源码扩展会成为覆盖证明的缺口。由 Astro 或 Svelte 检查器负责的配置不生成声明，需要输出声明的 TypeScript 源码必须拆到独立的 `tsc`、`tsgo` 或 `vue-tsc` 边界。

对于项目依赖，已经锁定的语义判定依据才是边界。Vue 与 Astro 依赖来自各自生成的服务脚本；Svelte 依赖来自所属叶子配置解析到的公共 `svelte2tsx` 对等依赖输出。Limina 使用检查器工具链枚举生成的 TypeScript，要求能严格反向追溯到源码，并把生成过程中合成的导入限定为观测事实。检查器语义解析未命中或映射失败时，不会由 Oxc 补救。只有自动发现的配置仍待判定，且 TypeScript 类型证据为缺失（`missing`）时，Oxc 才能用于识别受治理的框架候选。

### `--mode` 有什么用途？

当 `limina.config.mts` 导出函数，并需要为本地、持续集成或发布流程返回不同配置时，使用 `--mode`。

## 维护者发布检查清单

发布 Limina 本身或受 Limina 管理的包之前，确认：

- 常规测试通过；
- `pnpm exec limina check` 通过；
- 包构建已经完成；
- `pnpm exec limina package check --package <name>` 通过；
- `pnpm exec limina release check --package <name>` 通过。

同时检查报告中的覆盖范围和跳过项。发布 Limina 本身还需遵循仓库对同版本 `limina` 与 `limina-migrate` 配对产物的发布工具与持续集成门禁；本清单不授权也不执行发布。

## 相关内容

- [命令行参考](./cli.md)——全部命令和参数。
- [流水线](./config/pipelines.md)——用内置任务和外部命令组合命名工作流。
- [包检查](./config/package-checks.md)——构建产物条目和 `publint` / `attw` / `boundary`。
- [发布检查](./config/release-checks.md)——包归档与发布卫生检查。
