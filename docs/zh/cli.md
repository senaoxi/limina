# CLI 参考

日常运行 `limina check`。默认检查包含真实的检查器构建，会按需写入 `.limina` 配置、内部声明和缓存；若只需定位图、源码或覆盖问题，可以使用对应的独立检查命令。

首次安装和初始化见[快速开始](./getting-started.md)。包检查与发布检查读取已构建的消费者产物，生产构建、测试和发布仍由项目命令完成。

## 决策表

| 目标                             | 推荐命令                                   | 判断依据                                                                                                             |
| -------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 初始化选定项目中的 Limina 文件   | `limina init` 或 `limina init --yes`       | 首次接入，或需要生成基础配置与 `limina:build` 脚本                                                                   |
| 迁移被治理的源码 `tsconfig`      | `limina-migrate`                           | 规范化配置拓扑，并在新进程中检查写入磁盘后的输入                                                                     |
| 日常检查仓库结构和类型构建入口   | `limina check`                             | 默认组合覆盖工程图、源码、证明和检查器入口                                                                           |
| 自定义一组按顺序运行的检查       | `limina check <name>`                      | `<name>` 来自配置中的 `pipelines`                                                                                    |
| 物化或刷新 `.limina` 检查器文件  | `limina graph prepare`                     | 后续流程需要使用磁盘上的生成文件时                                                                                   |
| 检查项目引用和源码依赖是否一致   | `limina graph check`                       | 关注 `references`、源码导入、包依赖和图规则                                                                          |
| 导出包依赖图 `JSON`              | `limina graph export`                      | 需要把源码依赖或产物依赖交给外部工具处理                                                                             |
| 只检查源码边界和归属             | `limina source check`                      | 关注源码包边界、依赖声明和 `Knip` 支撑的源码使用情况                                                                 |
| 检查源码是否被工程图或检查器覆盖 | `limina proof check`                       | 关注遗漏源码、检查器覆盖和允许清单有效性                                                                             |
| 运行内部声明图构建入口           | `limina checker build`                     | 使用生成图中的构建型检查器入口，只产出 `.limina` 内部声明文件                                                        |
| 对指定配置运行内部声明图构建     | `limina checker build <config>`            | 只接受 Limina 管理的源码配置或聚合配置，不执行原始构建                                                               |
| 构建用户可消费产物               | `limina build <config>`                    | 接受声明 `liminaOptions.outputs` 的受管源码叶子，或递归引用至少一个此类叶子的聚合配置                                |
| 直接构建用户维护的 `tsconfig`    | `limina build <config> --raw --preset tsc` | 不读取 Limina 输出配置，不使用生成图                                                                                 |
| 运行框架检查器负责的叶子配置     | `limina checker typecheck`                 | 对最终由 Astro 或 Svelte 检查器负责的类型配置，每个叶子配置执行一次；无目标时记录 `disabled`（无适用工作）并成功退出 |
| 检查已构建包产物                 | `limina package check`                     | 已有 `package.entries[].outDir`，需要检查清单文件、`publint`、`ATTW` 或产物导入边界                                  |
| 检查发布前产物一致性             | `limina release check`                     | 已构建产物，且需要检查本地依赖声明、私有包、打包结果或配置的发布一致性                                               |

## 命令入口与全局选项

基础格式：

```sh
limina [--config <path>] [--config-loader <loader>] [--mode <mode>] <command>
```

全局选项适用于需要加载 Limina 配置文件的命令。`init` 直接面向选定项目，不依赖已有配置。

| 选项                       | 类型             | 默认行为                                 | 相关配置                    | 示例                                        | 边界                                                                     |
| -------------------------- | ---------------- | ---------------------------------------- | --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| `--config <path>`          | 路径             | 从当前工作目录及祖先目录发现默认配置文件 | Limina 配置模块             | `limina --config ./limina.config.mts check` | 最近的 `package.json` 固定治理根；显式查询的定位锚点可以指向不存在的配置 |
| `--config-loader <loader>` | `native` / `tsx` | `native`                                 | 配置模块加载器              | `limina --config-loader tsx check`          | `tsx` 需要接入工作区安装 `tsx`                                           |
| `--mode <mode>`            | 字符串           | `process.env.NODE_ENV`，否则为 `default` | 函数式配置接收的 `env.mode` | `limina --mode ci check`                    | 只把模式传给配置函数；具体差异由配置文件实现                             |

配置文件可以导出对象、`Promise`，或接收 `{ command, mode }` 的函数。`command` 表示当前命令族，例如 `check`、`graph`、`source`、`package` 或 `release`；它也保留开放字符串类型，以覆盖 `build`、`migration` 等当前命令值。

## 命令参考

### `limina init`

`init` 在选定项目中生成 Limina 的基础接入文件。

```sh
pnpm exec limina init
pnpm exec limina init --yes
```

