# Checker Ownership 与 Semantic Authority 实施审查

本文保留提交 `7c4b890c` 的实现与验收记录。当前版本仅使用具名检查器约束和有效配置中的归属意图来决定语义权威，现行规则见[检查器配置](../zh/config/checkers.md#框架推导)。

隐式 Framework 推导是一项直接、确定的 Ownership 策略。对每个 terminal Source Config 完整收集 Config、Root-file 和 Dependency 要求，按精确 Checker 身份去重：唯一结果直接选定 Framework；零结果或多个结果保留 Pending Local Owner，Freeze 使用 Native TypeScript baseline。多命中只在最终报告中产生非阻断 Warning，后续 Build Coloring 继续独立决定执行 Checker。

**状态：实现、三轮独立反证与本机完整验收已完成。** 本文记录本次修正和验收范围，不替代持续维护的架构记录。测试矩阵描述合同，后面的验收记录列出实际执行结果。

报告是仓库交付物，不进入双语公共文档站。[VitePress 配置](../.vitepress/config.ts) 使用 `srcExclude: ['reviews/**']`，保留源码/PCR 的仓库相对链接；公共 Checker 页面继续中英文同步维护。

## 最终合同与知识归属

| 决策                | 合同                                                                                      | 持续维护位置                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 推导规则            | 受支持的有效配置、文件和依赖特征直接产生要求，不设独立 Framework Qualification。          | [推导语义](../../.agents/docs/zh/semantics.md#确定性框架推导)                                                         |
| 唯一与多命中        | 按精确 Checker 去重；唯一选定，多命中 Pending + Native freeze + 最终 Warning。            | [系统模型](../../.agents/docs/zh/system-model.md#authority-的六个维度)                                                |
| 用户控制            | Named Checker 优先，或移除不期望的触发特征；不增加 `inferFrameworks` 或整体自动推导开关。 | [配置设计](../../.agents/docs/zh/configuration-design.md#框架推导策略)、[公共文档](../zh/config/checkers.md#框架推导) |
| Native 边界         | Native roots/options/raw refs/solution role 与 Framework Discovery 分开。                 | [语义事实](../../.agents/docs/zh/semantics.md#一个项目的原生语义输入)                                                 |
| Freeze / Coloring   | 冻结语义；执行颜色只沿合法声明关系传播，无色时使用现有 fallback。                         | [I02 / I07](../../.agents/docs/zh/invariants.md)                                                                      |
| Warning / Admission | Warning 不影响完整性、治理、准入或退出状态；真实错误和必要义务仍可拒绝。                  | [推导语义](../../.agents/docs/zh/semantics.md#确定性框架推导)                                                         |
| 缓存                | 重放当前推导，旧颜色不授予权威；无 Qualification DTO/Cache 或独立 Warning Cache。         | [生命周期](../../.agents/docs/zh/lifecycle.md#框架推导重放与-warning)                                                 |

## 问题分级与修正范围

| 项目                        | 触发条件和根因                                                                                                                                                                                                                                                                                                                                                       | 修正与验收要求                                                                                                              | 分类 / 状态                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| B1：推导提交时机            | [Config](../../packages/limina/src/core/build-graph/checker-ownership-config-evidence.ts)、[root](../../packages/limina/src/core/build-graph/checker-ownership-evidence.ts)、[dependency](../../packages/limina/src/core/build-graph/checker-ownership-dependencies.ts) 若逐条锁定，可让先发现的 family 决定后续解析，并把多命中变为阻断冲突。直接推导本身不是缺陷。 | 完整收集、精确去重、统一裁决；保留依赖迭代，禁止 First-Wins、静默丢弃和多命中 provider 任意传播。                           | 已实现；三轮确定性与依赖反例通过。                        |
| B2：Native 污染             | [Native universe](../../packages/limina/src/core/build-graph/native-source-universe.ts) 若消费宽发现角色或要求无关 Framework 工具，会改变原生 references 闭包或阻断独立 Native 工作。                                                                                                                                                                                | 独立 Native parse；不注入 Framework roots，不用过滤后的 unsupported root 伪装空 solution。                                  | 已实现；Native solution、literal roots 与缺工具控制通过。 |
| B3：提前过滤 Framework leaf | [Source collection](../../packages/limina/src/core/build-graph/source-config-collection.ts) 在正常 Framework 输入发现前用 Native 空集合删除自定义扩展配置。                                                                                                                                                                                                          | 保留所选身份和正常发现机会；Vue 默认 glob `.md` 不消失，真正空项目不扩张。                                                  | 已实现；自定义扩展与 scoped failure 控制通过。            |
| B4：局部失败截断独立工作    | [Scope collection](../../packages/limina/src/core/build-graph/checker-ownership-graph.ts) 的 Framework 准备异常提前结束所有配置的分析。                                                                                                                                                                                                                              | 保留失败身份和独立 Native/locked 工作；由 scoped admission 处理受影响结果。                                                 | 已实现；自定义扩展与 scoped failure 控制通过。            |
| Warning 管道                | 若警告进入 `state.problems`、被最后一个错误覆盖或影响退出码，会违背非阻断合同。                                                                                                                                                                                                                                                                                      | 一配置一条，Checker 排序、身份稳定，与其他错误一起进入最终报告；不影响 completeness、governance、admission 或 exit status。 | 已实现；报告和 Preflight 37 个测试通过。                  |
| 缓存重放                    | 历史 final owner、发现顺序或缓存先恢复的 family 被直接当作当前权威。                                                                                                                                                                                                                                                                                                 | Cold/Warm/Force/replay 统一推导；特征变化撤销旧结果，Warning 当前重建。                                                     | 已实现；独立进程对照及缓存套件 106/106 通过。             |

后置范围包括未覆盖的 Framework 工具链组合、虚拟输入，以及其他 Module Specifier/输出投影组合。本机已实际验收保留 `.tsbuildinfo` 的 tsc → vue-tsc → tsc 切换，范围见下文。新多 Checker composite、Framework 跨进程语义缓存和通用 Resolver 不进入本轮。

## 调用链与状态收敛

[BuildGraphCore](../../packages/limina/src/core/build-graph.ts) 经 [prepare](../../packages/limina/src/core/build-graph/prepare.ts) 进入 Ownership；缓存路径经 [ownership replay](../../packages/limina/src/core/build-graph/cached-ownership-replay.ts) 重建当前来源。

```text
已选入口 / 独立 Native baseline / 正常 Framework 输入发现
  → 显式 Named Checker 约束
  → 收集 Config + Root-file + Dependency 要求，完成必要迭代
  → 精确 Checker 去重和统一裁决
      0：Pending Owner / Pending Authority
      1：对应 Framework Owner / Authority
     >1：Pending Owner / Pending Authority + 当前 Warning 信息
  → freezeSemanticAuthorities：pending 使用 Native TypeScript baseline
  → 按冻结上下文重新采集 locked facts
  → directed promotion / build coloring / finalization
  → Candidate / staged references / 最终 admission / binding
  → 汇总 Warning 和实际错误
```

Named Checker 继续具有最高归属权威，solution 终端约束保留。不同精确显式 Checker 争用同一 leaf 仍报冲突，`tsc` 与 `tsgo` 不能因同属 TypeScript family 而合并。

多命中不设置 `semanticAuthorityUnavailable`，不产生 blocking conflict，也不提前选择 `tsc`。Freeze 后只有确定的 TypeScript Authority、仍待执行求解的 Local Owner 和无归属权威的诊断信息。未决 Framework 集合不进入 Coloring 或最终 Graph。

显式 `tsc` / `tsgo` 继续使用原有 locked Native collector。Native 已完成解析但没有文件输入的请求，保留 `compiler-completed-resolution-without-file-input`，不能因为物理 `.vue` 文件存在就改成必要声明关系。Graph 没有该引用边不保证编译成功：独立真实 `tsc --build` 对照仍报告 TS2307。

Auto pending 的 Framework supplement 则按现有证据合同处理。实际 Vue resolver / Service Script 已证明请求具有声明输入时，多命中后冻结 Native 不能继续借用 Vue 语义：locked assessment 保留 `unknown / framework-semantic-authority-required`，由 Admission 拒绝。`noResolve` 等独立 Native absence 证明仍可消除该请求级义务。这不是额外的 Ownership Qualification。

[Build Coloring](../../packages/limina/src/core/build-graph/checker-build-coloring.ts) 保留合格声明依赖、声明上下文和有效 `implicitRefs`，传播唯一已知精确 Checker；无色使用 `tsc` 或 `auto.useTsgo === true` 时的 `tsgo`，不兼容多色仍阻断。纯 solution 聚合与 framework schedule 不传播颜色。

## 实际触发、诊断与缓存身份

完整触发表由[公共 Checker 文档](../zh/config/checkers.md#框架推导)维护，对应 [framework-intent](../../packages/limina/src/core/build-graph/framework-intent.ts)、[普通文件发现](../../packages/limina/src/core/build-graph/auto-checker-project.ts)和[实际目标分类](../../packages/limina/src/core/build-graph/checker-ownership-membership.ts)。源码边界如下。

- Astro types 仅精确接受 `astro/client`、`astro/env`，plugin 仅精确接受 `@astrojs/ts-plugin`。有效 `files` / `include` 以 `.astro`、`.svelte` 或 `.vue` 完整后缀结束时触发对应 Checker；brace 或任意子串不作为 selector 特征，但发现的真实文件仍可触发。
- Vue 有效 `vueCompilerOptions` 对象含 `{}` 可触发。`extensions`、`petiteVueExtensions`、`vitePressExtensions` 扩展普通发现文件集。Vue 特有属性沿实际 `extendedSourceFiles` 的逆序合并并由叶配置覆盖；`@vue/language-core` 3.2.4 的多个 extends 优先级不强行改成 TypeScript compilerOptions 规则。
- Preset 仅识别精确 `astro/tsconfigs/base|strict|strictest[.json]` 与具有路径段边界的 `.svelte-kit/tsconfig[.json]`。实际继承闭包中屏蔽对应 preset 后，resolved compilerOptions/files/include/exclude 必须有差异，才具有有效贡献。此处只解析 Native 配置，不要求 Framework Parser 证明归属。
- Dependency feature 来自 consumer 实际解析的 Framework target 后缀或已发现的 Vue profile，保留 query/resource 过滤；不借 provider 最终 family。物理目标和 selected-config Coverage 成员关系都不单独证明 Native 编译义务。

[统一裁决](../../packages/limina/src/core/build-graph/checker-ownership-evidence.ts)收齐来源后按精确 Checker 去重；[求解入口](../../packages/limina/src/core/build-graph/checker-ownership-resolution.ts)在 Freeze 前提交。没有独立 Qualification 阶段、推导开关或多候选状态。

[Warning Reporter](../../packages/limina/src/check-reporting/framework-inference.ts)使用 `LIMINA_GRAPH_FRAMEWORK_INFERENCE_AMBIGUOUS`、task `graph:prepare`、severity `warning`。最终 check summary 逐配置列出且不受 blocker 数量上限影响；独立 CLI 结束后写 stderr，Graph JSON stdout 保持机器可读。Warning 中的 Pending 明确是 Build Coloring 前状态，不掩盖已确定的最终 Checker。

当前源码为 [analysis adapter v31](../../packages/limina/src/core/analysis-cache/contracts.ts) 与 [graph key v24](../../packages/limina/src/core/build-graph/analysis-cache.ts)。Snapshot schema 12、storage version 3、`analysis-v2` 目录保持，未增加 Qualification/Warning DTO 或 Cache；这些源码身份不替代运行验收。

## 26 案例测试矩阵

`N` 表示 TypeScript Authority，`P` 表示 Pending Local Owner；A/S/V 分别是 Astro/Svelte/Vue Authority，精确 Checker 是 `astro`、`svelte-check`、`vue-tsc`。所有“允许”仍要求其他准入条件成立。A/S 不因此获得声明生产能力。

拥有者：G = [generated-graph](../../packages/limina/src/__tests__/generated-graph.spec.ts)，A = [analysis-completion](../../packages/limina/src/__tests__/analysis-completion.spec.ts)，R = [reference-validation](../../packages/limina/src/__tests__/reference-validation.spec.ts)，E = [execution-admission](../../packages/limina/src/__tests__/execution-admission.spec.ts)，C = [config](../../packages/limina/src/__tests__/config.spec.ts)，W = [full-analysis-cache](../../packages/limina/src/__tests__/full-analysis-cache.spec.ts) / [vue-analysis-cache](../../packages/limina/src/__tests__/vue-analysis-cache.spec.ts)。映射不表示断言已经充分或执行已通过。

| #   | 输入 / 对抗条件                          | Authority       | Local / Final Owner    | Warning / Admission 与不变量                        | 预期测试拥有者 |
| --- | ---------------------------------------- | --------------- | ---------------------- | --------------------------------------------------- | -------------- |
| 1   | 纯 TypeScript                            | N               | P → tsc/tsgo           | 无 Warning；Native 输入和义务不变。                 | G              |
| 2   | 有效 Astro 配置，没有 `.astro`           | A               | astro                  | 无 Warning；配置可直接触发。                        | G              |
| 3   | 只有 `.ts` roots，导入 `.vue`            | V               | vue-tsc                | 无 Warning；dependency 参与同轮归并。               | G、A           |
| 4   | Config/root/dependency 多次命中 Vue      | V               | vue-tsc                | 无 Warning；按精确 Checker 去重。                   | G              |
| 5   | Vue + Astro                              | N               | P → coloring/fallback  | 一条 Warning；歧义不阻断。                          | G              |
| 6   | Vue + Astro + Svelte                     | N               | P → coloring/fallback  | 一条 Warning，确定性列出三个 Checker。              | G              |
| 7   | Config Astro + Dependency Vue            | N               | P → coloring/fallback  | Warning；不能被先提交 config 锁定。                 | G、A           |
| 8   | Root Vue + Dependency Astro              | N               | P → coloring/fallback  | Warning；不能静默丢弃 dependency。                  | G、A           |
| 9   | 调整特征、文件和发现顺序                 | 一致            | 一致                   | Warning 内容一致；不存在 First-Wins。               | G              |
| 10  | 显式 vue-tsc，同时有 Astro 特征          | V               | 显式 vue-tsc           | 显式优先，不进入 Auto 多命中 fallback。             | G、C           |
| 11  | 显式 tsc，必要 Vue 语义依赖              | N               | 显式 tsc               | 保留义务，Admission 按实际能力判定。                | A、E           |
| 12  | 多命中后合法 Vue 声明传播                | N               | P → vue-tsc            | Warning 保留，冻结语义不变。                        | G、E           |
| 13  | 多命中后无合法颜色                       | N               | P → tsc/tsgo           | Warning 保留，不提前设置 Native owner。             | G              |
| 14  | 多命中且 Native 有真实 unresolved import | N               | 既有执行合同           | Warning 与原有错误分别保留。                        | G、A           |
| 15  | 多命中且必要声明无 producer              | N               | 既有执行合同           | Warning + Admission 拒绝；schedule 不替代声明。     | A、R           |
| 16  | 唯一 Framework，但 Checker 不可用        | 对应 Framework  | 已选 Checker，不可执行 | 保留 Unavailable/Execution Failure，不改选 Native。 | G、A           |
| 17  | 继承 Framework 特征仍有效                | 对应 Framework  | 对应 Checker           | 直接推导，无额外资格门槛。                          | G              |
| 18  | 祖先 Framework 属性被覆盖                | 按其他有效特征  | 对应结果               | 不使用失效属性；覆盖顺序符合解析语义。              | G              |
| 19  | Vue `.md` 自定义扩展，省略 include       | V               | vue-tsc                | 不在 Native 空发现时删除 leaf。                     | G              |
| 20  | 真正空项目                               | 无 Source Owner | 无                     | 正常空范围；不扩大输入。                            | G              |
| 21  | Native solution 有 raw refs              | 各终端分别决定  | 既有规则               | 完整 references 闭包与角色不被宽发现改变。          | G、R           |
| 22  | 独立 TS 与失败 Vue 并存                  | 分别处理        | TS 独立完成            | Scoped Admission；失败不提前截断独立工作。          | A              |
| 23  | tsc/tsgo 显式争用同 leaf                 | N               | 精确 Checker 冲突      | 原有阻断保持，不降为多命中 Warning。                | G、C           |
| 24  | Cold/Warm/Force                          | 一致            | 一致                   | Warning config/checker 列表一致。                   | W              |
| 25  | 修改 Framework 特征后恢复缓存            | 当前输入决定    | 当前输入决定           | 不恢复历史 authority/final owner。                  | W              |
| 26  | Warning 与真实 Graph Error 同时存在      | 实际归属        | 实际执行合同           | 分别汇总；Warning 不被错误吞掉，不改变退出码。      | G、A、E        |

## 实施顺序与文件范围

| 顺序 | 范围                                                                                      | 完成标准                                                                       |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1    | framework-intent、resolved config 及 root/dependency 触发入口                             | 逐项列出实际触发规则；有效继承与已覆盖属性有对照。                             |
| 2    | config/root/dependency evidence、resolution/discovery                                     | 完整收集后裁决，精确去重，保留必要迭代；多命中 provider 不传播任意 family。    |
| 3    | semantic-authority、promotion/coloring/finalization                                       | 多命中 Native freeze + P；允许后续合法传播/fallback，不改变冻结值。            |
| 4    | 最终 Issue Reporting                                                                      | 稳定 warning identity、每配置一条、名称排序；独立错误并存且 exit status 不变。 |
| 5    | native-source-universe、auto-checker-project、source-config-collection、failure isolation | B2/B3/B4 回归，所选身份与必要义务不消失。                                      |
| 6    | analysis-cache/contracts、graph key、cached replay                                        | 当前算法身份更新，保留 Schema/Storage/目录；Cold/Warm/Force 一致。             |
| 7    | 双语文档、PCR、独立复现和仓库门禁                                                         | 本文后续记录实际结果，所有未覆盖条件明确。                                     |

不增加 Framework Qualification 阶段、`inferFrameworks`、候选等级、Qualification DTO/Cache 或 Warning Cache。既有 Native/依赖事实的证据资格和 Admission 不因此删除。解除归属门槛时也不能删除正常 Framework 输入发现能力。

## 验收记录

本节只使用最终修订策略的运行证据，并标明最后源码快照与较早真实输出实验的区别。早期 Qualification / inferFrameworks 试验不作为最终验收；中断进程也不计通过。

### 环境与基线

- 实施基线 HEAD：`01b9688a7847ea901ef1bc0ef0ca27a22d02c1e8`，开始时工作区干净；本次修改未提交。
- 最小复现保存在独立 `repros/checker-ownership-semantic-authority/`，实际绝对位置由交付说明提供。其 `REVISED-EVIDENCE.zh-CN.md` 保存完整命令与观察，`REVISED-MATRIX.zh-CN.md` 映射 26 个案例到精确测试名称。
- macOS arm64、Node 26.13.1、TypeScript 6.0.3、vue-tsc 3.2.4、Astro 7.3.3、`@astrojs/check` 0.9.10；Svelte fixture 使用 Svelte 4.0.0、svelte-check 4.0.0（已安装别名）与 svelte2tsx 0.7.61。没有安装依赖。
- 仓库 cwd 使用 pnpm 12.10.1；外部 cwd 实测 pnpm 11.9.0。外部 runner 使用 Node 与仓库已安装的 tsx，不通过 pnpm 安装或构建 fixture。缓存 fixture 使用最小 npm 11.6.1 元数据和已有工具链链接，不代表安装过程验收。
- 实际触发、Warning code、adapter v31 与 graph key v24 见前节；Schema 12、storage 3 及缓存目录没有变化。
- 最终 `src` 跟踪差异 SHA256：`bda128dd0e9ced56bfaf3441717ece46045401fdbd7fdec0a8d92be24ea07f79`；外部复现将 `src + integration` 一并计算为 `93aa51ce2e712338638e7c6bcff34fcbcdc367fd661d0562a0a1faacff09d772`，该复现之后仅调整 mixed-Svelte 集成 fixture，最终 `src + integration` 差异为 `3ad0cfd423fcc20383c43ad4ef7f9b6fc4a14189bd1cb625c9c419ce6c4420f5`；生产源码与单测所在的 `src` 范围保持不变。`revised-environment-framework-final.json` 另记录新增 reporter 源文件身份。完整门禁在每项开始时记录该差异身份和 running 状态，只有真实结束才记录 completed 与退出码。

| 基线反例                             | 修复前观察                                                               | 修复后观察                                                                                                | 证据文件                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Vue + Astro roots                    | 阻断性归属冲突。                                                         | TypeScript freeze、pending seed、Native fallback、一条 Warning；无独立义务时准入。                        | `revised-baseline-before.json` / `revised-baseline-after.json`               |
| Astro 脚本请求 Vue `.md`             | 临时采集已识别 profile，归并时丢失，仍为 Astro 且无 Warning。            | 依赖归并使用当前 profile，consumer 为 TypeScript；保留 Astro + Vue Warning。                              | `revised-profile-before.json` / `revised-profile-after.json`                 |
| Native solution、raw refs 与旁置 Vue | combined roots 将 solution 当 leaf，拒绝 references，终端没有进入 plan。 | 按 Native roots 保留 solution，遍历到终端 lib；显式 Framework source 和字面 unsupported root 控制仍拒绝。 | `revised-native-solution-before.json` / `revised-native-solution-after.json` |
| 显式 Native 旁置未消费 Vue且无工具   | 无关 Vue 准备可使 Native 图失败。                                        | 不探测无关工具；Native roots 与显式归属保持。                                                             | `revised-framework-final-core-round2.stdout.log`                             |

后两项开发中发现的基线使用各自未提交源码快照，不冒称全部运行在原始 HEAD。

### 三轮独立对抗性测试

下列命令中的 `LIMINA_ROOT` 与 `REPRO` 分别表示当前仓库和独立复现目录。实际绝对命令、stdout/stderr 和各轮 fixture 都保存在外部证据目录。

```sh
node --import "$LIMINA_ROOT/node_modules/tsx/dist/loader.mjs" "$REPRO/revised-rounds.mts" round1 framework-final
node --import "$LIMINA_ROOT/node_modules/tsx/dist/loader.mjs" "$REPRO/revised-rounds.mts" round2 framework-final
node --import "$LIMINA_ROOT/node_modules/tsx/dist/loader.mjs" "$REPRO/revised-rounds.mts" round3 framework-final
```

| 轮次          | 反证目标及独立维度                                                                                                          | 实际结果                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1：推导确定性 | 改变配置、标准/自定义扩展、显式选择、重复请求、Astro ↔ Vue `.md` 循环及遍历顺序；保留真正空项目与 unsupported roots 控制。 | 11 个观测通过。唯一 Vue 去重；多框架保留 pending seed、TypeScript freeze 与稳定 Warning；显式 Vue 不被 Astro 特征覆盖。                       |
| 2：语义与输入 | 改变工具可用性、Native solution/raw refs、literal roots、请求级 noResolve、必要 Framework 依赖和合法声明颜色。              | 10 个观测通过。A/C 独立工作完成、失败 B 保留；必要 unknown 拒绝，独立 absence 控制允许；普通 TS 声明边可让 TypeScript 语义项目采用 Vue 执行。 |
| 3：缓存与执行 | 每步新进程；cold/warm/force、继承特征移除/恢复、源码与成员变化、显式 owner、必要请求、合法声明颜色、Native solution 恢复。  | 14 个观测通过。普通多命中和 Native solution 的 warm 实际 `graphHits=1`；变化按当前输入重算，Warning 与归属一致。                              |

三个最终 runner 均退出 0，结果保存于 `revised-framework-final-core-round1.stdout.log`、`revised-framework-final-core-round2.stdout.log`、`revised-framework-final-core-round3.stdout.log`，各有独立 stderr 日志。最终串行命令 `node revised-framework-acceptance.mjs` 的 9 个步骤均退出 0；完整命令、cwd、时间和状态见 `revised-framework-final-acceptance.json`。第二轮 Astro 临时脚本采集打印了缺少可选 `@astrojs/vue` integration 的提示；该轮最终采用 Native，不证明 Astro 实际渲染 Vue 的能力。

最后的输入边界修复同时接受三轮新增反证：`revised-input-boundaries.mts round1 boundaries-final` 验收六种继承解析、叶覆盖和取消，共 8 例；`round2` 验收四种配置异常各自与独立显式冲突的组合，共 8 例；`round3` 在 6 个新进程中执行 cold/warm、破坏 JSON、force、修复和再次 warm。命令使用上面的 Node/tsx 入口；输出为 `revised-boundaries-final-inputs-roundN.stdout.log`，详见外部 `REVISED-INPUT-BOUNDARIES.zh-CN.md`。这 22 个输入边界观测运行于 boundaries-final 快照；最后 Oxc 修复后的 framework-final 快照再次完成核心三轮 11、10、14 个观测。两组均通过，不能将较早输入边界运行表述为最后快照重跑。

第二轮必要义务案例使用 Auto consumer 自身的 Astro selector 和真实 Vue request，provider 为唯一有效 Vue。独立 `revised-supplement-proof.mts framework-final` 观察到 selection 的 `qualified-supplement-v1` 为 `present`，规则是 `declaration-project-composite-root-membership:typescript-6.0.3`；Native freeze 后为 unknown。noResolve 对照在两阶段均为 `compiler-noResolve-disables-module-input` 的 absent。`revised-explicit-native-error.mts locked-final` 则证明显式 Native 保留无引用边，同时真实 Checker 以 TS2307 失败。这两项不能合并为“所有物理 Framework 命中都是必要义务”。

独立缓存反例另运行 8 个进程：只删除 Svelte 内部 Vue import 后，普通运行与 force 均从多命中转为唯一 Svelte，Warning 清空，没有观察到 stale。这个 Svelte 组合和 Native 语义/Vue 执行的复杂组合会因 `fallback-graph-native-context-unbound` 安全重采；不能宣称它们命中了完整图缓存。相同 harness 的纯 Native 控制实际 warm hit，删跨叶 import 后 miss，引用边从一条变为零条。保留现有缓存绑定门，不为性能放宽准入。

### 真实输出、Module Specifier 与 buildinfo

```sh
node --import "$LIMINA_ROOT/node_modules/tsx/dist/loader.mjs" "$REPRO/revised-build-switch.mts" accepted-final
node --import "$LIMINA_ROOT/node_modules/tsx/dist/loader.mjs" "$REPRO/revised-build-switch.mts" outputs-final --outputs
```

分别完成 5 次声明构建和 11 次含实际 output projection 的 tsc/vue-tsc `--build` 子命令，全部退出 0。同一个配置从 `tsc → vue-tsc → tsc`，Semantic Authority 始终 TypeScript，Warning 每阶段一条。中间阶段真实声明引用保留 `../ui/value`；输出 `dist/app/index.d.ts` 从本地常量声明变为该 re-export，再恢复原内容。

这两项运行于 `accepted-final` / `outputs-final` 源码快照，早于最后的显式 Native collector 修复。最后修复没有改变这些 Auto coloring / output 投影路径，但本报告不将旧快照的真实构建表述为最后快照重跑。

脚本没有清理上一阶段产物。共享 `.limina/tsbuildinfo/build/tsconfig.json.tsbuildinfo` 在同一路径随输入切换后回到初始 hash；对应 UI buildinfo 不变。完整命令、内容与 hash 保存于 `revised-build-switch-outputs-final.json`。这只证明当前工具链和该输入往返，不扩展为所有跨版本增量构建组合。

### 混合 Svelte 的显式归属与真实 CLI

相关集成首次运行 53 passed / 1 failed。A 的 `.svelte` 文件直接导入 B 的 `.vue`，因此 Auto 按最终规则得到多命中并冻结 Native；D 再导入 A 时缺少唯一 Svelte owner。Warning 本身不阻断，缺少必要 Framework 能力才导致 materialization 失败。

原 producer 构建与修复测试改用 Named `svelte-check` 选择一个只引用 A 的合法 `svelte-authority/tsconfig.json` solution。其他四个消费者继续 Auto，原五 targets、七 edges、references、rootDir、producer ordering、输出修复及超时断言全部保留。该完整集成文件通过（82.29s）；没有修改生产源码或单测。

独立复现使用以下命令：

```sh
node --experimental-import-meta-resolve --import "$LIMINA_ROOT/node_modules/tsx/dist/loader.mjs" "$REPRO/revised-svelte-authority.mts"
```

三轮分别改变显式约束和增量状态：同一源码的 Auto 负例退出 1，保留正确 Warning 与能力错误；独立 Named cold 目录退出 0；仅删除真实 Vue declaration 后的新进程 `checker typecheck` 退出 0，检查五个入口并重建 `DefineComponent` 输出。完整命令、观察和首个 harness 换行匹配失败的保留记录见外部 `REVISED-SVELTE-INTEGRATION.zh-CN.md`、`revised-svelte-authority-results.json`。这组实际使用 Svelte / svelte-check 4.0.0，不推及其他版本或 Windows。

### 仓库门禁

| 检查                                       | 实际命令与结果                                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 聚焦 Ownership / configuration / Admission | 最后输入/来源三个测试文件 112/112、Graph 边界 11/11；早期 custom profile 与 Native solution 控制 4/4。详细名称与各快照见外部矩阵。                                                                           |
| Warning 管道                               | 报告单元 22 个、Preflight 15 个通过，共 4 文件 / 37 测试；真实 CLI 新增集成 1 个通过，覆盖 cold/warm/force、真实失败并存、stderr 与 JSON 隔离。                                                              |
| 构建                                       | `pnpm run build` 通过，最后生产源码边界修正后重新构建。                                                                                                                                                      |
| 完整 typecheck、lint:check、check          | 最终源码（bda128dd）分别通过（142.553s / 117.864s / 145.639s）。lint 0 errors、4 条未修改 eval 文件的既有 complexity warnings；治理检查 Project References 648、完整性 8 项，全部零 issues。                 |
| 完整 unit                                  | `pnpm run test:unit` 最终退出 0（1697.015s）：Limina 148 文件、3502 passed / 1 skipped；migration 8 文件、166 passed，共 3668 passed / 1 skipped。唯一跳过项是仅适用于 Windows 的 descendant junction 用例。 |
| 相关 integration                           | 三个相关文件最终 54/54 通过（160.136s）：mixed-svelte-producers、config-process-cache、default-check-workflow。旧 Auto 预期的失败基线及显式选择修复见上节。                                                  |
| 文档与隐私                                 | `pnpm run docs:build` 通过（6.701s）；文档与构建产物扫描 354 个文件零问题；`pnpm run docs:privacy --context-records .agents/docs` 扫描 38 个文件零问题。                                                     |
| Git 范围                                   | `git diff --check` 通过；HEAD 仍为实施基线，60 个变更文件（58 个已跟踪、2 个新增）均属于本轮。暂存区为空，没有依赖清单或 lockfile 修改，没有提交、推送或部署。                                               |

曾主动中断旧策略或待修正的测试，并在系统重启后丢失两次完整门禁会话。这些日志均无成功退出证据，不计通过。最终串行门禁由外部 `run-final-gates.py` 保存每项真实命令、退出码和耗时。

完整单测的早期运行发现显式 Native 缓存回归：32 个用例失败。第一版复用已解析请求的修法仍有 17 个失败，随后临时 Native Core 方案也未保留原有语义边界，两版均已移除。最终恢复显式 Native 的原 locked collector，仅真正 pending 的 Authority 使用 pending 采集；原有显式 tsc/tsgo 断言保持。最后的边界聚焦 7/7、完整缓存套件 106/106（full-analysis-cache 77、vue-analysis-cache 29）通过。Native 与 JSDoc 的独立损坏→修复→新进程恢复控制均得到修复时 `semanticPrograms=0`、随后 `graphHits=1`。失败日志和修复经过保存在 `REVISED-CACHE-REPAIR.zh-CN.md`，没有用扩大 fallback 或削弱原断言隐藏回归。

随后一次完整单测发现两类输入边界回归，保存日志后主动中断。独立聚焦复现 7 个失败：6 种 extends 形式都保留了有效 Vue 配置，却把 hint 的祖先来源误记为叶配置；损坏配置案例保留了独立请求、partial execution 和 incomplete traversal，却将治理状态从 unavailable 改成 violations、准入从 unavailable 改成 denied。前置完整断言保存在 `revised-input-boundaries-before.log`；这次中断的全量运行不计通过。修正保留原断言，最终三个关联文件 112/112、Graph 边界 11/11 通过。实际 parser Error 使用现有失败通道；missing generated extends、Auto inspection 的 invalid option 及 invalid references 保留原结构化诊断。新增对照证明独立 Named 冲突仍为 violations/denied；无缓存 API 保留原异常，缓存遇到当前输入失败拒绝恢复。

下一次完整单测结束时，147 个文件通过，generated-graph 的 14 项失败。13 项来自临时 Framework 采集丢失已有 Checker target 后，对库引用或合成运行时请求重复执行 Oxc。外部 ordinary-target 反例观察到 consumer 作者请求 1 次、provider 合成 Vue 请求 6 次；这不证明 consumer 越过了禁止救援边界，但仍是需要修正的生产过度观察。修正保留 Checker target，仅在没有目标、属于当前 Framework 实际成员且具有作者定位时进行受限 fallback，原 13 个 spy 断言不放宽。另一项旧 Auto Astro 调度预期与新多命中策略不一致，改为显式 Astro 保留四类调度断言，并加入同 fixture 的 Auto Native/Warning 对照。聚焦 16/16、完整 generated-graph 426/426（737.00s）通过；最后三轮核心反证和请求级控制也通过。随后完整仓库门禁通过，结果见上表。

### 剩余证据边界

- Node 22、Windows、其他 Framework 版本和全部虚拟 overlay/跨 Region 组合没有在本轮运行，不宣称跨平台或全部生态兼容。
- 部分复杂 Framework 组合安全重采；结果一致性与实际缓存命中是两个分别记录的结论，本轮不扩展缓存性能优化。
- Astro/Svelte 不因直接归属获得声明生产能力；必要声明仍必须具有合法 producer/reference。没有增加多 Checker composite 或 Framework 跨进程语义缓存。
- 本轮实施与本机验收已完成。最后只调整了 mixed-Svelte 集成 fixture；生产源码与单测未变，已通过的完整 unit 仍对应最终输入。该 fixture 随后三轮真实 CLI、完整相关集成组、typecheck、lint 与 check 均通过。
