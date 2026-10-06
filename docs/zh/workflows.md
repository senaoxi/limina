# 工作流

本页说明接入后的日常检查、局部反馈和发布前检查。首次初始化见[快速开始](./getting-started.md)，完整参数见[命令行参考](./cli.md)。

## 推荐工作流

### 本地开发

需要一轮完整的默认检查时，运行：

```sh
pnpm exec limina check
```

它组合图、源码、覆盖检查和类型检查器执行。只想缩短某类改动的反馈时间时，可以选用相应独立命令：

| 当前任务                     | 命令                                 |
| ---------------------------- | ------------------------------------ |
| 检查声明引用与图规则         | `pnpm exec limina graph check`       |
| 检查源码归属与导入授权       | `pnpm exec limina source check`      |
| 检查源码覆盖                 | `pnpm exec limina proof check`       |
| 执行内部声明构建             | `pnpm exec limina checker build`     |
| 执行 Astro / Svelte 类型检查 | `pnpm exec limina checker typecheck` |

局部命令只覆盖其负责的关系。修改 TypeScript 配置、包边界或检查规则后，应再运行完整的默认检查，避免遗漏其他受影响的关系。

需要观察产物消费关系时，可以导出依赖图：

```sh
pnpm exec limina graph export --view artifact --output .limina/dependency-graph.json
```

产物边来自实际导入，以及配置并验证过的输出目录；目录叫 `dist` 本身不能证明它是产物。导出图用于审查消费关系，不是任务执行计划。详见[依赖图导出](./concepts.md#依赖图导出)。

### 拉取请求 {#pull-request}

```sh
pnpm exec limina check
```

检查报告中的任务结果和覆盖范围。`disabled`、`blocked`、`skipped` 都不能当作相应检查已通过；可选分析器缺失时，还可能出现退出成功但检查被跳过的情况。业务测试和项目构建仍按仓库自身要求运行。

包检查、发布检查不属于默认流水线，需要独立命令或自定义流水线。失败后可按[故障排查](./troubleshooting.md#先定位失败任务)定位问题。

### 发布前

先配置[包产物条目](./config/package-checks.md)，并生成消费者实际安装到的输出。以下 `pnpm build` 是项目自身的生产构建脚本，`<name>` 替换为条目名称：

```sh
pnpm build
pnpm exec limina package check --package <name>
pnpm exec limina release check --package <name>
```

包检查与发布检查不会代为构建或发布。输出目录应有可读的 `package.json` 及相应文件；打包检查还需要 pnpm。检查已启用的分析器是否实际执行，并保留真实消费者测试。

如果已将这些步骤写入 `pipelines.publish`，可以运行：

```sh
pnpm exec limina check publish
```

`publish` 是自定义流水线名称，没有同名内置流水线。它会运行你配置的命令；示例及失败策略见[流水线](./config/pipelines.md)。

## 迁移已有配置

配置迁移使用与 `limina` 同版本的独立 `limina-migrate`。安装匹配版本后运行：

```sh
pnpm exec limina-migrate
pnpm exec limina check
```

迁移完成后先查看 `.limina/migration/latest.json`，再根据检查报告继续修正问题。迁移会在新进程中读取写入后的输入配置，但不执行完整治理或检查器，也不承诺原生 `tsc -b` 等价。

依赖比较不完整时，迁移会保留范围内仍需保护的显式关系，不把未观察到的关系当作不存在。写入范围、恢复方式和动态配置限制见[迁移说明](./cli.md#limina-migration)。

## 持续集成示例 {#ci-示例}

下面的示例执行默认检查。它假定仓库已固定 pnpm 版本，并提交了锁文件和 Limina 配置；框架生成类型等前置工作应在检查前按项目要求完成。

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

- 用户维护源码范围、包清单、公开入口和边界规则；生成配置由 Limina 维护。
- 用空文件集合的 `tsconfig.json` 聚合多个源码配置。源码配置中不手写原生构建 `references`；静态分析无法观察的真实声明关系使用 `implicitRefs`。
- 将生产产物构建放在包检查、发布检查之前；内部声明构建不能替代这一步。
- 对允许清单或忽略项保留具体原因。修改例外意味着改变接受范围，应与普通违规修复分别审查。

## 常见问题

### Limina 如何识别聚合配置？ {#limina-如何识别-solution-配置}

检查器解析后的有效文件集合为空，配置直接声明 `references`，且文件名恰好为 `tsconfig.json`。`files: []` 是最直接的表达，继承选项和框架文件仍影响最终文件集合。详见[聚合配置](./concepts.md#聚合器配置)。

### `limina checker build` 和 `checker typecheck` 如何选择目标？

前者执行 `tsc`、`tsgo`、`vue-tsc` 的声明构建；后者按源码配置执行 Astro、Svelte 类型检查。目标由入口选择和依赖关系共同确定，详细规则见[检查器配置](./config/checkers.md)。

### 为什么包检查需要先构建？

检查对象是选中条目的 `outDir`，需要读取消费者会安装到的包清单与文件。它不会从源码补齐缺失输出。具体工具和跳过状态见[包检查](./config/package-checks.md)。

### 工作区导出可以指向构建产物吗？ {#工作区导出可以指向-dist-吗}

可以。消费已有声明不会反推源码项目引用，也不会自动刷新声明。消费方的构建流程仍需准备产物，见[源码边、声明边与产物边](./concepts.md#源码边、声明边与产物边)。

### Vue 或 Svelte 文件应该放进 TypeScript 图吗？

应让支持该框架的检查器负责相应源码配置。Astro、Svelte 类型检查不生成声明；需要声明输出的 TypeScript 源码应放到支持构建的独立配置中。依赖和预生成要求见[框架前置条件](./config/checkers.md#框架前置条件)。

### `--mode` 有什么用途？

函数配置需要区分本地、持续集成或发布环境时，可以读取 `mode`。它不会自动增加任务，见[配置文件](./config/config-file.md#mode)。

## 维护者发布检查清单

发布前应完成项目测试、适用的 Limina 检查、生产构建、产物检查与真实消费者测试，并审阅禁用和跳过项。Limina 仓库本身还需遵循仓库规定的同版本配对产物与持续集成门禁；上述命令不执行发布。

## 相关内容

- [命令行参考](./cli.md)：命令选择、参数与写入范围。
- [流水线](./config/pipelines.md)：组合内置任务和外部命令。
- [发布检查](./config/release-checks.md)：打包文件与工作区发布依赖。
