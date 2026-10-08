# 仓库门禁

[English](../gates.md) | [简体中文](./gates.md)

私有 [`@limina/gates`](../../../packages/gates/package.json) workspace 负责可执行的仓库治理：许可证策略与 dependency-review 一致性、bundled-license 证据、提交约定、文档隐私、发布准入／产物检查，以及 ESLint 规则。仓库检测模块集中在此；根脚本、钩子与配置负责集成入口。产品 graph/source/proof/package detector 保留原有产品归属。

## 归属与自举

[许可证数据](./license-policy.md)只有一个 Markdown owner。[Marked 解析](../../../packages/gates/src/licenses.ts)由构建时的 [bundle 守卫](../../../packages/gates/src/license-policy.ts)与[配置比较](../../../packages/gates/src/repo.ts)共享；YAML 解析使用已接入的 `yaml` 包。暂存区检查器直接解析 index 内容，不导入缓存的工作区列表。

[提交规则](../../../packages/gates/src/commit/config.mjs)、[消息入口](../../../packages/gates/src/commit/message.ts)、[隐私扫描器](../../../packages/gates/src/privacy/index.ts)、[发布模块](../../../packages/gates/src/release/release.ts)与 [ESLint 配置](../../../packages/gates/src/eslint/general.ts)位于同一个私有包中。第三方引擎、catalog 与 release-age／security 控制保留既有版本和 authority。外部服务检查及 audit／报告步骤仍由对应 workflow 持有。

`build:tools` 独立于 Limina 产品，先编译门禁包，再编译构建工具。构建工具通过门禁包导出消费许可证守卫；门禁包不依赖构建工具或任一产品。该包不属于公开发布组，也不进入已发布产品清单。提交与隐私入口使用 Node 原生 TypeScript 支持，依赖安装后无需生成的 `dist` 文件即可运行。发布／ESLint 导出使用编译产物。

门禁包的 TypeScript scope 与根／构建工具中的 typed consumer 使用同一个 build checker。集中模块后，这些 scope 之间形成声明关系；同一个内部声明 component 必须具有同一个 checker owner。修改 checker 路由时保持这一关系，不绕过 graph validation。

## 提交与 CI 入口

| 入口                                                        | 审查输入与行为                                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm run gates:check`                                      | 检查工作区 Markdown 策略与 dependency-review YAML；CI quality action 必需执行。                           |
| `pnpm run gates:staged`／跟踪的 `pre-commit`                | 从 Git index 读取两个文件，要求许可证集合相等，并执行 `git diff --cached --check`。缺失或无效输入均失败。 |
| `pnpm run commit:check <message-file>`／跟踪的 `commit-msg` | 按 Git cleanup 语义执行既有 commitlint 约定，不改写消息。                                                 |
| `pnpm run docs:privacy`                                     | 执行既有文档扫描器；`--built` 与 `--context-records` 保留原有作用域。                                     |
| `pnpm run release:check-tag`                                | 通过发布入口执行 tag／源码发布组／checkout／main 祖先关系守卫。                                           |

未暂存的修复不能使无效的暂存策略通过；顺序不同但集合相同的列表可以通过。检查不暂存文件、不修改 HEAD、不修复配置，也不要求已经存在首次 commit。关联 worktree 与 `GIT_INDEX_FILE` 使用 Git 自身的 index 选择机制。Husky 安装、显式 `HUSKY=0` 与 Git 钩子绕过行为保持原生；CI 独立于本地钩子执行工作区门禁。

提交文案的可读性属于[提交约定](../../../.github/commit-convention.md#subject-and-body)。共享 commitlint 规则限制正文与 footer 的每行长度，计入 bullet 前缀、`BREAKING CHANGE: ` 首行和 footer 续行。直接检查原始行，防止 URL 豁免或 issue reference 的 parser 分类绕过上限。作者应精简正文条目或拆分其要点，并在词间换行 footer 文案；校验器拒绝超长行，不自动改写消息。[Git 钩子测试](../../../scripts/git/hooks.spec.ts)覆盖边界内接受／超限拒绝、Unicode 与 CRLF 输入、URL／reference 场景，以及拒绝真实提交时保留 HEAD 和 index。

这些属于机械检查。[依赖准入](./dependency-admission.md)、许可证义务、语义审查和[最终验收](./development-workflow.md#验证与交付)仍适用于交付或获授权提交前。

## 回归归属

[暂存区门禁测试](../../../packages/gates/src/commit/staged.spec.ts)执行真实的 Git 拒绝／接受提交，覆盖 index authority、损坏输入以及 HEAD／index／工作区保持不变。既有 [Git 钩子](../../../scripts/git/hooks.spec.ts)、[发布](../../../scripts/release/publication.spec.ts)、[Tag CLI](../../../scripts/release/check-tag-cli.spec.ts)、[Workflow](../../../scripts/release/workflow.spec.ts)和[隐私](../../../scripts/docs/privacy.spec.ts)测试保留进程与集成边界，并消费该包。包内 ESLint 测试保留已有 parser／规则回归。根 `test:tooling` 执行这两组测试。

Fixture 仓库在暂存基线前忽略已安装的 `node_modules`。Git 可能将 Windows 目录 junction 遍历为依赖文件，而 POSIX 目录符号链接本身也可能进入 index。暂存区门禁回归检查 Git 的实际 index 中不存在运行依赖，使提交只测试 fixture 自己持有的输入。真实钩子和暂存空白检查保持启用。
