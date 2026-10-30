# Limina Architecture Knowledge

[English](../limina.md) | [简体中文](./limina.md)

Limina 把配置选定的 package 治理范围、checker 的语义事实、声明构建关系和文件写入权限连接起来。一次成功的治理运行，要分别回答“谁有权解释源码”“哪些关系需要检查或构建”“这次结果是否仍然有效”。这些答案共享输入，但拥有不同的 authority，不能从一个字段推导出全部结论。

本记录集重建于 **2026-09-11 当前 working tree**。生产代码、类型、schema、配置和可执行调用链是事实来源；测试用于寻找反例。旧 PCR 仅用来发现待核对的问题。所有文字均未获 human vouch；`Confirmed` 表示有直接实现依据，不表示长期产品承诺或全部环境已实测。实测范围单列在[本次审计](./architecture-audit.md)。

默认 Check 独立计划全部五个治理与 Checker 任务，不依赖顶层 Graph/Source/Proof 声明。Scope 保持输入权威，治理域选项提供策略；必要准备、执行准入、显式流水线及独立检查保留各自合同。输入结构和诊断归属见[配置设计](./configuration-design.md#固定默认检查与配置)。

## 从问题进入记录

[配置项设计心智模型](./configuration-design.md)维护公共配置项的位置、分组、默认值与兼容性取舍的理由。

| 要回答的问题                                                                 | 唯一 prose owner                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 实体如何识别、authority 从哪里来、实际运行顺序是什么、哪些关系可以建边？     | [系统模型](./system-model.md)                                            |
| 配置选择、最近根 manifest 与 workspace/single 分类如何建立 authority？       | [根 authority](./system-model.md#工作区发现-authority)                   |
| 无名称 Knip owner 如何保留身份，哪些 pnpm 行为属于独立能力？                 | [Knip identity 与能力](./system-model.md#knip-owner-identity-与能力边界) |
| validated region 如何索引 canonical package、owner cut 与重入？              | [Region 查询索引](./system-model.md#validated-region-的内部查询索引)     |
| TypeScript / Vue / Astro / Svelte 如何取得可信的 dependency facts？          | [语义事实](./semantics.md)                                               |
| generation、cache、dispose、artifact、mutation 和 issue freshness 如何衔接？ | [生命周期与发布](./lifecycle.md)                                         |
| 哪些性质不可在普通重构中意外改变，为什么，如何反证？                         | [12 条 Core Invariants 与 evidence matrix](./invariants.md)              |
| PR 如何做 impact analysis，如何同步代码、guard、PCR？                        | [Review 与维护 workflow](./architecture-workflow.md)                     |
| 旧 PCR 修了什么、四轮 review 和实际命令结果是什么？                          | [本次审计](./architecture-audit.md)                                      |

系统模型负责定义；invariants 负责性质、反例和保护位置；workflow 负责维护动作；audit 只保存本次证据和修正结果。其他记录链接这些 owner，不复制完整定义。仓库集成边界仍由 [architecture.md](./architecture.md#limina-边界) 负责。

## 当前公开面

[package.json](../../../packages/limina/package.json) 定义 ESM 包、Node 范围、`limina` binary 和 exports；版本号以 manifest 为准，不在架构记录中维护第二份。主模块的公开 API 以 [src/index.ts](../../../packages/limina/src/index.ts) 为准：`defineConfig`、配置类型、validation errors 和 governance issue types；内部 provider / semantic context 并未因此成为公开插件 API。

[CLI factory](../../../packages/limina/src/cli/factory.ts) 注册 init、check、graph、proof、source、build、checker、package、release 和弃用的 migration 转调入口。独立的 `limina-migrate` 包拥有迁移执行，并内联同次发行所需的核心源码。主 CLI 的 `migration` 仅保留为弃用转调入口。`limina/internal/*` 将 workspace 模块直接映射到 `.ts` 源码；发布 export map 会移除全部 internal 映射。这些同次发行入口不是跨版本插件 API。分发与依赖细节归[仓库边界](./architecture.md#limina-边界)，验收范围归[迁移生命周期](./lifecycle.md#migration-是另一种事务)。具体子命令和 flags 查看注册模块、schema 与 `limina --help`。`release check` 检查配置的发布一致性；真正的发布流程由仓库 release 脚本负责，不能把检查命令当作 npm publish。

[构建配置](../../../packages/limina/rolldown.config.ts) externalize 声明的 runtime/peer/optional dependencies，其余 build inputs 可被打包；[manifest generator](../../../packages/build-tools/src/package-plugin.ts) 保留并解析 development metadata，移除 private workspace development dependencies。devDependencies 中出现工具不意味着它变成生产依赖，也不能从名称推断一定 bundled。发布产物的具体内容仍需相应 build/package checks。

[配置 loader](../../../packages/limina/src/config/loader.ts) 接受 object、promise 或接收 command/mode 的 function，再规范化、验证。顶层配置、默认值和兼容范围的定义归 [config](../../../packages/limina/src/config) 与 [schema](../../../packages/limina/src/config/schema/root.ts)；根仓库的选择归 [limina.config.mts](../../../limina.config.mts)。当前 flat `scope.checkers` 同时容纳 `auto` policy 与 named scopes，自动发现持续启用。named scopes 选择默认 source `tsconfig.json`；named configs 通过受管理 references closure 进入，`auto.exclude` 不截断既有 closure。不要重新引入 legacy `mode: auto` 模型。

公共配置只将治理边界归入 `scope`。`graph`、`source`、`proof`、`package`、`release`、`pipelines`、`concurrency` 和 `cache` 放在顶层；`concurrency` 替代原来的 `execution` 字段。全部字段均可省略。拒绝 `checks` 和 `execution` 包装层，让各入口直接可见，降低发现和认知成本。[公共类型](../../../packages/limina/src/config/root-types.ts)与 Zod Schema 共同定义入口；旧顶层字段及旧并发路径会被拒绝并给出迁移提示。内部 `ResolvedLiminaConfig` 直接携带同一结构，另加 `configPath`、`rootDir`、`governanceRoot` 等解析事实，不建立第二份旧格式投影。源码选择、checker 归属和区域 authority 仍由原 consumer 决定；`package.entries` 继续为 workspace 提供输出根，不能延迟到 package task 才消费。pipeline 顺序与并发默认值由原执行模块决定。

此次分组复用已有 TypeScript 类型、Zod 和字段验证器；没有新的加载器、合并库或 pipeline DSL。分域的公开选项及对象／函数配置可以参考 [Vite 配置](https://vite.dev/config/)和 [Vitest 配置](https://vitest.dev/config/)，但不移植其 root、默认值或加载语义。公共配置的具体用法见[配置文档](../../../docs/zh/config/config-file.md)。

## 事实、推导与人类判断

- **FACT / Confirmed**：能指出创建者、消费者、必要 guard 及作用条件的当前行为。
- **INFERENCE / Derived**：由多处事实推得的性质或风险；不据此编造设计者动机。
- **DESIGN JUDGMENT / Candidate**：建议、取舍或未决产品边界；必须明确谁需要作决定。
- **NOT VERIFIED**：没有执行相应实测，或环境不能保留关键条件。测试代码存在不等于本次运行通过。

这些记录定义检索与 review 规范，未设立 decision ledger，也没有人类认可标记。源代码不能回答的方向问题保留为 Open：公开 issue/schema/path 的兼容承诺范围；固定 checker 集之外的扩展契约；`build --raw` 的长期地位；domain/application 分层是否将统一驱动全部生产验证；是否将持久化缓存扩展到原生适配器之外。关闭 Open 问题需要明确的项目决策或相关实证；仅有实现不能建立产品意图。
