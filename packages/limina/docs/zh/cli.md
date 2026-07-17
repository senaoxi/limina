# CLI 参考

如果你已经在 `TypeScript` 单体仓库中接入 Limina，或准备把 `TypeScript` 项目引用纳入日常检查流程，核心问题不是记住所有命令，而是理解：哪些命令会生成工程图，哪些命令会检查工程图与源码事实是否一致，哪些命令只用于补充检查已构建产物。

Limina 的 `CLI` 主线围绕 `TypeScript` 项目引用展开。它根据配置和源码生成 `.limina` 下的工程图，再基于这个工程图检查源码归属、包依赖、项目引用、检查器入口和源码覆盖。没有自动治理时，开发者需要手动判断并维护哪些源码关系应该进入 `references` 图；Limina 的作用是把这类判断转化为可重复运行的命令和报告。

Limina 不替代 `TypeScript`、`Vue`、`Svelte`、打包器、测试框架、包管理器或发布工具。它会调用或组织这些工具的一部分能力，并在 `TypeScript` 项目引用、生成的工程图和已构建产物之上补充检查。包检查和发布检查是辅助能力，不应理解为发布安全保证。

## 快速开始

Limina 需要运行在 `pnpm` 工作区内。当前包配置要求 `Node.js ^22.18.0 || >=24.11.0`。如果手动安装，使用：

```sh
pnpm add -D limina@^0.1.1 typescript@^5.9.0
```

在已有 `pnpm` 工作区中初始化：

```sh
pnpm exec limina init --yes
pnpm i
pnpm limina:build
pnpm exec limina check
```

`limina init --yes` 会使用默认确认流程，适合非交互环境。它会写入或更新 `limina.config.mts`、根 `package.json` 中的 `limina:build` 脚本和必要依赖，并确保 `.gitignore` 忽略 `.limina/`。如果依赖已经存在，`pnpm i` 可能不产生变化；如果初始化过程新增了依赖，则需要先安装依赖再运行构建。

