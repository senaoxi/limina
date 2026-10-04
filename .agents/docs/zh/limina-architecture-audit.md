# Limina Architecture Reconstruction Audit — 2026-09-11

[English](../limina-architecture-audit.md) | [简体中文](./limina-architecture-audit.md)

下文历史本地路径使用脱敏别名：`$EVIDENCE_ROOT` 表示复现根目录，`$SOURCE_REPO` 表示原始源 checkout。命令结果与证据日期保持不变；别名不表示私有证据已公开。

本页记录本次 reconstruction 的 evidence 与 reconciliation，不另定义系统语义。当前定义归[system model](./limina-system-model.md)、[semantics](./limina-semantics.md)、[lifecycle](./limina-lifecycle.md)；性质归 [I01–I12](./limina-invariants.md)。

## Scope 与方法

审计覆盖被检查的 working tree，包括 semantic/build-graph/import-analysis 修复及已有回归测试。HEAD `561683d2f11985eea85d0921ed2ed1a2768f48da` 仅标识基线来源；不能假设该 HEAD 独自包含这些修复并据此复现下列结果。

先记录 status/index/content fingerprints；从 CLI/config → pipeline/preflight → workspace/ownership → semantic fact → graph/validation → mutation/reporting 重建调用链；再用 tests、installed compiler oracle 和外部 repro 挑战模型；最后逐段比对旧 PCR。源码与实际执行的检查建立技术事实；检索提示不能建立产品方向。没有生产行为修改，没有新增/弱化 tests，没有 stage/commit。

**Source-established**：本记录集的 phase、field、guard、调用边界，来自直接源码。**Test-backed**：下述实际执行的现有回归。**Empirically verified**：外部 repro 中列出的具体条件。**Derived**：缓存/API integration 风险。**NOT VERIFIED**：完整 optional checker version matrix、Windows 实机、远端 CI、任意并发 filesystem race，以及未执行的 integration/build/release checks。

## PCR reconciliation

检查了 `.agents/docs/README.md`、`limina.md`、`architecture.md`、`technology-stack.md`、`intent.md` 及 dependency-admission 的相关边界。以下按原 Limina 记录的全部主题登记去向；这是 correction record，不保留第二份 current 定义。

