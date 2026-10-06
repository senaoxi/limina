# 开发与验收工作流

[English](../development-workflow.md) | [简体中文](./development-workflow.md)

本页负责仓库设置、编辑边界、路径测试约定与本地验收。修改文件或运行仓库命令前读取适用章节。[架构 workflow](./architecture-workflow.md)负责 invariant impact 与语义 review；[迁移记录](./migration.md)负责本地迁移范围与外部验收门禁。

## 设置与构建

使用 [`packageManager`](../../../package.json) 固定的 pnpm 版本；版本与兼容策略由[工具链记录](./technology-stack.md)负责。显式运行 `pnpm install --frozen-lockfile` 安装，禁止复制旧 `node_modules`。`verifyDepsBeforeRun: error` 会拒绝不同步的安装状态，因此依赖同步须显式执行。

[根脚本](../../../package.json)定义构建顺序。`pnpm run build:tools` 先编译私有门禁包，再编译构建工具；`pnpm run build` 构建这些工具与两个产品。`test` 在单元、工具和 integration 测试前构建；`smoke` 在打包消费者测试前构建。`docs:build` 使用本地构建／提交信息，以 `/` 为 base 构建双语文档。

## 实现前发现约束

机器检查是可执行约束的权威判定，但会实质缩小有效设计空间的约束必须在实现前可见。选择架构或实现路径前，读取适用的 Agent 指令与项目上下文，并识别会影响 ownership、依赖方向、public/internal 边界、生成源码 authority、兼容性或必需 workflow 的约束。

- 精确 predicate、阈值与拒绝逻辑保留在类型、测试、lint、脚本或 CI 中，不在 prose 中复制实现细节。
- 若遗漏某个机器约束会导致实质不同的实现或大量返工，同时在其所属 Agent 指令或 PCR 中保留该约束的持久设计意图。每项 prose 规则只保留一个 owner，通过路由引用，不跨文件复制。
- 纯机械、局部且失败后修复成本很低的约束可以只由 check 持有。
- 若门禁暴露了此前未记录的设计约束，先修复当前改动；当该约束具有持久价值时，在同一改动中更新对应 prose owner。Prose 用于提前指导决策，但不能替代 executable guard；若 prose 与 enforcement 不一致，判断哪一侧过期并修正。

## 编辑边界

编辑前检查 Git 状态，保留无关的 staged、unstaged 与 untracked 工作。记录目标文件基线，写入前复核，避免覆盖并行修改。不得手工编辑生成的 `dist`、`.limina`、声明或缓存。保留受管理标记与生成内容。

依赖版本放在 [workspace catalog](../../../pnpm-workspace.yaml) 中，lockfile 通过 pnpm 生成。新增或替换第三方包前遵循[依赖准入](./dependency-admission.md)。不得新增 reason-field 治理例外；报告具体 issue 与替代方案，由用户决定。

修改测试时使用 [test-audit](../../skills/test-audit/SKILL.md)。保留 fixture 的仓库边界与刻意无效的内容；lint 或格式修复不能消除 fixture 所验证的条件。

## 测试中的 portable path

Limina 绝对路径值是 canonical portable path，在所有平台使用 `/` 分隔符。文件系统和进程输入需要平台原生行为时保留 `node:path`。

- 不得将 Limina 路径值与原始 `node:path` 的 `join`、`resolve`、`relative`、`normalize`、`dirname` 或 `format` 结果直接比较。
- fixture 所属的绝对路径使用 `fixture.path(...)`；其他比较通过[路径 helper](../../../packages/limina/src/__tests__/helpers/path.ts)规范化。
- 相对路径断言使用 `toPortableRelativePath()` 或 `toPortableRelativePaths()`。
- 暴露 `rootDir` 的新测试 fixture 应同时暴露由 `createFixturePathResolver()` 创建的 `path(...segments)` resolver。

[Portable-path comparison ESLint 规则](../../../packages/gates/src/eslint/plugins/portable-path-plugin/rules/portable-path-comparison-rule.ts)是有意设置的 guardrail。不得为使路径断言通过而禁用规则，应规范化比较值。[Helper 测试](../../../packages/limina/src/__tests__/helpers/path.spec.ts)与[规则测试](../../../packages/gates/src/eslint/plugins/portable-path-plugin/__tests__/portable-path-comparison-rule.spec.ts)覆盖这一可执行边界。

[仓库门禁](./gates.md)包负责可执行的仓库检查。提交前，跟踪的 pre-commit 钩子通过 `gates:staged` 审查实际暂存区；`gates:check` 审查工作区，并由 CI 必需执行。注释不能确立配置一致性。

## 验证与交付

从[根清单](../../../package.json)与所属 package 的 `package.json` 查找可用脚本。按改动运行相关的 `test:unit`、`test:tooling`、`test:integration`、`test:smoke`、`docs:build`、`typecheck`、`check` 和 `lint:packages` 脚本，同时遵循适用的 package 指令。若某项相关窄检查的失败会推翻当前实现路径，应在受影响边界首次可验证时就运行，不要把反馈延迟到 commit 或交付阶段；最终验收仍须对完整改动重新运行所有必需门禁。

- 修改 Limina 测试或路径行为后，运行 `pnpm run test:unit`、`pnpm run typecheck`、`pnpm run lint:check`，并对修改文件运行 `git diff --check`。
- 涉及 governed production source/config 的改动，运行 `pnpm run check`；失败后检查 `pnpm exec limina check --issues --format json`。
- 涉及测试或 executable guard 时，运行必需的 unit、typecheck 与 lint 检查。
- `lint:check` 和 `format:check` 是只读检查，修改须显式使用 `lint:fix` 与 `format:write`。
- 仅修改 PCR 时，检查格式、完整中英文内容一致性、本地链接、标题与源码锚点、相关语义证据及 Git 边界，不自动要求完整 build、package 或 release。遵循[双语维护](./README.md#双语发布与维护)及[写入与隐私复核](./README.md#写入与隐私复核)，包括 `pnpm run docs:privacy --context-records .agents/docs`。

交付或获授权提交前复核预期 diff。PCR 与保存的审计结果按 [project-context-writing](../../skills/project-context-writing/SKILL.md) 复核两种语言的隐私与技术含义；凭据只报告位置／类别。最后运行 `git diff --check`、检查 Git 状态，并明确列出已执行和未执行的验证，包括失败与剩余不确定性。本地成功不代表满足[迁移与外部门禁](./migration.md)。