默认生成的配置只启用自动检查器发现：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      mode: 'auto',
      exclude: [],
    },
  },
});
```

这只是起点。仓库如果需要自定义检查器入口、图规则、源码例外、包产物检查或发布一致性检查，应在 `limina.config.mts` 中继续配置。

## 命令入口与全局选项

基础格式：

```sh
limina [--config <path>] [--config-loader <loader>] [--mode <mode>] <command>
```

全局选项适用于需要加载 Limina 配置文件的命令。`init` 直接面向当前 `pnpm` 工作区，不依赖已有配置。

| 选项                       | 类型             | 默认行为                                                                                                                          | 相关配置                    | 示例                                        | 边界                                         |
| -------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------- | -------------------------------------------- |
| `--config <path>`          | 路径             | 从当前目录向上依次查找 `limina.config.mts`、`limina.config.mjs`、`limina.config.ts`、`limina.config.js`，直到 `pnpm` 工作区根目录 | Limina 配置文件             | `limina --config ./limina.config.mts check` | 配置文件必须位于当前 `pnpm` 工作区内         |
| `--config-loader <loader>` | `native` / `tsx` | `native`                                                                                                                          | 配置模块加载器              | `limina --config-loader tsx check`          | `tsx` 需要接入工作区安装 `tsx`               |
| `--mode <mode>`            | 字符串           | `process.env.NODE_ENV`，否则为 `default`                                                                                          | 函数式配置接收的 `env.mode` | `limina --mode ci check`                    | 只把模式传给配置函数；具体差异由配置文件实现 |

配置文件可以导出对象、`Promise`，或接收 `{ command, mode }` 的函数。`command` 表示当前命令族，例如 `check`、`graph`、`source`、`package` 或 `release`。

## 推荐工作流

日常使用通常从 `limina check` 开始。它运行默认检查组合：`graph:check`、`source:check`、`proof:check`、`checker:build`、`checker:typecheck`。这些任务共同检查工程图、源码边界、覆盖关系和检查器入口是否仍然一致。

这些任务之前，Limina 会运行共享 preparation `workspace:validate`。独立的源码、证明、图、构建、检查器、迁移、包和发布命令也由同一份已验证激活包索引把关。工作区 issue 使用相对于 `config.rootDir` 的词法路径，外部激活包会保留 `../`。

当你修改了 `tsconfig`、`references`、检查器包含范围或会影响工程图的源码结构时，先运行：

```sh
pnpm exec limina graph prepare
pnpm exec limina check
```

当你只需要定位上一次失败的原因时，不必重新运行所有检查，可以读取最近一次检查快照：

```sh
pnpm exec limina check --issues
pnpm exec limina check --issues --limit 20
pnpm exec limina check --issues --task workspace:validate
pnpm exec limina check --issues --rule LIMINA_GRAPH_REFERENCE_MISSING --verbose
pnpm exec limina check --issues --verbose --limit all
pnpm exec limina check --issues --format json
```

当你只想构建 Limina 内部声明图时，使用 `checker build`。当你需要构建用户可消费的产物时，使用顶层 `build` 命令：

```sh
pnpm exec limina checker build packages/app/tsconfig.json
pnpm exec limina build packages/app/tsconfig.json
pnpm exec limina build packages/app/tsconfig.json --preset vue-tsc
pnpm exec limina build packages/app/tsconfig.raw.json --raw --preset tsc
```

当你准备发布包时，应先运行项目自己的构建流程，再运行补充检查：

```sh
pnpm exec limina package check --package @scope/pkg
pnpm exec limina release check --package @scope/pkg
```

这两个命令读取已构建的 `outDir`，不会替你构建产物，也不会执行发布。

## 决策表

| 目标                                 | 推荐命令                                   | 判断依据                                                                            |
| ------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| 初始化 `pnpm` 工作区中的 Limina 文件 | `limina init` 或 `limina init --yes`       | 首次接入，或需要生成基础配置与 `limina:build` 脚本                                  |
| 迁移被治理的源码 `tsconfig`          | `limina migration`                         | 工作区验证后，把编译器输出设置迁入 `liminaOptions`                                  |
| 日常检查仓库结构和类型构建入口       | `limina check`                             | 默认组合覆盖工程图、源码、证明和检查器入口                                          |
| 自定义一组按顺序运行的检查           | `limina check <name>`                      | `<name>` 来自配置中的 `pipelines`                                                   |
| 生成或刷新 `.limina` 工程图          | `limina graph prepare`                     | 修改了 `tsconfig`、检查器范围或源码结构后                                           |
| 检查项目引用和源码依赖是否一致       | `limina graph check`                       | 关注 `references`、源码导入、包依赖和图规则                                         |
| 导出包依赖图 `JSON`                  | `limina graph export`                      | 需要把源码依赖或产物依赖交给外部工具处理                                            |
| 只检查源码边界和归属                 | `limina source check`                      | 关注源码包边界、依赖声明和 `Knip` 支撑的源码使用情况                                |
| 检查源码是否被工程图或检查器覆盖     | `limina proof check`                       | 关注遗漏源码、检查器覆盖和白名单有效性                                              |
| 运行内部声明图构建入口               | `limina checker build`                     | 使用生成图中的构建型检查器入口，只产出 `.limina` 内部声明文件                       |
| 对指定配置运行内部声明图构建         | `limina checker build <config>`            | 只接受 Limina 管理的源码配置或聚合配置，不执行 `raw build`                          |
| 构建用户可消费产物                   | `limina build <config>`                    | 只接受 Limina 管理且声明了 `liminaOptions.outputs` 的源码叶子或聚合配置             |
| 直接构建用户维护的 `tsconfig`        | `limina build <config> --raw --preset tsc` | 不读取 Limina 输出配置，不使用生成图                                                |
| 运行非构建型检查器入口               | `limina checker typecheck`                 | 例如配置了 `vue-tsgo` 或 `svelte-check` 这类仅类型检查入口                          |
| 检查已构建包产物                     | `limina package check`                     | 已有 `package.entries[].outDir`，需要检查清单文件、`publint`、`ATTW` 或产物导入边界 |
| 检查发布前产物一致性                 | `limina release check`                     | 已构建产物，且需要检查本地依赖声明、私有包、打包结果或配置的发布一致性              |

## 命令参考

### limina init

`init` 用于在 `pnpm` 工作区中生成 Limina 的基础接入文件。

```sh
pnpm exec limina init
pnpm exec limina init --yes
```

它会从当前目录向上查找 `pnpm-workspace.yaml`，确认工作区根目录，检查工作区包，然后执行以下操作：写入或更新 `limina.config.mts`；确保 `.gitignore` 包含 `.limina/`；创建或更新根 `package.json` 中的 `limina:build` 脚本；在缺少 `limina` 或 `typescript` 时补充开发依赖；清理根目录下已有的 `.limina` 生成目录；在交互模式下询问是否安装 Limina `agent skill`。

`--yes` 会接受默认确认，并跳过交互式 `skill` 安装提示。非交互环境中如果不使用 `--yes`，需要用户确认的步骤会失败。

`init` 不会根据仓库业务结构推断图规则，也不会替你决定哪些包边界应被允许或拒绝。初始化后的配置应按仓库真实结构继续维护。

### limina migration

`migration` 会改写已验证激活 package island 中选中的源码 `tsconfig` 入口。

```sh
pnpm exec limina migration
```

外部激活包也受支持，包括目标分布在多个 Git worktree 的迁移。任何写入开始前，Limina 会解析每个目标的规范 Git worktree 根目录，并要求所有涉及的 worktree 都是 clean 状态；随后以这些规范根目录作为完整写入 allowlist 执行一次事务。外部 worktree 只要有未提交变更，就会阻止全部写入；每个目标都必须属于一个 Git worktree。

迁移选择与图准备使用相同的 package-island 可见性和 checker selector。即使祖先模式可以匹配，迁移也不会读取或修改 owner-local 边界后的配置。

### limina check [pipeline]

`check` 是日常入口。

```sh
pnpm exec limina check
pnpm exec limina check ci
pnpm exec limina check --package @scope/pkg
```

不带 `pipeline` 时，默认检查组合为：

```txt
graph:check
source:check
proof:check
checker:build
checker:typecheck
```

默认组合中的任务按可用资源独立调度。命名流水线来自配置中的 `pipelines`，通过 `limina check <name>` 运行，步骤按配置顺序执行。流水线步骤可以是内置任务，也可以是外部命令；外部命令支持对象形式配置 `command`、`args`、`cwd` 和 `env`。

常用选项：

| 选项                   | 类型                      | 默认行为           | 示例                                                          | 边界                                             |
| ---------------------- | ------------------------- | ------------------ | ------------------------------------------------------------- | ------------------------------------------------ |
| `-p, --package <name>` | 可重复字符串              | 不限制包           | `limina check -p @scope/pkg`                                  | 只影响支持包选择的任务                           |
| `--verbose`            | 布尔值                    | 输出精简摘要       | `limina check --verbose`                                      | 扩展实时运行摘要；配合 `--issues` 时输出详细卡片 |
| `--rule <code>`        | 可重复字符串              | 不按规则过滤       | `limina check --issues --rule LIMINA_GRAPH_REFERENCE_MISSING` | 作为问题查询时需要配合 `--issues`                |
| `--file <path>`        | 可重复路径                | 不按文件过滤       | `limina check --issues --file packages/a/src/index.ts`        | 匹配精确文件路径                                 |
| `--scope <glob>`       | 可重复路径或 `glob`       | 不按路径范围过滤   | `limina check --issues --scope 'packages/a/**'`               | 只匹配带路径的问题候选                           |
| `--task <name>`        | 可重复字符串              | 不按任务过滤       | `limina check --issues --task source:check`                   | 必须配合 `--issues`                              |
| `--checker <name>`     | 可重复字符串              | 不按检查器过滤     | `limina check --issues --checker vue`                         | 这里只用于问题快照过滤，不是构建检查器选择       |
| `--issues`             | 布尔值                    | 读取最近摘要       | `limina check --issues`                                       | 读取最近一次已完成检查；不能带流水线名           |
| `--limit <limit>`      | 正整数或 `all`            | 显示 20 张问题卡片 | `limina check --issues --limit 50`                            | 只用于 human 问题清单；必须配合 `--issues`       |
| `--invocation <uuid>`  | UUID                      | 读取最近检查       | `limina check --issues --invocation <uuid>`                   | 读取一条不可变的 standalone 失败记录             |
| `--format <format>`    | `human`、`json`、`ndjson` | `human`            | `limina check --issues --format json`                         | 必须配合 `--issues`                              |

`--issues` 不会重新执行检查。不带 `--invocation` 时，它读取最近一次进入终态的 `limina check` 结果，用于定位失败任务、规则、包、文件或检查器。正在运行或被中断的检查不会替换上一次已完成结果，standalone 命令也不会替换它。工作区验证失败同样可以记录：受信任的 `.limina` snapshot namespace 会在验证前建立，因此结构错误仍可出现在 `workspace:validate` 任务下。第一次使用默认问题清单前，需要让 `limina check` 至少完整结束一次。

问题输出分为四档：

| 视图 | 触发方式                                                                                   | 输出内容                                                                                           | 可见问题上限 |
| ---- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------ |
| 摘要 | `limina check --issues`，且没有 filter、invocation 或显式 limit                            | 基于完整过滤结果的计数、主要阻塞项和后续命令；不输出问题卡片                                       | 不输出卡片   |
| 精简 | 添加 task、rule、package、file、scope 或 checker filter；选择 invocation；或传入 `--limit` | 每个选中问题一张固定结构卡片，只显示一个位置、规则、可选归属/工具，以及单行 summary、reason 或 fix | 默认 20      |
| 详细 | 在问题查询中加入 `--verbose`                                                               | 显示选中问题的全部位置、evidence、外部诊断、修复步骤、验证命令和去重后的原始详情                   | 默认 20      |
| 机器 | 使用 `--format json` 或 `--format ndjson`                                                  | 按既有机器契约输出完整过滤结果                                                                     | 永不截断     |

human 摘要中的计数和主要阻塞项始终基于完整过滤结果。精简与详细卡片采用确定性采样：Limina 会先让互不相关的根因都有展示机会，再从同一根因取第二个样本；同一根因内部则轮换不同 package。报告会显示 `Showing X of Y issues`。使用 `--limit <正整数>` 指定精确卡片预算，使用 `--limit all` 显示全部匹配卡片。零匹配时仍保留摘要、filter diagnostics 和帮助命令，但不会输出空卡片区。

`--limit` 只能用于 human 格式的 `check --issues`。JSON 与 NDJSON 会拒绝该选项，并始终返回全部过滤结果；`--verbose` 不改变机器输出。`limina check --verbose` 与 `limina check --issues --verbose` 的作用不同：前者扩展运行级聚合行、耗时、规则、阻塞项和 package 计数，但不会输出原始问题诊断；后者选择详细问题卡片视图。

会产生问题的 standalone 命令失败时，会打印 standalone invocation ID 和可直接执行的 shell 专用查询。查询使用 `pnpm --dir <workspaceRoot> exec limina`，携带 canonical absolute config path、实际生效的 config loader 与 mode，并通过 `check --issues --invocation <uuid>` 选择对应记录。`--dir` 前缀会解析工作区本地安装的 Limina，因此即使当前 shell 位于工作区之外，也可以直接复制并执行该查询。每次 invocation 都独立保存在 `.limina/check/invocations/` 下；问题查询只定位工作区，不会导入或验证 Limina 配置。

在 POSIX 系统上，命令标签为 `Query:`。在 Windows 上，Limina 不猜测当前 shell，而是同时输出 `PowerShell:` 与 `cmd.exe (/V:OFF):` 两个 variant。同一个 PowerShell variant 同时适用于 Windows PowerShell 5.1 与 PowerShell 7。CMD variant 要求关闭 delayed expansion；不支持 `cmd.exe /V:ON`。

invocation 是 selector，不是问题 filter，因此默认 human 视图会进入精简档。human header 会显示 invocation ID、kind、result 和完成时间。生成的 refine、detailed、complete、JSON 与 filter-help 命令会保留同一个 invocation ID、当前全部 filters 和显式全局配置上下文。记录中的原始命令只作为元数据显示，不会用于拼接新查询。

`--file` 做精确匹配，`--scope` 接受目录或 `glob`。两者都接受工作区相对路径、`./` 路径、绝对路径以及两种斜杠形式。它们只匹配问题文件、包 manifest 等真正带路径的候选；配置 field scope 等 diagnostic label 不会被当作路径。同一过滤项重复传入时采用 OR 语义。

check snapshot 使用 schema version 7，读取器也只接受 version 7。

辅助查询：

```sh
pnpm exec limina check --issues --task --help
pnpm exec limina check --issues --package --help
pnpm exec limina check --issues --checker --help
pnpm exec limina check --issues --rule --help
```

task help 始终列出全部静态公开检查任务，再合并 snapshot 中出现的任务。因此即使 snapshot 不存在或问题数为零，它仍然可用。package 和 checker help 仍由 snapshot 内容生成。

### limina graph \<action\>

`graph` 命令负责生成、检查和导出工程图。

```sh
pnpm exec limina graph prepare
pnpm exec limina graph check
pnpm exec limina graph export
pnpm exec limina graph export --view source --output graph.json
```

`graph prepare` 根据检查器配置、源码 `tsconfig`、工作区包和源码导入关系生成 `.limina` 下的工程图与检查器入口。它适合在 `tsconfig`、检查器包含范围、源码结构或项目引用关系变化后运行。

`graph check` 检查生成图与源码事实是否一致。它覆盖项目引用、源码图路由、条件域、引用完整性、图规则、工作区包依赖声明和部分解析边界。典型问题包括：源码导入对应的项目引用缺失；项目引用多余；跨包项目引用缺少依赖声明；图规则拒绝访问；工作区导入无法解析或目标不在工程图中。

`graph export` 输出包级依赖图 `JSON`。`--view` 可取 `all`、`source` 或 `artifact`，默认是 `all`。不传 `--output` 时输出到标准输出；传入 `--output <path>` 时写入文件。该导出用于给外部任务工具或分析工具消费，不表示 Limina 内置了任务编排能力。

### limina source check

`source check` 聚焦源码归属和源码包边界。

```sh
pnpm exec limina source check
pnpm exec limina source check --package @scope/pkg
pnpm exec limina source check --scope 'packages/app/**' --verbose
```

`limina source check --scope` 还接受相对于所选源码 owner 的范围。例如对 `packages/app` owner，`src/theme` 可以匹配 `packages/app/src/theme`；工作区相对路径、绝对路径和 glob 形式也继续有效。

它检查源码文件是否属于 `pnpm` 工作区源码拥有者，非聚合型 `tsconfig` 是否混合多个源码拥有者，普通相对导入是否越过最近的 `package.json` 包边界，裸包导入是否由最近的源码拥有者或显式规则授权，`#...` 包导入是否保持在声明包范围内，以及 `Knip` 支撑的源码使用情况。