它从当前工作目录找到最近的 `package.json`，验证后在其旁边写入 `limina.config.mts`。完全没有包清单时，才提供在当前工作目录创建文件的流程；最近清单无效时停止。它不添加工作区声明，无包管理器元信息时 `--yes` 仍能完成。`init` 检查该根的包，写入或更新配置与 `.gitignore`，添加 `limina:build` 脚本及缺失的 Limina/TypeScript 开发依赖，清理根下已有的 `.limina` 生成目录，并可在交互模式下安装智能体技能。

`--yes` 会接受默认确认，并跳过交互式技能安装提示。非交互环境中如果不使用 `--yes`，需要用户确认的步骤会失败。

初始化后，按仓库结构配置图规则和允许的包边界；`init` 不会从业务结构推断这些规则。

需要单独安装初始化流程提供的可选智能体技能时，可运行同一安装命令：

```sh
npx --yes skills add senaoxi/docs-islands --skill limina
```

此步骤安装技能，不改写源码 `tsconfig`；已有源码项目引用需按下一节判断是否迁移。

### `limina-migrate` {#limina-migration}

`limina-migrate` 是独立 CLI 包，与 `limina` 同版本配对发布。它内联所需的核心输入实现，没有主包运行时依赖。本地安装后可执行下面的命令，或使用 `pnpm dlx limina-migrate@<version>`。它支持 `--config`、`--config-loader` 和 `--mode`；配置函数仍收到 `command: 'migration'`。

`export default {}` 这类中立配置只需工具及其必需的 TypeScript 对等依赖即可迁移。配置导入公开 `limina` 时，须在该配置解析依赖的位置安装 Limina；工具不提供或改写这些导入。可选加载器和检查器仍要求受支持的对等依赖。CLI 报告内嵌版本，并从配置及治理根的定位锚点观察项目包版本。项目版本不同或无法确定只是非阻断的元数据提示，不是对目标项目运行时的验收；工具构建版本与自身安装版本不一致会在写入前失败。持久化的 `$schema` 路径仍指向 `node_modules/limina/schemas/tsconfig-schema.json`，主包安装前编辑器可能无法解析它。

`limina migration` 保留为弃用转调入口，优先使用本地同版本包，否则通过 npm 下载该精确版本。帮助仍在本地显示；离线执行需要事先安装匹配的迁移包。命令不会升级项目依赖。

`limina-migrate` 将现有 TypeScript 配置规范化为 Limina 能够从磁盘重新发现和读取的输入。

```sh
pnpm exec limina-migrate
```

命令分别报告处理完成与输入可消费性。架构规则、包依赖、检查器归属和类型错误仍由 `limina check` 检查。迁移不承诺原生 `tsc -b` 行为等价。

#### 配置与关系

只有默认 `tsconfig.json` 能作为检查器入口。具名源码配置通过聚合配置的 `references` 获得检查器归属。独立可读的源码候选也会规范化，但不会创建检查器入口。迁移会移除普通源码配置的 `references`，修剪无效或域外的聚合成员，并保留其余源码的纳管关系。域外引用会被记录，不读取或迁移其目标。

被改写的 `references` 仅含 `path`、且没有实质 Limina 声明时，纯具名聚合包装节点可以展开到所有父节点。路径按每个父文件重定位，包装文件保留。带附加属性的关系需要手动转换。具名包装节点的回边在展开时删除；默认聚合配置环在删除环边后补回源码成员关系，两种改写都保持每个保留聚合配置的源码可达集合。空聚合配置保留聚合角色及显式 `references: []`。

Limina 对比原生配置声明的域内源码关系与独立推导的源码关系。可推导关系不重复写入 `implicitRefs`；源码配置指向聚合配置的声明展开到保留的源码成员，并记录原目标与展开结果；检查器映射和声明项目的合法性留给核心分析。其余原生声明转为 `implicitRefs` 中的显式引用，已有用户的 `reason` 保留。语义分析不完整或失败时报告无法完成比较，不将其视为空推导图。源码缺失或尚未生成，不会使可读配置成为隔离目标。

无法解析的配置（包括空文件或格式损坏的 JSONC）保留在磁盘上。能安全隔离时，迁移写入 `kind: 'tsconfig'` 的精确 `regions.exclude`，并移除指向它的成员关系或隐式引用，包仍保持激活。不会删除 `extends` 路径。单个隐式引用对象可以包装成数组；缺失或空白的 `reason` 会补入事实性的迁移说明。无法规范化的非法结构会被隔离，或报告未完成。

排除项自动编辑支持直接导出的对象、调用已导入 `defineConfig` 的对象，以及可唯一追踪的不可变 `const` 对象，并要求治理区域与排除项数组可以静态编辑。函数、`Promise`、展开语法和动态组合保持原样。必要排除无法落盘时，接入仍未完成。没有安全输入基线的既有输出可见性环也需要修正；迁移不会排除正常源码来制造成功结果。

#### 可选输出接入 {#可选-outputs-接入}