| 旧知识 / 原问题                                                                                   | 动作与修正                                                                                                     | 当前 owner / source evidence                                               |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| map 开头笼统称 persistent context 已 verified                                                     | **收窄**：每条记录有自己的证据范围；PCR 不是当前正确性的证明                                                   | README；入口 evidence levels                                               |
| package version `0.2.3`                                                                           | **删除重复易漂移值**：当前 manifest 为 `0.3.0`，长期以 manifest 为准                                           | 入口；`package.json`                                                       |
| public commands、exports、config object/promise/function                                          | **保留并压缩**：command 与 schema owner 链接，不维护第二份所有 flags                                           | 入口；`index.ts`、`cli/factory.ts`、`config/loader.ts`                     |
| default pipeline 被有序列表表达                                                                   | **修正**：default independent、named ordered，materialization 与 generation 是前提/边界；不暗示所有阶段串行    | system model；`pipeline/steps.ts`、`plan.ts`、executor                     |
| flat checker namespace、named scope、auto discovery                                               | **保留**；selection 与 closure 的条件紧跟说明                                                                  | 入口、system model；checker config/discovery/explicit ownership            |
| authority freeze 在所有 solution constraints 之前                                                 | **收窄**：named solution authoritative closure 已在 discovery；freeze 后是 promotion/coloring/finalization     | semantics、I02；`checker-ownership-resolution.ts` / discovery              |
| semanticAuthority 与 finalOwner 分离                                                              | **保留并解释原因**；freeze 是值快照和校验，不虚构 deep freeze                                                  | I02；types / semantic-authority / generated-graph tests                    |
| locked native provider 只用 root-facts，禁外部/lib/reference closure；后文又说 full bounded       | **重写矛盾**：provider 现在创建默认 full bounded Program；importer roots 仍受限；root-facts 是单独 mode        | semantics、I03；`provider.ts`、`context.ts`、`admission.ts`                |
| native facts snapshot boundary-independent                                                        | **修正**：workspace boundary 在 facts identity 内，影响 external ambient closure；不是纯 syntax cache          | lifecycle、I09；`typescript-semantic/identity.ts`、native repro            |
| native raw resolution、ambient evidence、referenceRequirement                                     | **保留并分层**：四字段不可合并；ambient+membership 与 augmentation 举具体反例                                  | semantics、I05；`dependency-fact.ts`、native repair tests                  |
| 所有 locked framework authority 仅来自 generated representation                                   | **收窄**：framework generated paths 与 native TS channels 并存；普通 TS occurrence 不强制走 SFC map            | semantics；checker-resolution-provider / preparation-source                |
| Oxc 全局不能产生 graph/source evidence                                                            | **收窄**到 locked project-dependency 目标；pending physical candidate 和 runtime inspection 各有调用契约       | semantics、I04；checker-resolution-provider / direct-dependency-record     |
| PreparedDependencyFact provenance、path/kind、strict mapping                                      | **保留**；把 resolvedBy、target kind、TypeEvidence 拆开解释                                                    | semantics、I04；dependency-record / framework contracts                    |
| framework tuple 大段版本列表                                                                      | **移动到可执行 source owner 引用**：adapter admission 不等于所有版本实测；leaf/toolchain scope 留在语义页      | semantics；checker compatibility/toolchain files                           |
| Astro sharp/CI licenses 的历史理由混在 semantic authority                                         | **移出语义定义**：指向 workspace overrides 与 Dependency Review policy；不沿用无新证据的设计动机、不授权新例外 | workflow；`pnpm-workspace.yaml`、`.github/workflows/dependency-review.yml` |
| Vue/Astro/Svelte host、native routes、strict map、Svelte mode 与 Windows map path                 | **保留并收窄**工具链能力；Vue process-wide slot 明示；Svelte 不代表完整 preprocess/config lifecycle            | semantics / lifecycle；framework source 与 tests                           |
| effective roots、relative types、compiler-requested JSX                                           | **保留**；明确 actual compiler request，不从 JSX mode 单独推导                                                 | semantics、I03；effective-roots/module-records/compiler-overrides          |
| generated configs、source solution/leaf、output projection                                        | **保留**；raw references 是 semantic 输入，不表示 source leaf references 被治理层允许                          | system model / semantics；solution-role/generated config readers           |
| declaration-provider / framework-schedule / dts 终点                                              | **保留**；加入 raw refs / implicitRefs / solution equality，去掉“每条边都由 import 开始”的可能误解             | system model、I06–I07；reference-recording/framework inference/coloring    |
| 一个 canonical path 或一个 generation 统管全部 identity                                           | **修正**：lexical config path 与 physical package/mutation identity 分开；analysis/provider generation 分开    | system model / lifecycle；utils/path、manager、namespace                   |
| raw / authority packages、regions、name 可选                                                      | **保留**并明确 physical alias guard 的范围                                                                     | system model、I01；workspace validation                                    |
| validation domains、resource physical/type/package 条件、proof coverage、package output selection | **保留并解释 phase gate**；configured checks 不等于全仓库所有性质                                              | system model、I08；graph/source/proof/package runners                      |
| graph export view 和 preflight ownership                                                          | **保留**；graph document 不具 task/resource/cache authority，internally owned 与 borrowed lifetime 分开        | system model / lifecycle；dependency-graph setup/collection                |
| check snapshot v7 / source v1                                                                     | **修正**：当前 check v8；source 和 standalone invocation 是不同 v1 schema                                      | lifecycle、I12；snapshot/types、invocation-snapshot                        |
| attempt sequence、last-run/completion digest、不回退旧结果                                        | **保留**，限定已 published attempt；config/plan 失败可能尚未发布                                               | lifecycle、I12；attempt IO/query 与 CLI tests                              |
| namespace、manifest v5、writer lease、replan、marker/recovery                                     | **保留并收窄**到对应 managed materialization；unrevisioned 内部 plan、raw/export/migration 不借用同一保证      | lifecycle、I10–I11；namespace/plan/materializer                            |
| migration JSONC、dirty Git、hardlink、非原子 in-place、drift保留                                  | **移动**至生命周期页完整解释；不与 materializer 合成同一事务                                                   | lifecycle；commands/migration/transaction                                  |
| cross-platform fixtures、CLI process budgets、Corepack cache                                      | **移动**至 workflow supporting traps，保留 source/test owners；不升为 core 性质                                | workflow；path helpers、detector environment、CLI/recovery tests           |
| root architecture 与 technology 重复 package-local定义                                            | **保留 repository integration**，default pipeline 只链接 system model                                          | architecture / technology-stack                                            |
| intent 中独立 release units                                                                       | **保留不改**：manifest/release unit 事实未见冲突；长远产品关系仍未决                                           | intent；package/release 配置                                               |
| 旧文中缺乏依据的长期方向                                                                          | **保持 Open**：维护规范归 workflow；兼容与扩展意图需明确的项目决策                                             | 入口；实现证据与明确的不确定性                                             |