`Knip` 相关检查依赖 `knip` 这个对等依赖，并受 `source.knip` 配置影响。关闭或调整 `Knip` 配置只影响这部分源码使用检查，不会关闭图检查、覆盖证明检查或检查器执行。

`source check` 不替代 `ESLint`、测试框架或运行时检查。它主要把源码归属、包边界和依赖声明关系转化为可过滤的问题报告。

### limina proof check

`proof check` 用于检查源码覆盖关系。

```sh
pnpm exec limina proof check
pnpm exec limina proof check --verbose
```

它基于生成工程图、检查器入口、项目路由、源码边界和 `proof.allowlist`，检查源码文件是否被工程图或检查器覆盖，并报告检查器覆盖目标、默认 `tsconfig`、声明配置、本地配套配置或白名单相关的问题。

这个命令不表示“完整类型安全证明”。更准确地说，它检查 Limina 当前能够治理的源码集合是否能被已生成的项目图或检查器入口解释，避免源码落在治理范围之外而不被注意。

### limina build \<config\>

`build` 构建用户可消费产物。托管模式只接受 Limina 管理的配置：源码叶子必须声明 `liminaOptions.outputs`；聚合配置下递归引用的源码叶子至少要有一个声明了 `liminaOptions.outputs`。

```sh
pnpm exec limina build packages/app/tsconfig.json
pnpm exec limina build packages/app/tsconfig.json --preset tsc
pnpm exec limina build packages/app/tsconfig.json --watch
pnpm exec limina build packages/app/tsconfig.raw.json --raw --preset vue-tsc
```