源码编译器选项（包括构建字段和继承路径）保持原样。已有合法 `liminaOptions.outputs`（包括 `{}`）继续作为用户的显式契约。

| 没有显式输出时的既有配置                                                       | 自动输出接入                         |
| ------------------------------------------------------------------------------ | ------------------------------------ |
| 有效 `noEmit: true`，包括继承结果                                              | 不创建                               |
| 有效配置未关闭输出且存在 `outDir`                                              | 先提出候选，再检查完整候选拓扑       |
| 只有 `rootDir`、`target`、声明输出标志或 `noEmit: false`                       | 不创建                               |
| 仅输出声明、声明与 JavaScript 目录分离、只有 `declarationDir` 或存在 `outFile` | 不创建；保留原生选项并记录未承接行为 |
| 聚合配置                                                                       | 不创建                               |

每个可选候选必须通过输出路径和写入权限检查、稳定的配置描述符发现，以及入口和源码闭包保留检查。候选按配置路径稳定排序后各尝试一次。隐藏声明者自身的输出，或能够稳定下来但隐藏其他正常源码的输出，都会被拒绝，不会因此隔离这些源码。拒绝不会取消其他源码转换或独立安全输出。迁移不会把继承的源码 `target` 重复写入输出配置，也不会删除已有输出文件。

#### 写入与结果

每个写入目标必须属于 Git 工作树。所有补丁和输入快照都在写入前准备；存在未提交修改的工作树需要一次交互确认，默认选择否。需要确认的非交互运行会在写入前停止。批准不会提交或储藏用户变更，也不会丢弃它们。

JSONC 编辑保留无关文本、注释和换行符。受管字段存在重复键等歧义时，保留该目标并报告，独立目标继续。文件系统预检检查规范路径范围、普通文件、可写性、物理别名及身份漂移。单链接文件使用原子替换。硬链接文件需要统一选择：通过现有 inode 原地改写、跳过相关一致性组，或取消。原地写入保持别名关系，但不具备原子性，所有别名都会观察到变化。

同一聚合配置环的修改，以及共享必要持久化排除项的修改，组成一致性组。可恢复失败会恢复该组，然后继续独立组。文件系统状态不确定时停止并保留恢复证据。迁移没有跨进程写租约，写入开始后也不会重新执行语义规划。

新进程会通过同次发行 Limina 源码内嵌的正常 `check` 和 `graph` 输入读取路径加载实际配置。成功表示该内嵌实现消费了磁盘输入，不表示执行了完整类型检查、图治理或项目安装版 Limina 运行时。只有重新读取成功、必要写入完成、源码纳管关系保留且仍有可治理源码时，才允许报告接入成功。必要写入失败、残留结构性错误或无法验证会返回非零。单独拒绝可选输出不要求失败。

终端摘要包含隔离、域外引用删除、比较完整性、诊断及失败／跳过组数量与审计路径。规划阶段和输出候选计数显示进度。审计报告位于 `.limina/migration/latest.json`，包含目标、隔离、修剪关系、比较完整性、输出决策、写入、最终验证、阶段耗时，以及报告位置仍可写时的致命失败尝试。报告发布失败会警告，不撤销已经写入的配置。核心和后续迁移都不将报告作为输入事实来源。

迁移不会安装框架依赖、运行 `astro sync` 或改写框架源码。生成图继续使用版本 5 的清单，不持久化迁移就绪信息或部分图状态。

### `limina check [pipeline]`

`check` 是日常入口。它检查结构并运行类型检查器；其中 `checker:build` 写出内部声明，不负责生产打包。

`limina check [pipeline] --force` 忽略已有的 Limina 持久化分析缓存，执行冷分析，并以本次具备持久化资格的结果刷新缓存。修复安装状态，或进行可能保留或回退文件时间戳的操作后，可以使用它。checker 的 `.tsbuildinfo` 等独立构建缓存仍遵守自身行为。持久化原生事实复用目前面向 TypeScript 6.0.3，尚未证明的框架或自定义 provider 语境重新分析。该参数不能与仅查询既有结果的 `--issues` 合用。