## 四轮 adversarial architecture review

以下 review 针对完成后的记录集进行；静态推翻与 runtime 反例分列，不把同一测试重复三次称作独立验证。

| Round / 攻击目标          | 实际反证路径                                                                                                                                                                                               | 发现与模型修正                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Authority               | 追 `checker-ownership-resolution` 每个 mutation；对照 named solution discovery 与 frozen checks；搜索 ArchitectureValidationWorkflow 的生产 caller；执行 ownership/generated-graph 回归                    | 后期 final checker 不重写语义；solution constraints 不能一概放 freeze 后；typed validation registry 尚非 CLI 统一入口；locked 类型也不等于 runtime 认证。修正 phase 与 authority 声明 |
| 2 Identity / relation     | 对照 path helpers 与 canonical package/namespace；追 native fact→recording→edge→color→SCC；用 ambient/paths/included/external/augmentation 和 external symlink closure 反例                                | lexical path≠realpath；ambient 可带 compiler-membership；resource observation≠TypeEvidence；implicitRefs/solution equality 无需 import。删除“全部依赖是同一种边”的解释                |
| 3 Generation / lifecycle  | 追 executor command settlement→join→advance，manager replan，slot promise identity；检查 Vue shared slot、custom providers 与 dispose；运行 snapshot/token/symlink repro 和 materialization/preflight 回归 | provider generation 可独立推进；Vue slot 跨 manager 共享；custom providers 不自动转默认；cache 不普遍含 content；ensure-after-dispose 无统一拒绝。I09 降为 Partially executable       |
| 4 Knowledge / enforcement | 对原 PCR 全部主题登记 keep/narrow/rewrite/move/remove/open；检查 source links、Mermaid 时序和 evidence matrix；阅读 architecture-boundaries 的扫描器匹配范围                                               | 不把局部 AST guard 宣称全程序无环；不从 passing tests 推导未来意图；入口/schema/tuple去重；stale v7/root-facts/boundary-independent 等旧论断实际移除                                  |

复查受影响结论：I02 对照 frozen+final owner 组合；I03/I05/I09 使用修正后完整三轮外部实验；I06/I07 同时检查 implicit/solution positive paths 与 declaration negative paths；I09–I12 对照现有 lifecycle/mutation/query 回归。没有以“模型看起来统一”为理由抹去当前例外。

## Findings

| ID  | Severity / disposition / category                               | 证据、影响与处理                                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | **P1 / BLOCKING（旧知识发布，已修正）/ documentation drift**    | root-facts/full Program 与 boundary-independent 两组直接矛盾会误导 reference repair 和 cache设计；生产 provider/identity 与 native repro 推翻旧文。当前 owner 已重写                                                                                                                                                                                           |
| F02 | **P2 / NON-BLOCKING / architecture risk + missing enforcement** | preflight ensure-after-dispose 没有统一 runtime gate，外部 cache reuse 也无通用 content版本；内部 pipeline 自建 preflight 没有与 CLI 相同的 finally dispose。CLI check/standalone 与 owned graph export 有明确释放，未证实当前 CLI 结束后误用。直接重复调用内部 API 或支持 daemon 前，先定 ownership/lifecycle contract，再补入口拒绝与 mutation-version tests |
| F03 | **P2 / NON-BLOCKING / unresolved integration boundary**         | application typed ArchitectureValidationWorkflow 存在，但无当前生产 caller；直接 runner 与该抽象并存。不能把理想接线写成事实。是否统一及迁移范围由 human 决定，本次不接线、不删除                                                                                                                                                                              |
| F04 | **P3 / NON-BLOCKING / partial architecture guard**              | architecture-boundaries 只覆盖所解析的相对静态 runtime imports 和特定 named calls；alias/dynamic/namespace 等未普遍追踪。当前未发现被它漏过且实际造成错误的具体环；今后引入这些语法边界时扩充针对性反例，不冻结目录布局                                                                                                                                        |
| F05 | **P3 / NON-BLOCKING（已修正）/ documentation drift**            | manifest 版本与 snapshot v7过时、root map泛化 verified、tuple重复、缺乏依据的产品意图归因；分别改源链接、v8/独立schema、证据范围与 Open 问题                                                                                                                                                                                                                   |
| N01 | **NO DEFECT / semantic distinction**                            | TypeScript semantic authority + vue-tsc final owner、ambient+compiler-membership、concrete output不回推source、pure schedule SCC，均是当前合法语义，不能当不一致修掉                                                                                                                                                                                           |
| N02 | **NO DEFECT / validation environment**                          | 8 个 CLI 断言失败的 stderr 指向 tsx `listen EPERM`；原样解除 IPC 沙箱后两组73项通过。不是已观察到的 Limina freshness regression                                                                                                                                                                                                                                |