托管模式会生成并运行 `.limina/tsconfig/checkers/<checker>/outputs/` 下的输出构建配置。多个构建型检查器同时匹配目标时，必须传 `--preset`。`--watch` 使用对应检查器适配器的监听能力；不支持时会明确失败。

托管构建在非 `watch` 模式成功后，还会补充 TypeScript emit：把输出 `rootDir` 内的本地声明输入（`.d.ts`、`.d.cts`、`.d.mts`）按相对路径复制到 `outDir`。位于 `rootDir` 外或依赖包中的声明不会被复制；需要时把声明移入 `rootDir`、扩大 `liminaOptions.outputs.rootDir`，或添加显式复制步骤。

`--raw` 用于直接运行 `tsc`、`tsgo` 或 `vue-tsc` 构建用户维护的 `tsconfig`。原始模式必须传 `--preset`，不会准备生成图，不读取 `liminaOptions.outputs`，不使用 Limina 推断引用，并拒绝 `.limina` 下的生成配置。

### limina checker build [config]

`checker build` 只构建 Limina 内部声明图。支持的构建型预设是 `tsc`、`tsgo` 和 `vue-tsc`。

```sh
pnpm exec limina checker build
pnpm exec limina checker build packages/app/tsconfig.json
pnpm exec limina checker build packages/app/tsconfig.json --preset tsc
pnpm exec limina checker build packages/app/tsconfig.json --preset vue-tsc --watch
```