持久化分析缓存默认启用。[`cache: false`](./config/config-file.md#cache) 同时关闭恢复和发布，`--force` 也不能重新开启；已有 snapshot、配置漂移保护、issues 记录及 checker 缓存保持正常行为。`--force` 可以读取旧 snapshot 字节以安全地进行并发发布，但不恢复旧分析模型，也不删除本配置、其他配置或其他 worktree 的 snapshot。

```sh
pnpm exec limina check
pnpm exec limina check ci
pnpm exec limina check --force
pnpm exec limina check ci --force
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

`limina graph check` 调度内置命令；`limina check graph` 只选择 `pipelines.graph`。命名工作流接受下方已声明的 Limina 选项，但拒绝额外的位置参数、未知选项和 `--` 透传。所有选项都归 Limina 所有；下游命令输入由[流水线配置](./config/pipelines.md)定义。

常用选项：

| 选项                   | 类型                      | 默认行为           | 示例                                                          | 边界                                              |
| ---------------------- | ------------------------- | ------------------ | ------------------------------------------------------------- | ------------------------------------------------- |
| `-p, --package <name>` | 可重复字符串              | 不限制包           | `limina check -p @scope/pkg`                                  | 包输出选择及源码报告筛选，见下文                  |
| `--verbose`            | 布尔值                    | 输出精简摘要       | `limina check --verbose`                                      | 扩展实时运行摘要；配合 `--issues` 时输出详细卡片  |
| `--rule <code>`        | 可重复字符串              | 不按规则过滤       | `limina check --issues --rule LIMINA_GRAPH_REFERENCE_MISSING` | 作为问题查询时需要配合 `--issues`                 |
| `--file <path>`        | 可重复路径                | 不按文件过滤       | `limina check --issues --file packages/a/src/index.ts`        | 匹配精确文件路径                                  |
| `--scope <glob>`       | 可重复路径或通配模式      | 不按路径范围过滤   | `limina check --issues --scope 'packages/a/**'`               | 只匹配带路径的问题候选                            |
| `--task <name>`        | 可重复字符串              | 不按任务过滤       | `limina check --issues --task source:check`                   | 必须配合 `--issues`                               |
| `--checker <name>`     | 可重复字符串              | 不按检查器过滤     | `limina check --issues --checker vue-tsc`                     | 这里只用于问题快照过滤，不是构建检查器选择        |
| `--issues`             | 布尔值                    | 运行配置的检查     | `limina check --issues`                                       | 要求可读取的最新问题清单；不能与流水线名同时使用  |
| `--limit <limit>`      | 正整数或 `all`            | 显示 20 张问题卡片 | `limina check --issues --limit 50`                            | 只用于人类可读格式的问题清单；必须配合 `--issues` |
| `--invocation <uuid>`  | UUID                      | 读取最近检查       | `limina check --issues --invocation <uuid>`                   | 读取一条不可变的独立调用失败记录                  |
| `--format <format>`    | `human`、`json`、`ndjson` | `human`            | `limina check --issues --format json`                         | 必须配合 `--issues`                               |

运行时的 `--package` 传给 `package:check` / `release:check` 选择输出条目，并用于 `source:check` 的问题报告筛选；它不会把图检查、覆盖证明或检查器构建裁剪成单包任务。配合 `--issues` 时，`--package` 只是过滤已保存的问题。`--task` 也只用于问题查询，不能用它选择本次执行的任务。

命令结束后还应查看[任务与分析器状态](./built-in-tasks.md#任务状态)。例如没有框架目标时 `checker:typecheck` 为 `disabled`；可选包分析器缺失可能为 `skipped`，同时进程正常退出。这些情况都不代表该项检查实际通过。

#### 查询已有问题

```sh
pnpm exec limina check --issues
pnpm exec limina check --issues --task workspace:validate
pnpm exec limina check --issues --verbose --limit all
pnpm exec limina check --issues --format json
```

`--issues` 不会重新运行检查。不带 `--invocation` 时，它会按最新已发布的 `limina check` 检查尝试验证问题清单。新尝试正在运行或已中断时，以前完成的 `last-run.json` 可能仍留在磁盘上，但查询不会把它作为当前结果返回。独立命令使用各自的调用记录。工作区验证失败也可以记录：可信的 `.limina` 快照命名空间在验证前创建，因此结构性失败可出现在 `workspace:validate` 任务下。首次读取检查问题清单前，先让一次 `limina check` 完成。

若本次错误发生在配置发现、加载或执行计划建立阶段，检查尝试可能尚未登记，查询仍可能返回上一次完成记录。请先对照记录时间与本次终端错误；“当前结果不可用”也不等于“零问题”。

::: details 最新尝试、快照版本与恢复

不带 `--invocation` 的查询会验证结果是否属于最新检查尝试。检查尝试一旦发布，只有同一次尝试已完成，且元数据与版本 8 的快照一致时，`--issues` 才会返回问题清单。最新尝试处于 `running`（正在运行）、`interrupted`（已中断）、`aborted`（已终止）或 `persistence-failed`（持久化失败）状态，或者结果时效元数据损坏或不匹配时，查询会拒绝返回问题并以退出码 `1` 结束，不会回退到更早已完成的结果。必要元数据缺失时同样失败；只有 `latest-attempt` 与 `latest-completed` 元数据都不存在时，读取器才使用兼容旧快照的路径。人类可读格式（`human`）、JSON 与 NDJSON 输出会明确报告不可用状态；机器响应中表示不可用的 `status` 与零问题数不表示检查成功且没有问题。

在检查尝试发布前发生的配置发现、配置验证或执行计划失败，不会替换上一份已完成的问题清单。如果进程恰好在写入 `last-run.json` 与结果时效索引之间退出，后续序号更高的成功检查会完整覆盖这两个文件，并自动恢复查询。

:::

问题输出分为四档：

| 视图 | 触发方式                                                                       | 输出内容                                                                                         | 可见问题上限 |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------ |
| 摘要 | `limina check --issues`，且没有过滤条件、调用选择或显式上限                    | 基于完整过滤结果的计数、主要阻塞项和后续命令；不输出问题卡片                                     | 不输出卡片   |
| 精简 | 添加任务、规则、包、文件、范围或检查器过滤条件；选择调用记录；或传入 `--limit` | 每个选中问题一张固定结构卡片，只显示一个位置、规则、可选归属或工具，以及单行摘要、原因或修复说明 | 默认 20      |
| 详细 | 在问题查询中加入 `--verbose`                                                   | 显示选中问题的全部位置、证据、外部诊断、修复步骤、验证命令和去重后的原始详情                     | 默认 20      |
| 机器 | 使用 `--format json` 或 `--format ndjson`                                      | 按既有机器契约输出完整过滤结果                                                                   | 永不截断     |

人类可读摘要中的计数和主要阻塞项始终基于完整过滤结果。精简与详细卡片采用确定性采样：Limina 会先让互不相关的根因都有展示机会，再从同一根因取第二个样本；同一根因内部则轮换不同包。报告会显示 `Showing X of Y issues`。使用 `--limit <正整数>` 指定精确卡片预算，使用 `--limit all` 显示全部匹配卡片。零匹配时仍保留摘要、过滤条件诊断和帮助命令，但不会输出空卡片区。

`--limit` 只能用于 `check --issues` 的人类可读格式（`human`）。JSON 与 NDJSON 会拒绝该选项，并始终返回全部过滤结果；`--verbose` 不改变机器输出。`limina check --verbose` 与 `limina check --issues --verbose` 的作用不同：前者扩展运行级聚合行、耗时、规则、阻塞项和包计数，但不会输出原始问题诊断；后者选择详细问题卡片视图。

配置加载并注册独立调用会话后，如果失败产生了问题且记录成功发布，Limina 会打印调用 ID 和适用于当前命令行环境的查询。会话建立前的失败或持久化失败不保证存在这份记录。查询使用当前绝对 Node 路径与已安装 Limina 的 `bin/limina.js`，携带绝对配置路径、实际加载器和运行模式，并选择 `check --issues --invocation <uuid>`。Windows 命令还通过 PowerShell `Set-Location -LiteralPath` 切换到治理根。查询可从其他目录回放，无需检测项目包管理器。记录保存在该治理根的 `.limina/check/invocations/`。

查询的显式 `--config` 是按词法路径定位的锚点：模块可以已经删除或重命名，它最近的包清单仍须存在且为合法对象。查询不导入配置、不解析包管理器适配器、不重新构建包集合、不执行预检。未给出 `--config` 时，需要发现当前默认配置。缺少记录不会回退到祖先工作区。

在 POSIX 系统上，命令标签为 `Query:`。在 Windows 上，Limina 输出适用于 Windows PowerShell 5.1 或 PowerShell 7 的 `PowerShell:` 命令；即使从 CMD 启动 Limina，也应在 PowerShell 中执行这条命令。Limina 不再输出 CMD 版本的命令。可以在打印的命令后追加 `--format json` 或 `--file src/index.ts` 等查询选项。

调用记录用于选择查询对象，不是问题过滤条件，因此默认人类可读视图会进入精简档。人类可读输出的标题会显示调用 ID、调用种类、结果和完成时间。生成的细化、详细、完整、JSON 与过滤帮助命令会保留同一个调用 ID、当前全部过滤条件和显式全局配置上下文。记录中的原始命令只作为元数据显示，不会用于拼接新查询。

`--file` 做精确匹配，`--scope` 接受目录或通配模式。两者都接受工作区相对路径、`./` 路径、绝对路径以及两种斜杠形式。它们只匹配问题文件、包清单等带路径的候选；配置字段范围等诊断标签不会被当作路径。同一过滤项重复传入时，只需匹配其中任一项。

检查快照使用版本 8，读取器只接受该版本。

辅助查询：

```sh
pnpm exec limina check --issues --task --help
pnpm exec limina check --issues --package --help
pnpm exec limina check --issues --checker --help
pnpm exec limina check --issues --rule --help
```

所选问题清单可读取时，任务过滤帮助列出全部静态公开检查任务，并合并快照中出现的任务，包括问题数为零的情况。兼容旧快照的读取路径在没有快照时也保留静态任务过滤帮助。最新尝试的元数据不可用时，任务、包和检查器过滤帮助不会提供旧问题清单的值。包与检查器值来自所选快照；规则过滤帮助使用静态公开规则注册表。

### `limina graph <action>`

`graph` 命令负责生成、检查和导出工程图。

```sh
pnpm exec limina graph prepare
pnpm exec limina graph check
pnpm exec limina graph export
pnpm exec limina graph export --view source --output graph.json
```

`graph prepare` 验证输入并生成 `.limina` 下的工程图与检查器入口，不运行图治理检查或编译器。受管构建和类型检查会自动物化所需文件；需要单独查看或刷新磁盘文件时再运行它。`graph check`、`source check` 和 `proof check` 在内存中计算图，不物化检查器配置。

`graph check` 检查生成图与源码事实是否一致。它覆盖项目引用、源码图路由、条件域、引用完整性、图规则、工作区包依赖声明和部分解析边界。典型问题包括：源码导入对应的项目引用缺失；项目引用多余；跨包项目引用缺少依赖声明；图规则拒绝访问；工作区导入无法解析或目标不在工程图中。

`graph export` 输出包级依赖图 `JSON`。`--view` 可取 `all`、`source` 或 `artifact`，默认是 `all`。不传 `--output` 时输出到标准输出；传入 `--output <path>` 时写入文件。导出的图可供外部分析使用；它记录包级依赖事实，不定义任务顺序，尤其不能根据产物边推断生产构建计划。

### `limina source check`

`source check` 聚焦源码归属和源码包边界。

```sh
pnpm exec limina source check
pnpm exec limina source check --package @scope/pkg
pnpm exec limina source check --scope 'packages/app/**' --verbose
```

`limina source check --scope` 还接受相对于所选源码归属方的范围。例如，源码归属方位于 `packages/app` 时，`src/theme` 可以匹配 `packages/app/src/theme`；工作区相对路径、绝对路径和通配模式也继续有效。

它检查源码文件是否属于工作区源码归属方，非聚合型 `tsconfig` 是否混合多个源码归属方，普通相对导入是否越过最近的 `package.json` 包边界，裸包导入是否由最近的源码归属方或显式规则授权，`#...` 包导入是否保持在声明包范围内，以及 `Knip` 支撑的源码使用情况。

`Knip` 相关检查依赖 `knip` 这个对等依赖，只有在 `source.knip` 明确写为 `true` 或拥有 `root` 或 `workspaces` 的对象时才运行。省略 `source.knip` 或写为 `false` 会关闭这部分源码使用检查，但不会关闭图检查、覆盖证明检查或检查器执行。启用后缺少 `knip` 对等依赖，会在源码分析开始前让 `source check` 失败。

`source check` 报告源码归属、包边界和依赖声明问题，支持过滤查询。ESLint、测试和运行时检查仍需单独运行。

### `limina proof check`

`proof check` 用于检查源码覆盖关系。

```sh
pnpm exec limina proof check
pnpm exec limina proof check --verbose
```

它基于生成工程图、检查器入口、项目路由、源码边界和 `proof.allowlist`，检查源码文件是否被工程图或检查器覆盖，并报告检查器覆盖目标、默认 `tsconfig`、声明配置、本地配套配置或允许清单相关的问题。它还会验证配置归属唯一性、聚合配置一致性、框架叶子配置可执行性、目标覆盖、声明提供者投影与带类型标记的依赖边完整性。

覆盖结论针对 Limina 受治理的源码集合及其图或检查器入口，不表示已经证明完整类型安全。

### `limina build <config>`

`build` 构建用户可消费产物。托管模式只接受 Limina 管理的配置：源码叶子必须声明 `liminaOptions.outputs`；聚合配置下递归引用的源码叶子至少要有一个声明了 `liminaOptions.outputs`。

```sh
pnpm exec limina build packages/app/tsconfig.json
pnpm exec limina build packages/app/tsconfig.json --preset tsc
pnpm exec limina build packages/app/tsconfig.json --watch
pnpm exec limina build packages/app/tsconfig.raw.json --raw --preset vue-tsc
```

托管模式会生成并运行 `.limina/tsconfig/checkers/<checker>/outputs/` 下的输出构建配置。所选目标还可沿生成的依赖边，加入具有输出构建映射的可构建产物提供方，包括由其他检查器负责的产物提供方；这不表示构建全部工作区依赖。多个构建型检查器同时匹配所选目标时，必须传 `--preset`。`--watch` 使用所选检查器适配器的监听能力；不支持时明确失败。

托管构建在非 `watch` 模式成功后，还会补充 TypeScript 输出：把输出 `rootDir` 内的本地声明输入（`.d.ts`、`.d.cts`、`.d.mts`）按相对路径复制到 `outDir`。位于 `rootDir` 外或依赖包中的声明不会被复制；需要时把声明移入 `rootDir`、扩大 `liminaOptions.outputs.rootDir`，或添加显式复制步骤。

`--raw` 用于直接运行 `tsc`、`tsgo` 或 `vue-tsc` 构建用户维护的 `tsconfig`。原始模式必须传 `--preset`，不会准备生成图，不读取 `liminaOptions.outputs`，不使用 Limina 推断引用，并拒绝 `.limina` 下的生成配置。

### `limina checker build [config]`

`checker build` 只构建 Limina 内部声明图。支持的构建检查器标识是 `tsc`、`tsgo` 和 `vue-tsc`；命令行选择选项仍名为 `--preset`。

```sh
pnpm exec limina checker build
pnpm exec limina checker build packages/app/tsconfig.json
pnpm exec limina checker build packages/app/tsconfig.json --preset tsc
pnpm exec limina checker build packages/app/tsconfig.json --preset vue-tsc --watch
```

不带 `config` 时，命令使用生成工程图中的所有构建型检查器入口。带 `config` 时，Limina 只解析已管理配置对应的内部声明目标；如果配置不由 Limina 管理，会立即失败。该命令不读取 `liminaOptions.outputs`，不会生成 `dist` 等用户产物，也不会对用户维护的 `tsconfig` 执行原始构建。

`--watch` 只允许和配置路径一起使用。`--preset` 也需要配置路径。

这个命令仍然依赖对应检查器包。缺少对等依赖时，报告会提示需要安装的包，例如 `typescript`、`vue-tsc` 或 `@typescript/native-preview`。

### `limina checker typecheck`

`checker typecheck` 直接运行最终由 Astro 或 Svelte 检查器负责的类型配置，并按规范化的叶子配置路径去重。

```sh
pnpm exec limina checker typecheck
pnpm exec limina checker typecheck --verbose
```

该命令消费 `graph prepare` 生成的归属计划。聚合配置由 Limina 递归展开；正确性不依赖外部框架检查器是否支持递归 TypeScript 项目引用。

自动发现的 Astro 目标执行 `astro check --noSync --root <leaf> --tsconfig <source-config>`，要求叶子包内存在 `astro`、`@astrojs/check`、`typescript` 和 `.astro/types.d.ts`。自动发现的 Svelte 目标执行 `svelte-check --workspace <leaf> --tsconfig <source-config>`，要求叶子包安装 `svelte-check`、`svelte2tsx`、`svelte` 和 `typescript`。Limina 不会运行 `astro sync`，也不会启用 Svelte 增量缓存行为。

`checker typecheck` 不接受配置路径、`--preset` 或 `--watch`。框架目标不支持监听；源码配置、解析器包、框架生成类型或框架源码变化后，需要重新运行命令。执行器返回无目标的 `disabled`（无适用工作）结果前，仍会执行工作区验证和生成产物物化，并取得校验修订版本的读租约。如果没有框架检查器负责的叶子配置，执行器会记录 `disabled` 并正常退出，不执行检查器对等依赖预检或检查器。

### `limina package check`

`package check` 检查已构建的包输出。

```sh
pnpm exec limina package check
pnpm exec limina package check --package @scope/pkg
pnpm exec limina package check --package @scope/pkg --tool publint
pnpm exec limina package check --tool attw --attw-profile strict
```

它读取配置中的 `package.entries`，进入每个条目的 `outDir`，读取已构建产物中的 `package.json`。如果启用了 `publint` 或 `attw`，会先把输出目录打成临时打包文件再交给对应工具检查；如果启用了 `boundary`，会扫描输出目录中的 `JavaScript` 文件，检查外部包导入、自引用导入和 `Node` 内置模块使用是否符合产物清单与配置。

`--tool` 可取 `all`、`publint`、`attw` 或 `boundary`，用于筛选每个条目配置中已启用的工具，不能重新启用被关闭的工具。筛选后没有条目启用检查时，命令失败。`--attw-profile` 可取 `strict`、`node16` 或 `esm-only`，在本次调用中覆盖配置的检查档位；默认值是 `esm-only`。

`package check` 不运行构建，不发布包，也不保证产物可在所有消费环境中工作。它只根据配置和已构建产物报告可证明的问题。

### `limina release check`

`release check` 检查发布前的包产物一致性。

```sh
pnpm exec limina release check
pnpm exec limina release check --package @scope/pkg
pnpm exec limina release check --package @scope/pkg --verbose
```

它同样基于 `package.entries` 选择产物目录，并要求被检查的包与当前工作目录或 `--package` 选择匹配。命令会读取输出目录中的 `package.json`，检查不应出现在发布产物中的本地依赖声明，例如 `workspace:`、`link:`、`file:` 或 `catalog:`；如果输出清单标记为 `private: true`，也会作为发布前问题报告。随后它会打包产物，并执行发布一致性检查，包括打包文件、清单文件、注册表基线或内容哈希相关的检查，具体取决于配置和当前产物状态。启用 `release.npmPackageJsonLint` 后，还会使用工作区另行安装的 `npm-package-json-lint` 检查打包清单。

`release check` 不执行 `npm publish`，也不替代包管理器或注册表侧校验。它适合在发布命令前作为本地一致性检查运行。

包检查与发布检查使用 `pnpm pack --ignore-scripts` 打包配置的输出目录，因此需要可用的 pnpm，不受项目声明的包管理器或单包、工作区分类影响。检查结果针对这份 pnpm 打包产物；其他包管理器可能产生不同内容。名称、版本、输出文件及可选工具要求适用于所选产物和检查。

## 排障

不确定从哪里排查时，先读[故障排查](./troubleshooting.md#先定位失败任务)。下表第一列保留程序实际输出的英文诊断片段，便于检索；可能原因和处理方式使用中文说明。

| 症状或错误信息                                                                          | 可能原因                                                       | 处理方式                                                                            |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `No package.json found`                                                                 | 所选配置上方没有包清单                                         | 添加包清单，或选择预期配置                                                          |
| `Unable to find limina config`                                                          | 未找到支持的 Limina 配置文件                                   | 运行 `limina init`，或用 `--config` 指定配置路径                                    |
| `Invalid package.json object` / `Unable to read root package.json`                      | 最近的包清单无效                                               | 修复该文件；祖先清单不能替代它                                                      |
| `checker build --preset requires a config argument`                                     | `--preset` 只能选择某个配置的构建型检查器                      | 改为 `limina checker build <config> --preset tsc`                                   |
| `checker build --watch requires a config argument`                                      | 监听模式只支持指定配置                                         | 改为 `limina checker build <config> --watch`                                        |
| `limina build --raw requires --preset`                                                  | 原始模式没有指定检查器预设                                     | 改为 `limina build <config> --raw --preset tsc`                                     |
| `checker typecheck does not accept --preset` 或 `--watch`                               | 类型检查会运行完整的框架叶子目标集合，不支持逐目标框架监听     | 源码配置、解析器包、框架生成类型或框架源码变化后，重新运行 `checker typecheck`      |
| `No package checks are enabled`                                                         | 选中的包条目没有启用任何包检查                                 | 检查 `package.entries[].checks`，或移除不需要的包检查任务                           |
| `outDir package.json not found`                                                         | 包产物尚未构建，或 `outDir` 配置不正确                         | 先运行项目构建，再检查 `package.entries[].outDir`                                   |
| `Missing Limina runtime dependency`                                                     | Limina 所需的运行时依赖不可用或版本越界                        | 在运行 Limina 的工作区安装或调整                                                    |
| `Missing external checker`                                                              | 配置的外部检查器在执行作用域中不可用                           | 在报告的检查器作用域安装                                                            |
| `Unsupported external checker`                                                          | 外部检查器版本超出 Limina 支持范围                             | 在报告的检查器作用域升级或降级                                                      |
| `Missing Astro semantic toolchain dependency`                                           | 符合分析条件的 Astro 源码导入无法解析其所属作用域声明的依赖    | 在所属叶子包安装或重装受支持的 Astro 检查工具链；不要依赖未声明的工作区根副本       |
| `Unsupported Astro semantic toolchain`                                                  | 所属作用域的 Astro 检查工具版本组合或内部 API 形态不受支持     | 按文档对齐所属叶子包的版本组合；pnpm 存储目录或依赖提升后的物理路径无需相同         |
| `Unsupported vue-tsc toolchain`                                                         | `vue-tsc` 安装的内部版本组合不完整或不兼容                     | 升级、降级或重装 `vue-tsc`，不要为 Limina 单独安装内部包                            |
| `Missing framework checker dependencies`                                                | 叶子框架目标缺少命令或执行所需的运行时依赖                     | 在所属叶子包安装报告的 Astro 或 Svelte 依赖                                         |
| `Astro generated types are missing`                                                     | 叶子包尚未生成 `.astro/types.d.ts`                             | 运行 `pnpm --dir <leaf> exec astro sync`；Limina 不会自动执行该命令                 |
| `publint is not installed; skipping check` 或 `attw is not installed; skipping check`   | 已启用的可选包检查分析器未安装                                 | 持续集成要求这类覆盖时应安装对应分析器；单独发生跳过不会让命令以非零状态退出        |
| `Missing Limina runtime dependency:`（`package: knip`）                                 | 已明确启用的 Knip 源码使用功能缺少 Limina 所需的运行时依赖     | 在运行 Limina 的工作区安装 `knip`，或将 `source.knip` 设为 `false`/省略以关闭该功能 |
| `limina check --task, --checker, --format, --invocation, and --limit require --issues.` | 把快照查询选项用于重新检查命令                                 | 添加 `--issues`，或移除这些查询选项                                                 |
| `limina check --issues does not accept a pipeline name.`                                | `--issues` 读取最近快照，不运行流水线                          | 使用 `limina check --issues`，不要加流水线名                                        |
| `Invalid check --issues --limit ...`                                                    | `--limit` 为零、负数、小数、指数写法、非数字或超出安全整数范围 | 使用十进制正整数或 `all`                                                            |
| `limina check --issues --limit is only available with --format human.`                  | 人类可读格式的卡片上限与 JSON 或 NDJSON 同时使用               | 移除 `--limit`，或使用 `human` 输出                                                 |
| `Invalid graph export --view`                                                           | `--view` 取值不在支持范围内                                    | 使用 `all`、`source` 或 `artifact`                                                  |