没有由本次证据确立的 production P0/P1 defect；这不等于全系统不存在 defect。F02–F04 是带边界的风险/缺口，未擅自实施生产修复。没有新增 executable guards：已有 guards 覆盖核心语义，剩余缺口涉及待决定的契约或会冻结实现结构。基线中的 native repair tests 是已有证据，不是记录审查新增的守卫。

## Validation

本次操作环境：macOS arm64，Node **v24.21.0**，pnpm **11.9.0**，TypeScript **6.0.3**，Vitest **4.1.7**，tsx **4.22.4**。Nx targets 由 `NX_DAEMON=false pnpm nx show project limina` 实际查询。所有 tests 均使用当前 working tree；没有换回 HEAD。

### 外部最小复现

位置：`$EVIDENCE_ROOT/limina-architecture-knowledge-20260911/`。`run.mts` 直接导入当前 Limina source 与已安装 TS，建立 ESM/NodeNext fixtures；`results.json` 保留 raw facts/observations。执行命令（cwd 为 docs-islands）：

```sh
node --import tsx $EVIDENCE_ROOT/limina-architecture-knowledge-20260911/run.mts
```

| 实验               | Intent / 与其他轮次的独立性                                                | 条件与结果                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline           | 挑战 resolution 能否与 admission 分离                                      | `main.ts` import 不在 root/reference 的本地 source，workspace boundary 含 provider；resolved checker-source + source-semantic，admission excluded           |
| Round 1            | 改类型供给、resolution 与 compiler membership，不改变 lifecycle            | ambient+paths→compiler-membership；explicit included/external controls→null；augmentation→checker-source/source-semantic。独立 TS Program symbol 检查一致   |
| Round 2            | 改 roots provenance 与 occurrence 产生通道，不依赖 Round 1 的 ambient case | extends relative types 成为 importer；react-jsx/react-jsxdev/react/preserve 加 jsxImportSource，与 TS host 实际 synthetic requests 一致；不凭 JSX mode 预测 |
| Round 3            | 改物理拓扑、workspace admission boundary 与 cache key，独立于符号/JSX输入  | preserveSymlinks false/true × inner declaration governed false/true：ambient→missing；shared cache 保留两份 boundary-distinct facts；无 virtual source edge |
| Lifecycle controls | 改 source text、对象 token 与 symlink mutation 路径                        | disposed live context 拒绝方法；历史 snapshot 保留 a.js，新 context 得到 b.js；同数字 namespace 拒 cross-token plan；nested symlink authority 拒绝          |
| CLI control        | 走真实 binary 与 persisted query                                           | published aborted attempt 后 JSON query exit1/status aborted；不返回旧 inventory                                                                            |

初次 Round 3 错把 `resource` observation 当成 TypeEvidence，断言被推翻；源码表明 `virtual:` runtime classification 也可产生 resource。修正命题为“admission boundary 改变 native evidence、cache 隔离且不生成 source edge”，再完整运行 baseline + 三轮；全部通过。CLI probe 初稿还导入了错误 barrel，改成生产实际 `check-attempt-io` 后成功；这是 harness 错误，不是产品 defect。

这些结果仅确认表内 native/lifecycle 条件。没有借 TS 6.0.3 实验宣称所有支持 TS/framework 版本都相同；framework能力结论主要是 source-established，加当前已安装 tuple 的仓库回归。

### 仓库回归命令