不带 `config` 时，命令使用生成工程图中的所有构建型检查器入口。带 `config` 时，Limina 只解析已管理配置对应的内部声明目标；如果配置不由 Limina 管理，会立即失败。该命令不读取 `liminaOptions.outputs`，不会生成 `dist` 等用户产物，也不会对用户维护的 `tsconfig` 执行 `raw build`。

`--watch` 只允许和配置路径一起使用。`--preset` 也需要配置路径。

这个命令仍然依赖对应检查器包。缺少 `peer dependency` 时，报告会提示需要安装的包，例如 `typescript`、`vue-tsc` 或 `@typescript/native-preview`。

### limina checker typecheck

`checker typecheck` 运行非构建型检查器入口。

```sh
pnpm exec limina checker typecheck
pnpm exec limina checker typecheck --verbose
```

源码中内置的非构建型检查器包括 `vue-tsgo` 和 `svelte-check`。`vue-tsgo` 的入口仍可参与源码图和覆盖证明；`svelte-check` 作为检查器入口参与覆盖证明和类型检查执行，但当前不作为源码图提供者。二者都不作为 `checker build` 的构建型执行入口。

`checker typecheck` 不接受配置路径、`--preset` 或 `--watch`。如果没有配置任何非构建型检查器入口，该命令会以无可运行入口的状态通过。

