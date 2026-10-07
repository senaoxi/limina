# 项目上下文地图

[English](../README.md) | [简体中文](./README.md)

源码、测试与配置负责当前行为；记录负责持久背景。继承记录的历史验收不代表本次迁移结果。所有记录尚无人类 vouch。

## 按任务阅读

编辑前读取相关的双语记录。架构工作通过 Limina 地图定位唯一 owner；下列入口为其他任务和具体问题提供路由，不重复 owner 的定义。

| 任务或问题                                                 | 上下文 owner                                |
| ---------------------------------------------------------- | ------------------------------------------- |
| 设置仓库、编辑、构建或验收改动                             | [开发工作流](./development-workflow.md)     |
| 开始架构工作并定位语义 owner                               | [Limina 地图](./limina.md#从问题进入记录)   |
| 识别实体、authority、执行阶段与关系                        | [系统模型](./system-model.md)               |
| 建立 TypeScript / Vue / Astro / Svelte 的依赖事实          | [语义事实](./semantics.md)                  |
| 追踪 generation、cache、context、mutation 与结果 freshness | [生命周期](./lifecycle.md)                  |
| 定位受保护性质、反例与 executable guard                    | [Core invariants](./invariants.md)          |
| Review invariant impact 并选择维护验证                     | [架构 workflow](./architecture-workflow.md) |
| 核对重建证据、纠正内容与验证边界                           | [架构审计](./architecture-audit.md)         |
| 改变包分发或仓库集成边界                                   | [仓库架构](./architecture.md)               |
| 评估需求的复用方案，或新增／替换第三方依赖                 | [依赖准入](./dependency-admission.md)       |
| 维护支持的依赖许可证与 bundled-code 策略                   | [依赖许可证策略](./license-policy.md)       |
| 维护仓库门禁与提交检查                                     | [仓库门禁](./gates.md)                      |
| 理解工具链版本与兼容策略                                   | [工具链与检查](./technology-stack.md)       |
| 改变 CI、安全、报告或外部 workflow 集成                    | [基础设施](./infrastructure.md)             |
| 核对本地迁移范围与远程／发布／部署门禁                     | [迁移](./migration.md)                      |

持久化 importer/context 有效性、Program 创建前恢复及 provider 支持边界由[语义记录](./semantics.md#持久化-importer-有效性)维护；lockfile 信任、本地 typeRoots 指纹、单次调用冻结、namespace 级配置版本、epoch、定向重建与快照发布由[生命周期](./lifecycle.md#原生持久化分析缓存)维护。

## 双语发布与维护

英文主题位于 `.agents/docs/<name>.md`，完整中文对应版本位于 `.agents/docs/zh/<name>.md`。两个文件必须同名且均由 Git 跟踪；它们是同一个 prose owner 的两种语言版本。

1. 每次 PCR 更新都必须在同一次变更中维护完整文件对，包括纯文字纠正以及新增、重命名、移动或删除。
2. 含义、示例、证据日期与边界、限制、来源及有效状态须一致。任何一种语言都不是独立事实来源；翻译不产生新的验证、证据或人类 vouch。
3. 同步维护两种语言的地图与交叉链接。逐节比较两个版本及标题锚点；从各文件所在位置检查本地链接。

## 写入与隐私复核

写入 PCR 或保存技术审计结果前使用 [project-context-writing](../../skills/project-context-writing/SKILL.md)；写作、证据状态区分与隐私复核步骤由该技能负责。记录技术事实、决策、理由、验收标准与有效状态。待完成要求在源码和相关检查支持前仍为待完成。相关的技术验证日期、公共引用及正常产品用户概念可以保留。

每项 current truth 只保留一个 prose owner；不得把未加 stamp 的解释变成人类意图或永久兼容承诺。未经明确指示，不得新增 vouch 或 decision ledger。

将反馈提炼为项目约束，不保留提出者、私人交互日期、对话／任务标识、个人路径或原始私人元数据。来源字段必须指向仓库相对证据、可复现检查或必要公共引用。这一仓库规则优先于任何受管理 PCR workflow 中的对话归因措辞；保留受管理标记与生成内容。

交付或获授权提交前，按技能清单复核预期 diff 与两种语言的隐私和技术含义。运行 `pnpm run docs:privacy --context-records .agents/docs` 及适用的格式、配对、链接和 Git 检查。模式扫描只是复核辅助，不能证明隐私或实现；仍须人工检查语义。凭据只报告位置／类别，不把私人原文复制到报告或 fixture。
