# 仓库架构

[English](../architecture.md) | [简体中文](./architecture.md)

## Limina 边界

仓库安全／报告与外部工作流边界由[基建记录](./infrastructure.md)负责。Build plugin 的 bundled inventory 是发布资产，与 Limina 管理的 artifact namespace 分开。

私有根包 `@limina/monorepo` 编排命令与共享工具。在这个 monorepo 中，`packages/limina` 承载公开核心包 `limina`，其中 `src`、`bin`、`schemas`、`fixtures` 和 `integration` 保留内部组织。第二个公开包 `limina-migrate` 位于 `packages/migrate`。发布目标仅为两个包生成的 `dist` 目录。迁移包仅将 `limina` 作为 workspace 开发依赖，构建时内联当前源码中需要的核心实现。两产品仍共享发布版本；发布态 migrate 没有 Limina dependency、peer 或 optional dependency，并显式声明自身运行依赖及能力 peers。核心包不反向依赖迁移包。Workspace 包通过 `limina/internal/*` 源码模块消费核心。`flow`、`core`、`utils` 和 `check-reporting` 目录使用通配符映射，其余入口采用显式映射。所有目标直接指向当前 `.ts` 源码文件。单文件入口 `limina/internal/flow` 单独映射到 `src/flow.ts`。这些同次发行入口仅供 workspace 使用；核心发布 hook 删除 `./internal` 及全部 `./internal/` 映射，同时保留正常 workers、公开 API、类型与 schema。Migrate 通过此 export map 解析并内联源码模块，不再依赖 migration 专用聚合入口。仅提供 CLI 的迁移包运行 publint 和运行时边界检查，安装后的 CLI 由 tarball smoke 测试覆盖；主包保留针对 TypeScript API 的 ATTW 检查。开发依赖可以被打包，其清单分类不等于运行时依赖声明。

其他私有 workspace 为 `docs`、`smoke`、`packages/build-tools` 和 `packages/gates`。私有 `@limina/gates` 负责仓库的许可证、提交、隐私、发布与 ESLint 检查；根脚本与配置转调其明确入口，见[仓库门禁](./gates.md)。Fixture 仓库保留独立 workspace 清单和 lockfile，不纳入主 workspace。门禁包先于构建工具通过 TypeScript 自举，不调用 Limina。随后 Rolldown 构建产品，再执行治理与消费者检查。工具链与依赖版本由 [technology-stack](./technology-stack.md) 记录。

根级发布脚本、产品和 build-tools 均通过 dev catalog（`^0.0.4`）消费 registry Logaria，锁定为 0.0.4，不再需要兄弟仓库的 Logaria 构建。包生成器通过 pnpm 解析 catalog，并拒绝不支持的本地协议。

独立迁移包保留既有迁移事务和治理语义。旧 `limina migration` 命令优先转调本地同版本包，否则通过 npm 下载该精确版本。两个包共享版本、发布组和 `limina/v<version>` 标签。证据和独立性门见[迁移状态](./migration.md)，产品不变量见[Limina 架构](./limina.md)。

Vercel 部署 CLI 是既有私有 `docs` workspace 的开发依赖，通过 dev catalog 与冻结 lockfile 解析，不加入双包发布组；见[基建归属记录](./infrastructure.md)。

## 实现内聚与边界