```sh
NX_DAEMON=false pnpm nx run limina:test:unit -- src/__tests__/architecture-boundaries.spec.ts src/__tests__/native-reference-repair.spec.ts src/__tests__/project-dependencies.spec.ts src/__tests__/preflight.spec.ts src/__tests__/mutation-boundary.spec.ts src/__tests__/materialization-recovery.spec.ts src/__tests__/check-attempt.spec.ts src/__tests__/invocation-snapshot.spec.ts
NX_DAEMON=false pnpm nx run limina:test:unit -- src/__tests__/generated-graph.spec.ts src/__tests__/typescript-semantic-context.spec.ts src/__tests__/workspace-validation.spec.ts src/__tests__/execution.spec.ts src/__tests__/svelte-semantic.spec.ts src/__tests__/vue-semantic.spec.ts src/__tests__/astro-semantic-resolution.spec.ts
NX_DAEMON=false pnpm nx run limina:test:unit -- src/__tests__/check-attempt.spec.ts src/__tests__/execution.spec.ts
NX_DAEMON=false pnpm nx run limina:test:unit
```

前两组分别为 **66 passed / 7 failed / 1 skipped**、**314 passed / 1 failed**。原样两文件 sandbox 重跑仍失败；临时 child_process diagnostic preload 捕获 7 个 check-attempt 子进程的 `tsx listen EPERM`。解除该 IPC 限制后原样两文件重跑 **73 passed**。诊断 preload 位于外部临时目录，没有改 tests；正式通过的重跑不带 preload。`node bin/limina.js --help` 成功；外部 fixture 的 `check --issues --format json` 返回预期 exit1/aborted。

完整 unit 在相同 working tree、解除 IPC 限制下完成：**92 files passed，1873 tests passed，2 skipped**。两个跳过项为仅 Windows 运行的 mutation-boundary 与 standalone-invocation case；本机未覆盖这些分支。文档检查：11 个修改文件的 Prettier check 通过；Markdown parser 检查 217 个相对链接与 heading anchors，无错误；4 张 Mermaid 已按源码人工检查节点/边/时序，未运行 Mermaid renderer。非 fixing ESLint 实际运行返回 11 个 ignored warnings，当前配置没有检查这些 Markdown，不能把它报告为 lint coverage。初稿 Prettier 检出 8 个格式问题，只格式化外部草稿后重新检查通过。未执行 integration/typecheck/build/smoke/package/release/Limina check：本次只改 PCR 与维护指引，不修改 governed source/config/tests；保持基线实现修复不变。完整 unit 用于挑战本次跨域模型，不替代上述未执行的检查。

## Change 与 ownership

重写 `limina.md` 为入口，新增六个有独立责任的 PCR topics；更新 README map、root architecture/technology 的路由与去重；在 package AGENTS 添加未来变更的 invariant impact 路由。`intent.md` 与 dependency-admission 保持原文。

历史保留检查确认：3116 个基线文件中有 3111 个内容指纹不变，仅五个已有 PCR／指引路径及六个新 PCR 页面在范围内。Index 与基线完全相同；既有文章、生产源码、测试及无关 untracked 文件均保留。记录审查没有 stage。`git diff --check` 与 `git diff --cached --check` 通过，并检查了最终 Git status。临时证据日志不是仓库 authority；当前复跑应使用 source/test 锚点与新的指纹。

## 文档与边界检查命令

以下 `FILES` 是本次实际检查的 11 个文件，后续复跑可直接使用。没有执行 broad format 或 fixing lint。

```sh
FILES=(.agents/docs/README.md .agents/docs/architecture.md .agents/docs/technology-stack.md .agents/docs/limina.md .agents/docs/limina-system-model.md .agents/docs/limina-semantics.md .agents/docs/limina-lifecycle.md .agents/docs/limina-invariants.md .agents/docs/limina-architecture-workflow.md .agents/docs/limina-architecture-audit.md AGENTS.md)
pnpm exec prettier --check "${FILES[@]}"
pnpm exec eslint "${FILES[@]}"
git diff --check
git diff --cached --check
git status --short
```

历史链接／保留检查 helper 是外部资产，此处不提供。应重新检查相对链接与标题锚点，比较新的 index／内容指纹；不得把旧 helper 路径视为可运行的仓库工具。

诊断复跑使用过外部子进程 stderr 捕获 hook；该 hook 未检入，也不是正常复跑的必要条件。临时 Markdown 草稿单独格式化，没有广泛修改仓库。最终 source claims 通过 `rg` 追调用者／字段并读取生产实现检查；这些静态结构结果仍单列 Source-established。