### limina package check

`package check` 检查已构建的包输出，是补充能力。

```sh
pnpm exec limina package check
pnpm exec limina package check --package @scope/pkg
pnpm exec limina package check --package @scope/pkg --tool publint
pnpm exec limina package check --tool attw --attw-profile strict
```

它读取配置中的 `package.entries`，进入每个条目的 `outDir`，读取已构建产物中的 `package.json`。如果启用了 `publint` 或 `attw`，会先把输出目录打成临时 `tarball` 再交给对应工具检查；如果启用了 `boundary`，会扫描输出目录中的 `JavaScript` 文件，检查外部包导入、自引用导入和 `Node` 内置模块使用是否符合产物清单与配置。

`--tool` 可取 `all`、`publint`、`attw` 或 `boundary`。`--attw-profile` 可取 `strict`、`node16` 或 `esm-only`，默认由配置或源码默认值决定；源码默认 `profile` 为 `esm-only`。

`package check` 不运行构建，不发布包，也不保证产物可在所有消费环境中工作。它只根据配置和已构建产物报告可证明的问题。

### limina release check

`release check` 检查发布前的包产物一致性，也是补充能力。

```sh
pnpm exec limina release check
pnpm exec limina release check --package @scope/pkg
pnpm exec limina release check --package @scope/pkg --verbose
```