实现按能力及其状态生命周期组织。只服务于该能力的类型、常量与 helper 可以与实现共置；独立文件应具有可理解的职责、稳定接口、适配器／进程边界或真实复用价值。文件长度与调用者数量是审查线索，不独立构成拆分或合并理由。Barrel 不提供边界时，可直接导入包内实现。[ESLint 策略](./gates.md#eslint-结构策略)将这些取舍交给职责审查。

| 区域         | 内聚实现与保留边界                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core 分析    | Build-script 解析、workspace export 展开、source-config collection、Coloring、生成配置 reader、Knip preparation、TypeEvidence 编排、Native 闭包投影和带标签缓存 codec 持有局部 helper。Source-config discovery 与 Coverage 仍独立于成功收集结果。Semantic authority、execution ownership、source ownership、coverage、compilation obligations 与缓存恢复资格仍是不同概念与 owner。框架／编译器适配器和受观察输入 reader 保留边界。 |
| 运行时与展示 | CLI 选项解析、execution setup/run、scheduler readiness、flow-task completion、checker-host pending request、dependency-plan 构造、配置观察诊断和局部 checker 解析与各自 owner 共置。Scheduler settlement、generation control、受管 mutation、输出发布和渲染状态具有不同生命周期。Checker host、renderer 与 migration verifier 进程入口保留 source/bundle 解析和资源归属。                                                          |
| 检查与报告   | Source／graph 阶段编排、dependency graph 的收集／边／模型、内置规则 predicate、ATTW adapter、单个 package entry 运行与单次 check recorder 共置局部操作。Detector 领域、Knip／进程适配器、proof 维度、归档清理和原子报告发布保持独立职责。Dependency graph 文档是观察结果，不是执行计划。                                                                                                                                           |
| 迁移         | 规划、membership 改写、JSONC／配置编辑与每次 invocation 的组执行共置局部状态和 helper。Transaction 入口直接负责 prepared-plan 执行与写入策略分派。声明引用 provenance、语义比较、output adoption、prepare/apply/rollback、新进程验证与审计发布保持不同阶段和 authority。                                                                                                                                                           |
| 仓库工具     | Gates 与 build-tools 保留明确包入口；根脚本继续作为命令／CI 适配器。文档采集、终端解释、回放和可视组件各自保留职责。Smoke 用例仍是安装后消费者边界。                                                                                                                                                                                                                                                                               |

上文的 package imports 与 workspace-only exports 仍是跨包访问合同。共置不扩张公开 exports、不延长缓存生命周期、不把实例状态提升到模块作用域，也不改变初始化、错误、Promise 或释放语义。[架构 workflow](./architecture-workflow.md)负责这些审查；结构验收同时遵循[开发 workflow](./development-workflow.md#验证与交付)。

## 可分发的智能体技能

[`skills/limina`](../../../skills/limina/SKILL.md) 负责可安装的消费者技能，与承载仓库维护流程的 `.agents/skills` 分开。该技能改编自 [docs-islands 的 `1e79a5859ec667e86ceea83fa28c04b9f6bf9ed8`](https://github.com/senaoxi/docs-islands/tree/1e79a5859ec667e86ceea83fa28c04b9f6bf9ed8/skills/limina)；独立许可证保留上游 MIT 声明。这是源码迁移，不表示已经远程安装或发布。

入口保留任务选择和必要边界；五份参考资料分别覆盖配置、CLI 工作流、归属、包检查与诊断。示例以随附源码为依据，在其他项目中操作时则以该项目安装版本的帮助、公开声明、Schema 和对应源码为准。技能不要求消费者拥有 Limina checkout，不强制使用 pnpm，不将内部导入暴露为公开 API，也不授权升级或发布。

命令、配置、检查器支持、根发现、缓存或包行为变化时，随源码 owner 同步维护对应技能参考。保留任务指南定位，不另建完整 Schema 或 issue code 目录。[Init 安装命令](../../../packages/limina/src/commands/init/shared.ts)以及[英文](../../../docs/en/cli.md)、[中文](../../../docs/zh/cli.md) CLI 指南均指向 `senaoxi/limina --skill limina`。既有 [init 测试](../../../packages/limina/src/__tests__/init.spec.ts)覆盖接受安装时的命令及跳过安装时的提示；拒绝提示和安装失败继续使用各自独立的用例。技能迁移改变安装目标，不改变治理身份、关系或缓存生命周期。

## 文档命令输出

首页由 `HomeFeatures.vue` 负责功能导航，`CommandTerminal.vue` 负责命令输出与控件，`use-command-playback.ts` 负责回放状态。组件文件按职责命名；props、data attributes 和样式中的命令选项及索引使用命令术语。英文与中文文案共享同一份 CLI 运行记录。选择其他命令或功能组时，完整输出保持展开，方便读者对照。其阅读区在当前视口下采用固定高度：运行记录的长短不得改变粘性终端的高度并反向触发滚动驱动的功能选择。输出保留实际打印的列布局，窄屏通过横向滚动阅读。

[命令运行记录](../../../docs/.vitepress/theme/command-transcripts.json)由[录制脚本](../../../scripts/docs/capture-command-transcripts.ts)在独立的双包 pnpm workspace 中运行新构建的 CLI 生成。先运行 `pnpm run build`，再运行 `pnpm exec tsx scripts/docs/capture-command-transcripts.ts <new-workspace>`；验证时使用 `~/Project/dev-server-repo/repros/` 下的新目录。录制需要 Python 3 与 POSIX PTY。可选参数指定输出 JSON，以及系统代理包装 pnpm 时使用的明确 pnpm 可执行文件。脚本拒绝已有 workspace 目录，移除父工作区的 bin 设置，为本地依赖生成 lockfile 后运行 `pnpm install --frozen-lockfile --offline`。由 pnpm 创建 workspace 链接与可执行 shim，并保留默认依赖校验。展示与执行的命令是相同的 `pnpm exec limina ...`。记录 JSON 纳入 docs TypeScript 项目。发布流水线从 `packages/core` 运行，其构建生成包／发布检查所需的清单与产物。边界失败使用跨包相对源码导入。

2026-10-03 的记录使用默认交互终端分支：stdout／stderr 共用真实的 100 列、80 行 PTY，设置 `TERM=xterm-256color`，不设置 CI 与颜色覆盖变量。[终端帧提取](../../../scripts/docs/terminal-frames.ts)通过 xterm 解释光标移动、擦除与折行，不将简单去色后的重绘流拼接为日志。间隔不超过 20 ms 的写入合并观察；原始采集保留在录制工作区。屏幕帧裁去外围未使用的视口空白，保留内部空行、缩进、报告边框、诊断和 invocation 查询。回放替换上一屏内容，命令打字后使用记录的帧间隔；完整输出展开区展示终端最终屏幕。界面标明交互式记录及其尺寸。数量、耗时、折行与本地查询路径描述该工作区／该次运行。记录同时保存源码、CLI 与原始输出哈希及工具链版本。CLI 输出变化时须刷新记录；这属于文档契约，不改变产品不变量 I01–I12，也不证明 Windows、其他终端尺寸或部署结果的一致性。

`@xterm/headless` 6.0.0 是仅用于录制的开发依赖，负责解释 VT 终端状态。本地去除转义序列的例程无法保留重绘语义；非正式的本地 VT parser 会增加标准维护负担。2026-10-03 的准入检查发现其 MIT 许可证一致、registry 未标记废弃、6.0.0 为持续维护的 xterm.js 项目的稳定版本，前一周 npm 下载量为 2,001,724，前一月为 6,573,679。其 buffer API 是实验性的，已固定精确版本，升级时须运行终端控制复现并重新采集 CLI 输出。选定的包没有运行时依赖，仅由录制脚本导入，不进入 docs／client 或已发布 CLI 的入口。因此该依赖不适用生产产物体积阈值；记录的屏幕帧数据仍需正常的文档构建与浏览器检查。

## 文档侧栏

文章侧栏通过 [reading.css](../../../docs/.vitepress/theme/styles/reading.css) 适配既有 VitePress 组件，保留 [reading-tokens.css](../../../docs/.vitepress/theme/styles/reading-tokens.css) 中暖色的浅深色配色。选中与普通链接共用行内留白，避免选中时文字偏移；用柔和背景与字重表示选中，用间距分隔分组。导航、折叠、历史记录与移动菜单仍由既有 VitePress 行为负责；这项视觉调整无需增加依赖或另写导航实现。

关闭的移动侧栏设为隐藏，使其控件退出键盘导航。移动链接与折叠控件保留至少 44px 的点击区域。键盘焦点有轮廓线，高对比度选中态使用系统 Highlight 轮廓线，因为单靠背景色无法在该模式保留标识。浏览器验收须覆盖中英文、长标题、断点边缘、滚动、折叠、导航／历史、移动开关、键盘焦点、减少动态效果及高对比度模式；格式、类型检查与文档构建不能证明这些交互结果。
