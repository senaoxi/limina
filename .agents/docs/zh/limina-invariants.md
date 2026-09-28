# Limina Core Invariants

[English](../limina-invariants.md) | [简体中文](./limina-invariants.md)

这里登记 12 条会影响系统正确性的性质。它们来自当前实现，不声称永久设计意图。`Confirmed` 表示生产类型/控制流直接支持；运行样例及未覆盖条件见[审计](./limina-architecture-audit.md)。完整定义分别归[系统模型](./limina-system-model.md)、[语义事实](./limina-semantics.md)、[生命周期](./limina-lifecycle.md)，本页拥有 invariant 的约束、解释与 evidence matrix。

**Enforcement strength**：Strongly executable 表示作用范围内有直接类型或运行时 guard，并有反例测试；Partially executable 表示主要生产路径受保护，但仍依赖调用方生命周期/输入契约；Prose-only 表示没有机械 guard。测试存在和本次测试通过分开记录，不以行数或测试数量代替覆盖判断。

## I01 — 治理 authority 来自 validated workspace

- **Statement / Applies when**：所选配置最近的 package.json 固定治理根及配置解析 generation 中已验证的 manifest fact，只有同根 workspace 语义决定成员分类。graph/source/proof 使用该根激活的包投影 authority；raw package discovery 仅为输入证据。对已激活 package，重复 physical identity、非法 overlap/boundary 必须先失败。
- **Problem**：被排除或另属 nested workspace 的包若仍参与 owner 选择，就可能错误授权 import 或写输出。
- **Root cause**：package manager 发现范围、逻辑目录和治理范围是不同集合；symlink alias 又会使一个物理包有两个名字。
- **Enforcement / Why it works**：[validated create](../../../packages/limina/src/core/workspace/validated/create.ts) 先校验 exclusions、islands、overlap、package identities 与 output authority，后发布 context；[package-identities](../../../packages/limina/src/core/workspace/validated/package-identities.ts) 拒绝重复 canonical directory。下游运行时 package/owner/boundary 查询通过 WorkspaceRegionPathIndex / WorkspaceLookupIndex 使用 canonical Governance Trie；package/owner 数组不能通过 directory containment 重建该 authority。construction 与局部关系的边界见 [region index owner](./limina-system-model.md#validated-region-的内部查询索引)。
- **Concrete example**：`workspace-validation.spec.ts` 的 package alias / nested boundary 用例挑战同一物理包被双重激活；另一个无 name 的包仍可拥有 source，只有依赖 name 的 graph export 要求名称。`workspace-directory-index.spec.ts` 中，A activation → B cut → C activation 必须经 path index 与 package/owner lookup facade 均返回 A / null+B / C，并覆盖 external packages。`workspace-package-scope.spec.ts` 中，无名称 activated package 的真实路径与子目录 alias 均不能获取包外祖先的名称；最近 manifest 的路径保留所选 package 的原有身份。
- **Protected property**：治理归属唯一、范围隔离、输出授权不扩大。
- **Evidence / Strength / Confidence**：[workspace tests](../../../packages/limina/src/__tests__/workspace-validation.spec.ts)、[region/facade guards](../../../packages/limina/src/__tests__/workspace-directory-index.spec.ts)、[package-scope guards](../../../packages/limina/src/__tests__/workspace-package-scope.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：canonical package 校验不能证明任意 config alias 都已物理合并；name-based graph 和 path-based source owner 不能合成一个 identity。

- **Discovery guard**：`governance-root.spec.ts` 挑战配置选择、最近 manifest fail-fast、祖先独立性、共享根 manifest 内容、workspace manager 必需与 single manager 可选。`workspace-discovery.spec.ts` 保留同根 descriptor 优先级、显式 manager 优先、所消费声明投影、manager-specific selection 和 lexical alias。`single-package-knip.spec.ts` 将 validated canonical identity 贯通无名称 dependency/owner 匹配，并拒绝重复物理根。即使 manager identity 缺失或开启 nameless-scope extension，嵌套 workspace 声明仍是 hard cut。兼容边界见[发现 authority](./limina-system-model.md#工作区发现-authority)。

## I02 — semantic authority 不随 final checker owner 改写

- **Statement / Applies when**：managed type config 的 semantic authority 在 facts convergence 后 freeze；后续 promotion/coloring/fallback/finalization 不能改变它。成功 finalization 为 leaf 确定唯一执行 owner。
- **Problem**：为共享 declaration build 选用 Vue checker，可能错误地把原生 TS import 改为 Vue module semantics。
- **Root cause**：解释源码与安排构建使用不同 authority，二者都曾容易被称为 owner。
- **Enforcement / Why it works**：[ownership types](../../../packages/limina/src/core/build-graph/checker-ownership-types.ts) 分字段；[semantic authority](../../../packages/limina/src/core/build-graph/checker-semantic-authority.ts) 限定 lock evidence、保存 frozen 值并在 coloring/finalization 后比对；[resolution](../../../packages/limina/src/core/build-graph/checker-ownership-resolution.ts) 先收齐 requirements 再应用锁。执行选择无法冒充新的语义证据。pending inference 必须同时具有 missing evidence 与合格 pending-framework-candidate；native source requirement 本身不能锁定 framework authority。
- **Concrete example**：`generated-graph.spec.ts` 中 TS app 导入 Vue project 的 theme TS 后可由 `vue-tsc` 构建，同时 semantic/frozen authority 保持 TypeScript。
- **Protected property**：语义稳定、import 顺序不隐藏跨框架冲突。
- **Evidence / Strength / Confidence**：[generated graph tests](../../../packages/limina/src/__tests__/generated-graph.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：freeze 是快照与校验机制，不是全对象 deep freeze；named solution 的 explicit ownership constraints 在 discovery 阶段已经存在。

## I03 — importer roots、Program admission 与 resolution 分开

- **Statement / Applies when**：原生 dependency collection 只枚举 effective importer roots，使用 bounded Program 解释它们；resolver 命中普通 workspace implementation 不自动使其进入 Program。
- **Problem**：枚举 transitive Program closure 会把 provider 的 imports 当成 consumer 的 imports；只用 parsed files 又会遗漏 relative `types` declaration roots。
- **Root cause**：compiler 为解释一个项目加载的环境，比项目实际治理的 importer 集合更大。
- **Enforcement / Why it works**：[effective-roots](../../../packages/limina/src/core/typescript-semantic/effective-roots.ts) 明确输入；[admission](../../../packages/limina/src/core/typescript-semantic/admission.ts) 记录加入理由，workspace boundary 拦住普通外部来源越权；provider 迭代 context.fileNames。足够的类型环境与受控 importer enumeration 可以并存。
- **Concrete example**：`main.ts` import `provider.ts`，后者不在 root/reference 输入时仍保留物理 resolution 和 source-semantic 候选，但 evidence 为 missing，admission 为 excluded。raw reference redirect 可提供实际输出 declaration，而原 source 仍为 excluded；继承 relative `types: ['./env']` 的 `env.d.ts` 则成为 importer root。
- **Protected property**：完整但不外溢的输入归属、独立的 provider reference 证据。
- **Evidence / Strength / Confidence**：[native repair tests](../../../packages/limina/src/__tests__/native-reference-repair.spec.ts)、[bounded context tests](../../../packages/limina/src/__tests__/typescript-semantic-context.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：raw references、explicit path/types、libs 和合法 external declaration closure 仍可被 admission 接纳；full mode 不等于 roots-only，snapshot 的 roots membership 不等于旧 Program 的完整 membership。

## I04 — locked dependency fact 必须保持 checker occurrence 与 provenance

- **Statement / Applies when**：locked project dependency 路径保留 occurrence kind/locator、compiler channel/mode/redirect、checker target 与 evidence；generated fact 必须有可信 source mapping，target path 和 semantic kind 一致，miss 不被 Oxc 补成 semantic target。
- **Problem**：同一个 specifier 在 import/require condition 下指向不同目标；宽松 source map 或 fallback 会把一个合法物理文件冒充 checker 实际看到的依赖。
- **Root cause**：specifier/path 是不完整 identity，runtime resolution 与 checker program 观察也不同。
- **Enforcement / Why it works**：[identity](../../../packages/limina/src/core/typescript-semantic/identity.ts)、[checker-resolution-provider](../../../packages/limina/src/core/import-analysis/checker-resolution-provider.ts) 和 [dependency-record](../../../packages/limina/src/core/project-dependencies/dependency-record.ts) 分别保护 occurrence、locked resolver route 和 target/evidence 一致性。框架 strict-source-map 检查只接受可归因片段。
- **Concrete example**：Svelte conditional export 用例用 occurrence mode 选择 import/require branch；prepared declaration target 配 checker-source evidence 必须失败，不能凭 `.vue` 原始扩展重建另一目标。
- **Protected property**：checker fidelity、provenance 可追踪、失败不扩大 authority。
- **Evidence / Strength / Confidence**：[project dependencies tests](../../../packages/limina/src/__tests__/project-dependencies.spec.ts)、[Svelte tests](../../../packages/limina/src/__tests__/svelte-semantic.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：pending physical candidate bootstrap 和 runtime-like inspection 有别的 Oxc 路径，但两者都不重新解释带 query 或 fragment 的 specifier；该语法属于 occurrence identity，只有 checker 能赋予其含义。runtime filesystem check 与 missing-provider fallback 也会在路径归一化前停止，因为后接 `..` 的 query/fragment 片段可能在归一化中被消去。TypeScript 类型要求 locked 不等于任意 JS 输入均有 runtime authentication。
- **Observation/cache 边界**：分类不能丢弃 checker target、runtime evidence 或归属输入。[证据快照](../../../packages/limina/src/core/project-dependencies/evidence.ts)保留冻结的 occurrence/context/generation 及独立证据来源。未观察不等于缺失，graph 消费者不能增加 resolver 补齐。未消费 exports 不属于依赖正确性；发布与类型契约是独立检查。

- **静态块边界**：类静态块具有独立的 var 作用域，同时保留词法父级。块内 var/let/function 绑定不能遮蔽兄弟静态块或类之后的外部 require 与不可变 createRequire 别名。[导入分析回归](../../../packages/limina/src/__tests__/import-analysis.spec.ts) 覆盖这些边界及 require.resolve。

## I05 — TypeEvidence 与 referenceRequirement 独立保真

- **Statement / Applies when**：原生事实分别记录类型供给与 compiler relation 需求；evidence 表达 bounded scope 中实际 provider（包括 missing），requirement 表达候选 compiler relation。完整真值表归[语义事实](./limina-semantics.md#occurrence证据与建图需求)。
- **Problem**：为了建边重分类 ambient 会说错类型来源；看到 ambient 就停止建边又会漏掉必要 compiler membership。
- **Root cause**：symbol 的类型供给和 compiler 对 source implementation 的输入关系并不是同一命题。
- **Enforcement / Why it works**：[dependency-fact](../../../packages/limina/src/core/typescript-semantic/dependency-fact.ts) 区分物理 resolution、原目标 admission、provider proof 与 requirement；[provider evidence](../../../packages/limina/src/core/typescript-semantic/provider-evidence.ts) 检查 occurrence Symbol/Program 对象身份及实际 compiler input，Core 保留原生结果；[native-dependency](../../../packages/limina/src/core/project-dependencies/native-dependency.ts) 保留 fact，只有 ambient 且无 requirement 才作为纯 observation。
- **Concrete example**：ambient module 加 `paths` 指到尚未纳入 compiler 输入的本地 implementation，得到 ambient + compiler-membership；把 implementation 明确加入 roots 后 requirement 为 null。已 admitted 但无 module Symbol 的 script 保留 missing + source-semantic；实际 reference output 提供记录输出路径的 concrete-declaration，不新增 source requirement。`import raw from './foo.ts?raw'` 配 `declare module '*?raw'` 得到 ambient + null，即使 `foo.ts` 存在也没有 source relation；没有该声明时保持 missing + null，不会被修复成 `./foo.ts`。当 checker 为解析到 `theme.css.ts` 的 `../b/theme.css` 证明了 requirement 时，看到 missing resource 的 runtime classification 不能取消它。
- **Protected property**：类型解释与声明建图同时准确。
- **Evidence / Strength / Confidence**：[native provider evidence](../../../packages/limina/src/__tests__/native-provider-evidence.spec.ts)、[native repair](../../../packages/limina/src/__tests__/native-reference-repair.spec.ts)、[generated graph](../../../packages/limina/src/__tests__/generated-graph.spec.ts)、[type evidence](../../../packages/limina/src/__tests__/type-evidence.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：referenceRequirement 只是下一阶段输入，还须唯一 actual owner、deny 与 relation 分类；resource observation 不必含 TypeEvidence；没有 requirement 的 ambient 供给是 semantic-only observation，不是 resource。本版本不存在宿主 query 语义；query 或 fragment 永远不是第三种 relation kind。

## I06 — 声明、调度与 artifact attribution 不互相升级

- **Statement / Applies when**：declaration-provider 可产生 generated TypeScript references；framework-schedule 只表达 source execution dependency；物理 declaration target 或实际 declaration provider 停止新增 source relation，即使仍保留原 source resolution 或物理 declaration 缺少 evidence。
- **Problem**：把所有“依赖”画成一种边，会给 Astro/Svelte 制造不存在的 declaration project，或把已经产出的 `.d.ts` 重新连回 source 形成伪依赖。
- **Root cause**：类型供给、源码编译需求、执行先后和输出归属需要不同消费者。
- **Enforcement / Why it works**：[reference-recording](../../../packages/limina/src/core/build-graph/reference-recording.ts) 要求 normalized requirement；[framework inference](../../../packages/limina/src/core/build-graph/framework-reference-inference.ts) 仅接受符合条件的 source implementation；[framework edge](../../../packages/limina/src/core/build-graph/framework-dependency-edge.ts) 拒绝 declaration path。各 edge type 拥有不同字段和投影。
- **Concrete example**：consumer 命中 managed output `.d.ts`，lookup 可解释它来自哪个输出，但不添加 sourceToBuild reference；Astro/Svelte source prerequisite 可以参与 schedule，却不生成 tsconfig references；ambient compiler-membership 不进入 scheduling。missing declaration companion 不得 bootstrap Oxc 或提升 consumer checker。没有 checker target 的带 query 框架组件（如 `./Widget.svelte?x`）不得 bootstrap Oxc、给 consumer 染色或产生 edge。
- **Protected property**：声明关系真实、构建职责分明、artifact 消费不重开源码边界。
- **Evidence / Strength / Confidence**：[generated graph](../../../packages/limina/src/__tests__/generated-graph.spec.ts)、[dependency graph tests](../../../packages/limina/src/__tests__/dependency-graph.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：raw references、solution closure、`implicitRefs` 各有独立 evidence，不要求全部 graph edges 都源自 import；exported dependency graph 也不是 task graph。

## I07 — 声明 component 使用 exact checker identity

- **Statement / Applies when**：成功的 declaration-provider 两端 exact checker identity 相同，`cacheReuse` 为 reusable；参与执行的 SCC 不能含内部 declaration relation，纯 framework scheduling SCC 可以执行。
- **Problem**：不同 checker 的中间声明缓存不可仅因语义 family 相近而视作一个构建；禁止所有环又会错杀纯 framework 顺序分组。
- **Root cause**：identity equality 与 execution dependency direction 是不同关系。
- **Enforcement / Why it works**：[build coloring](../../../packages/limina/src/core/build-graph/checker-build-coloring.ts) 将合法 declaration/solution equality 组成无向 component，单色传播、多色拒绝，再由 [graph-validation](../../../packages/limina/src/core/build-graph/graph-validation.ts) 检查最终边；dependency plan 区分 declaration subset 后检查 SCC。
- **Concrete example**：已明确为 tsc 和 tsgo 的两个 leaf 不能通过 declaration edge 混色；全部框架调度边组成的 SCC 则不因此产生 declaration cycle error。
- **Protected property**：编译缓存兼容与执行计划的可解释性。
- **Evidence / Strength / Confidence**：[generated graph](../../../packages/limina/src/__tests__/generated-graph.spec.ts)、[execution](../../../packages/limina/src/__tests__/execution.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：registry 的局部 cache compatibility helper 可比 final graph guard 宽，不能单独引用 helper 推翻最终约束；deny 和 concrete declarations 不参与该 equality relation。dependency plan 先滤同 target 自依赖，SCC guard 实际检查两个及以上成员的 component，不是任意图自环检测器。

## I08 — source ownership 与 checker coverage 分别证明

- **Statement / Applies when**：proof 在配置的 source boundary 内，将 expected source 与 checker 实际覆盖分别收集后比较；一个文件有 package/config owner，不足以证明它被所选 checker 覆盖。
- **Problem**：显式选择只理解 Astro 的 checker 后，邻接 Svelte 文件仍可能属于包，却没有进入该 checker 的有效 roots。
- **Root cause**：治理想覆盖的 source 与 checker observation capability 不同。
- **Enforcement / Why it works**：[source-files](../../../packages/limina/src/proof/source-files.ts) 收集 expected source；[coverage](../../../packages/limina/src/proof/coverage-collection.ts)、[source coverage findings](../../../packages/limina/src/proof/source-coverage-findings.ts) 与 framework coverage 比较差集和冲突。前置 route/config 阶段失败时不伪造后续完整证明。
- **Concrete example**：显式 Astro scope 中出现未被 checker roots 覆盖的邻接 framework 文件，不仅凭“文件存在”拒绝 graph，而由适用的 proof source boundary 检查 coverage 缺口。
- **Protected property**：治理覆盖声明不超出实际 checker 能力。
- **Evidence / Strength / Confidence**：[proof tests](../../../packages/limina/src/__tests__/proof.spec.ts)、[generated graph tests](../../../packages/limina/src/__tests__/generated-graph.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：配置 include/exclude/allowlist 决定证明范围；source、graph、proof 通过不证明每个外部工具、package output 或 release 检查均通过。

## I09 — 事实重用与异步结果受 provider 生命周期约束

- **Statement / Applies when**：生产 preflight 在 command mutation 后更新 generation/providers/cache；materialization replan 可只更新 provider generation。receipt 仅提交给当前 slot；缓存不能仅因 path 相同跨有效期当作新事实。
- **Problem**：命令修改 source 后旧 graph 仍被复用，或旧 materialization promise 晚到覆盖新 receipt。
- **Root cause**：path identity 不是内容版本，analysis generation 与 provider generation 也不总相同。
- **Enforcement / Why it works**：[manager](../../../packages/limina/src/preflight/manager.ts) 替换 provider set；[scheduler](../../../packages/limina/src/execution/scheduler-loop.ts) 等运行任务结束后推进；[materialization](../../../packages/limina/src/preflight/materialization.ts) 检查 slot/promise identity。facts snapshot 保留历史，live context 及时 dispose。
- **Concrete example**：捕获 `import './a.js'` 后编辑成 `b.js`，旧 snapshot 仍表示旧观察，新 context 才看见新输入；两个相同数字 generation 的 namespace token 仍不同。
- **Protected property**：同次分析一致、异步结果不串代、资源回收可归责。
- **Evidence / Strength / Confidence**：[preflight tests](../../../packages/limina/src/__tests__/preflight.spec.ts)、[context tests](../../../packages/limina/src/__tests__/typescript-semantic-context.spec.ts)；**Partially executable / Confirmed**。
- **Boundaries**：外部复用 caches 必须尊重 lifecycle；key 没有普遍 file-content digest；manager ensure-after-dispose 没有统一 guard；Vue active slot 的共享模式另见生命周期页。

## I10 — mutation 权限不能从路径字符串推导

- **Statement / Applies when**：managed artifact/managed checker output mutation 需要对应 namespace/plan 或 output authority，并验证 logical 与 physical binding；同 root/generation 字面值不能替代 authenticated token。
- **Problem**：路径看起来在 `.limina` 或 outDir 下，实际沿 symlink 指向其他目录；复制结构相同的 plan 可能使用另一代权限。
- **Root cause**：字符串 containment、文件系统 identity 和 object provenance 属于三种身份。
- **Enforcement / Why it works**：[namespace-core](../../../packages/limina/src/domain/artifacts/namespace-core.ts) 与 [plan](../../../packages/limina/src/domain/artifacts/plan.ts) 认证 object/token；[authority-create](../../../packages/limina/src/utils/mutation/authority-create.ts) 与 [identity](../../../packages/limina/src/utils/mutation/identity.ts) 检查 trusted base、scope、symlink chain 和 binding drift。
- **Concrete example**：给同 root、generation=0 的新 namespace 使用旧 namespace 的 plan，被拒绝；trusted base 内的 `link/result` 经过 symlink 时不能创建隐含写权限。
- **Protected property**：写入范围受控、权限不因名称相似或 stale object 扩大。
- **Evidence / Strength / Confidence**：[mutation tests](../../../packages/limina/src/__tests__/mutation-boundary.spec.ts)、[materialization recovery](../../../packages/limina/src/__tests__/materialization-recovery.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：raw external build、export 用户文件和 migration 是不同 writer contract；不能推广成所有写入经过同一个 namespace，或绝无 OS race。

## I11 — artifact 发布失败留下可识别的不完整状态

- **Statement / Applies when**：生产 generated plan 在 canonical writer lease 下发布；revision drift 只能有限 replan；写入前 marker、manifest-last、desired tree verification 与 reader recovery refusal共同防止把半成品当成成功。
- **Problem**：进程中途退出后 manifest 与生成文件可能来自不同计划；另一个运行若继续读就获得混合 graph。
- **Root cause**：多文件更新不是单个 atomic rename。
- **Enforcement / Why it works**：[materializer](../../../packages/limina/src/core/build-graph/materializer.ts) 在 lease 内验证 revision、写 marker、发布文件、最后 manifest，验证后去 marker；失败保留 marker，下个 writer 全量恢复。reader 有明确不可用状态。
- **Concrete example**：`materialization-recovery.spec.ts` 注入写入中断后 reader 不能返回正常结果；下一 writer 写完整新 plan，清掉旧 owned paths 并验证后恢复。
- **Protected property**：可检测的发布完整性与有限恢复范围。
- **Evidence / Strength / Confidence**：[recovery tests](../../../packages/limina/src/__tests__/materialization-recovery.spec.ts)、[preflight](../../../packages/limina/src/__tests__/preflight.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：该协议不是多文件原子事务；内部 unrevisioned plan 和 migration 不获得同一 revision/lease 保证；无 consumer 第二次 revision handshake。

## I12 — 最新 issue 查询不能冒充新检查或复活旧成功

- **Statement / Applies when**：latest check issue query 必须与最新 published attempt 的 freshness 一致；running、aborted、persistence-failed、corrupt/inconsistent 等状态禁止返回旧 completed inventory。独立 invocation query 使用其独立身份。
- **Problem**：最新检查失败或根本没跑完时，用户仍看到上轮“零问题”，会据此误判当前 source。
- **Root cause**：inventory 的存在不等于它代表最新 attempt；完成写入也可能只完成了一半。
- **Enforcement / Why it works**：[attempt IO](../../../packages/limina/src/source-check/snapshot/check-attempt-io.ts) 维护 sequence、identity 与 digest；[attempt query](../../../packages/limina/src/source-check/snapshot/check-attempt-query.ts) 校验 freshness；CLI query 使用独立 config anchor：显式配置缺失是合法状态，最近 manifest 仍须验证，并且不运行 loader、manager adapter 或 preflight。`single-package-cli.spec.ts` 删除配置后实际回放绝对命令，对比持久化状态与配置 import 观测。人类和机器格式均报告 unavailable，而不是空成功。
- **Concrete example**：先有 completed inventory，再发布一个 aborted attempt，human/JSON/NDJSON 查询必须显示 aborted/unavailable 并退出失败；corrupt latest metadata 也不允许分配新 sequence。
- **Protected property**：结果新鲜度、失败可见性、自动化消费者不会误用旧成功。
- **Evidence / Strength / Confidence**：[check attempt](../../../packages/limina/src/__tests__/check-attempt.spec.ts)、[invocation snapshot](../../../packages/limina/src/__tests__/invocation-snapshot.spec.ts)、[execution](../../../packages/limina/src/__tests__/execution.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：config/plan 验证可在 attempt publication 前失败，因此不能承诺每个 CLI error 都产生新 attempt；check/source/invocation 是不同 schema，不可用一个 version 常量替代。

## Evidence matrix 与 guard 决策

上面的链接提供精确 production/test owner；下表描述测试挑战什么，以及改动后要检查的 observable。测试名称/路径只是检索锚点，真实结果见 audit。

| Invariant | 主要 executable enforcement                                             | 反例机会 / reviewer 观察                                                         | 代表性回归 guard                                                                                                                   |
| --------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| I01       | validated context、canonical Governance Trie、workspace/facade guards   | cut、重入、external package 与 canonical identity                                | 增强现有重入 guard：package/owner facade 与 path index 一致                                                                        |
| I02       | authority state / freeze assertions / coloring tests                    | TS semantic + Vue final owner、依赖顺序与冲突                                    | missing native source 不锁框架；合格 component candidate 可以锁定                                                                  |
| I03       | effective roots / inclusion ledger / native compiler differential tests | relative types、external closure、source excluded 但可 resolution                | built/unbuilt reference 的 provider identity 与原 source admission                                                                 |
| I04       | occurrence identity / locked dispatch / prepared consistency assertions | import/require condition、mapping ambiguity、kind mismatch、query/fragment       | 完整 specifier 到达 checker；query 与 fragment 不被拆分，也不经 Oxc 救回                                                           |
| I05       | NativeDependencyFact discriminated fields / symbol evidence tests       | ambient+membership、included/external controls、augmentation、带 query 的 source | Program/Symbol identity、admitted script、实际 declaration provider、ambient membership、ambient query                             |
| I06       | edge union / reference-recording requirement / declaration guards       | concrete managed output、framework-only schedule、implicit ref、带 query 的组件  | 物理 declaration companion 阻止 bootstrap；missing source 保留真实 schedule edge；已证明 requirement 不被 resource 样 runtime 取消 |
| I07       | equality coloring / final graph guard / SCC declaration guard           | exact checker conflict、pure schedule cycle                                      | 无：局部 helper 与终态 guard 的差异应解释，不误改 helper                                                                           |
| I08       | proof phase、expected vs coverage set comparisons                       | 不可观察的邻接扩展、uncovered/duplicate source                                   | 无：配置边界必须由人审，不增 blanket exclusion                                                                                     |
| I09       | scheduler generation、provider replacement、slot identity、dispose      | stale promise、replan 不推进 task gen、外部 stale cache                          | snapshot 一致性、Program/query 数量、释放及 alias 变化后的新 owner 索引                                                            |
| I10       | namespace/plan auth、physical mutation guard                            | forged/cross-token plan、symlink escape、binding drift                           | 无：已有异常与 filesystem tests                                                                                                    |
| I11       | writer lease、revision、marker、verify、recovery tests                  | 中途写失败、并行 revision drift、stale ownership ledger                          | 无：现有 semantic recovery guard 更稳                                                                                              |
| I12       | sequence/digest/freshness、query/invocation guards                      | torn pair、newer running、corrupt latest、old completion                         | 无：现有 end-to-end CLI tests                                                                                                      |

12 条均有机械连接；11 条在明确作用域内 Strongly executable，I09 依赖额外生命周期契约，列 Partially executable。没有把 Prose-only 的未来愿望伪装成已建立 core invariant。值得机器化但本次不直接实施的部分：若 human 决定统一 disposed API 或长期 cache contract，再增加对应状态拒绝/版本回归；如果扩大架构静态 guard 的语法范围，先增加动态/alias 路径的负例，不要求整个目录保持当前形状。

## Supporting invariants 与 implementation details

- [architecture-boundaries.spec.ts](../../../packages/limina/src/__tests__/architecture-boundaries.spec.ts) 保护选定生产 materializer/controller caller 和相对 runtime import SCC。扫描不完整覆盖 alias、dynamic import、namespace call、re-export tracing，也不证明任意隐式依赖无环。这是 supporting module-boundary guard，不能上升为“整个系统所有依赖静态无环”。
- portable `/` path、code-unit sorting、snapshot schema versions、manifest legacy cleanup policy、Svelte source-map 不重复 rebasing Windows drive 都是重要 supporting contracts；归各 source/tests 与[生命周期页](./limina-lifecycle.md)。
- helper 命名、目录层数、active context slot 数量、默认 timeout、adapter version tag 是 implementation details；只有当改动影响上述 core 性质时才触发 architecture review。
- 产品受众、长期插件扩展、兼容承诺与为何选某工具链是 human judgments。不能用测试写死尚未决定的方向。