它同样基于 `package.entries` 选择产物目录，并要求被检查的包与当前工作目录或 `--package` 选择匹配。命令会读取输出目录中的 `package.json`，检查不应出现在发布产物中的本地依赖声明，例如 `workspace:`、`link:`、`file:` 或 `catalog:`；如果输出清单标记为 `private: true`，也会作为发布前问题报告。随后它会打包产物，并执行发布一致性检查，包括 `tarball`、清单文件、注册表基线或内容哈希相关的检查，具体取决于配置和当前产物状态。

`release check` 不执行 `npm publish`，也不替代包管理器或注册表侧校验。它适合在发布命令前作为本地一致性检查运行。

## 排障

| 症状或错误信息                                                                          | 可能原因                                                   | 处理方式                                                                                                |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `no pnpm-workspace.yaml was found`                                                      | 当前目录不在 `pnpm` 工作区内                               | 在工作区内运行命令，或先创建 `pnpm-workspace.yaml`                                                      |
| `Unable to find limina config`                                                          | 未找到支持的 Limina 配置文件                               | 运行 `limina init`，或用 `--config` 指定配置路径                                                        |
| `config file must be inside the governed pnpm workspace`                                | `--config` 指向工作区外文件                                | 把配置文件放到当前 `pnpm` 工作区内                                                                      |
| `checker build --preset requires a config argument`                                     | `--preset` 只能选择某个配置的构建型检查器                  | 改为 `limina checker build <config> --preset tsc`                                                       |
| `checker build --watch requires a config argument`                                      | 监听模式只支持指定配置                                     | 改为 `limina checker build <config> --watch`                                                            |
| `limina build --raw requires --preset`                                                  | 原始模式没有指定检查器预设                                 | 改为 `limina build <config> --raw --preset tsc`                                                         |
| `checker typecheck does not accept --preset` 或 `--watch`                               | `checker typecheck` 只运行非构建型检查器入口               | 对单个配置使用 `checker build <config>`                                                                 |
| `No package checks are enabled`                                                         | 选中的包条目没有启用任何包检查                             | 检查 `package.entries[].checks`，或移除不需要的包检查任务                                               |
| `outDir package.json not found`                                                         | 包产物尚未构建，或 `outDir` 配置不正确                     | 先运行项目构建，再检查 `package.entries[].outDir`                                                       |
| `Missing peer dependency ...`                                                           | 某个检查器或包检查工具未安装                               | 按报告提示安装对应对等依赖，例如 `typescript`、`vue-tsc`、`knip`、`publint` 或 `@arethetypeswrong/core` |
| `limina check --task, --checker, --format, --invocation, and --limit require --issues.` | 把 snapshot 查询选项用于重新检查命令                       | 添加 `--issues`，或移除这些查询选项                                                                     |
| `limina check --issues does not accept a pipeline name.`                                | `--issues` 读取最近快照，不运行流水线                      | 使用 `limina check --issues`，不要加流水线名                                                            |
| `Invalid check --issues --limit ...`                                                    | limit 为零、负数、小数、指数写法、非数字或超出安全整数范围 | 使用十进制正整数或 `all`                                                                                |
| `limina check --issues --limit is only available with --format human.`                  | human 卡片上限与 JSON 或 NDJSON 同时使用                   | 移除 `--limit`，或使用 human 输出                                                                       |
| `Invalid graph export --view`                                                           | `--view` 取值不在支持范围内                                | 使用 `all`、`source` 或 `artifact`                                                                      |
