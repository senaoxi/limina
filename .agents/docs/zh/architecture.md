# 仓库架构

[English](../architecture.md) | [简体中文](./architecture.md)

## Limina 边界

仓库安全／报告与外部工作流边界由[基建记录](./infrastructure.md)负责。Build plugin 的 bundled inventory 是发布资产，与 Limina 管理的 artifact namespace 分开。

私有根包 `@limina/monorepo` 编排命令与共享工具。在这个 monorepo 中，`packages/limina` 承载公开核心包 `limina`，其中 `src`、`bin`、`schemas`、`fixtures` 和 `integration` 保留内部组织。第二个公开包 `limina-migrate` 位于 `packages/migrate`。发布目标仅为两个包生成的 `dist` 目录。迁移包仅将 `limina` 作为 workspace 开发依赖，构建时内联当前源码中需要的核心实现。两产品仍共享发布版本；发布态 migrate 没有 Limina dependency、peer 或 optional dependency，并显式声明自身运行依赖及能力 peers。核心包不反向依赖迁移包。Workspace 包通过 `limina/internal/*` 源码模块消费核心。`flow`、`core`、`utils` 和 `check-reporting` 目录使用通配符映射，其余入口采用显式映射。所有目标直接指向当前 `.ts` 源码文件。单文件入口 `limina/internal/flow` 单独映射到 `src/flow.ts`。这些同次发行入口仅供 workspace 使用；核心发布 hook 删除 `./internal` 及全部 `./internal/` 映射，同时保留正常 workers、公开 API、类型与 schema。Migrate 通过此 export map 解析并内联源码模块，不再依赖 migration 专用聚合入口。仅提供 CLI 的迁移包运行 publint 和运行时边界检查，安装后的 CLI 由 tarball smoke 测试覆盖；主包保留针对 TypeScript API 的 ATTW 检查。开发依赖可以被打包，其清单分类不等于运行时依赖声明。

其他私有 workspace 为 `docs`、`smoke`、`packages/build-tools` 和 `packages/eslint-config`。根级 `scripts` 负责发布工具。Fixture 仓库保留独立 workspace 清单和 lockfile，不纳入主 workspace。构建工具和 ESLint 规则通过 TypeScript 自举，不调用 Limina。随后 Rolldown 构建产品，再执行治理与消费者检查。工具链与依赖版本由 [technology-stack](./technology-stack.md) 记录。

根级发布脚本、产品和 build-tools 均通过 dev catalog（`^0.0.4`）消费 registry Logaria，锁定为 0.0.4，不再需要兄弟仓库的 Logaria 构建。包生成器通过 pnpm 解析 catalog，并拒绝不支持的本地协议；临时 Logaria link 例外已移除。

独立迁移包保留既有迁移事务和治理语义。旧 `limina migration` 命令优先转调本地同版本包，否则通过 npm 下载该精确版本。两个包共享版本、发布组和 `limina/v<version>` 标签。证据和独立性门见[迁移状态](./migration.md)，产品不变量见[Limina 架构](./limina.md)。

Vercel 部署 CLI 是既有私有 `docs` workspace 的开发依赖，通过 dev catalog 与冻结 lockfile 解析，不加入双包发布组；见[基建归属记录](./infrastructure.md)。

## 文档命令输出

首页由 `HomeFeatures.vue` 负责功能导航，`CommandTerminal.vue` 负责命令输出与控件，`use-command-playback.ts` 负责回放状态。组件文件按职责命名；props、data attributes 和样式中的命令选项及索引使用命令术语。英文与中文文案共享同一份 CLI 运行记录。选择其他命令或功能组时，完整输出保持展开，方便读者对照。其阅读区在当前视口下采用固定高度：运行记录的长短不得改变粘性终端的高度并反向触发滚动驱动的功能选择。输出保留实际打印的列布局，窄屏通过横向滚动阅读。

[命令运行记录](../../../docs/.vitepress/theme/command-transcripts.json)由[录制脚本](../../../scripts/docs/capture-command-transcripts.ts)在独立的双包 pnpm workspace 中运行新构建的 CLI 生成。先运行 `pnpm run build`，再运行 `pnpm exec tsx scripts/docs/capture-command-transcripts.ts <new-workspace>`；验证时使用 `~/Project/dev-server-repo/repros/` 下的新目录。录制需要 Python 3 与 POSIX PTY。可选参数指定输出 JSON，以及系统代理包装 pnpm 时使用的明确 pnpm 可执行文件。脚本拒绝已有 workspace 目录，移除父工作区的 bin 设置，为本地依赖生成 lockfile 后运行 `pnpm install --frozen-lockfile --offline`。由 pnpm 创建 workspace 链接与可执行 shim，并保留默认依赖校验。展示与执行的命令是相同的 `pnpm exec limina ...`。记录 JSON 纳入 docs TypeScript 项目。发布流水线从 `packages/core` 运行，其构建生成包／发布检查所需的清单与产物。边界失败使用跨包相对源码导入。

2026-10-03 的记录使用默认交互终端分支：stdout／stderr 共用真实的 100 列、80 行 PTY，设置 `TERM=xterm-256color`，不设置 CI 与颜色覆盖变量。[终端帧提取](../../../scripts/docs/terminal-frames.ts)通过 xterm 解释光标移动、擦除与折行，不将简单去色后的重绘流拼接为日志。间隔不超过 20 ms 的写入合并观察；原始采集保留在录制工作区。屏幕帧裁去外围未使用的视口空白，保留内部空行、缩进、报告边框、诊断和 invocation 查询。回放替换上一屏内容，命令打字后使用记录的帧间隔；完整输出展开区展示终端最终屏幕。界面标明交互式记录及其尺寸。数量、耗时、折行与本地查询路径描述该工作区／该次运行。记录同时保存源码、CLI 与原始输出哈希及工具链版本。CLI 输出变化时须刷新记录；这属于文档契约，不改变产品不变量 I01–I12，也不证明 Windows、其他终端尺寸或部署结果的一致性。

`@xterm/headless` 6.0.0 是仅用于录制的开发依赖，负责解释 VT 终端状态。本地去除转义序列的例程无法保留重绘语义；非正式的本地 VT parser 会增加标准维护负担。2026-10-03 的准入检查发现其 MIT 许可证一致、registry 未标记废弃、6.0.0 为持续维护的 xterm.js 项目的稳定版本，前一周 npm 下载量为 2,001,724，前一月为 6,573,679。其 buffer API 是实验性的，已固定精确版本，升级时须运行终端控制复现并重新采集 CLI 输出。选定的包没有运行时依赖，仅由录制脚本导入，不进入 docs／client 或已发布 CLI 的入口。因此该依赖不适用生产产物体积阈值；记录的屏幕帧数据仍需正常的文档构建与浏览器检查。
