# Limina Core Invariants

[English](../invariants.md) | [简体中文](./invariants.md)

这里登记 12 条会影响系统正确性的性质。它们来自当前实现，不声称永久设计意图。`Confirmed` 表示生产类型/控制流直接支持；运行样例及未覆盖条件见[审计](./architecture-audit.md)。完整定义分别归[系统模型](./system-model.md)、[语义事实](./semantics.md)、[生命周期](./lifecycle.md)，本页拥有 invariant 的约束、解释与 evidence matrix。

**Enforcement strength**：Strongly executable 表示作用范围内有直接类型或运行时 guard，并有反例测试；Partially executable 表示主要生产路径受保护，但仍依赖调用方生命周期/输入契约；Prose-only 表示没有机械 guard。测试存在和本次测试通过分开记录，不以行数或测试数量代替覆盖判断。

## I01 — 治理 authority 来自 validated workspace

- **Statement / Applies when**：所选配置最近的 package.json（或仅迁移 defaults 模式下原始 cwd 的最近 manifest）固定治理根及配置解析 generation 中已验证的 manifest fact，只有同根 workspace 语义决定成员分类。graph/source/proof 使用该根激活的包投影 authority；raw package discovery 仅为输入证据。对已激活 package，重复 physical identity、非法 overlap/boundary 必须先失败。
- **Problem**：被排除或另属 nested workspace 的包若仍参与 owner 选择，就可能错误授权 import 或写输出。
- **Root cause**：package manager 发现范围、逻辑目录和治理范围是不同集合；symlink alias 又会使一个物理包有两个名字。
- **Enforcement / Why it works**：[validated create](../../../packages/limina/src/core/workspace/validated/create.ts) 先校验 exclusions、islands、overlap、package identities 与 output authority，后发布 context；[package-identities](../../../packages/limina/src/core/workspace/validated/package-identities.ts) 拒绝重复 canonical directory。下游运行时 package/owner/boundary 查询通过 WorkspaceRegionPathIndex / WorkspaceLookupIndex 使用 canonical Governance Trie；package/owner 数组不能通过 directory containment 重建该 authority。construction 与局部关系的边界见 [region index owner](./system-model.md#validated-region-的内部查询索引)。
- **Concrete example**：`workspace-validation.spec.ts` 的 package alias / nested boundary 用例挑战同一物理包被双重激活；另一个无 name 的包仍可拥有 source，只有依赖 name 的 graph export 要求名称。`workspace-directory-index.spec.ts` 中，A activation → B cut → C activation 必须经 path index 与 package/owner lookup facade 均返回 A / null+B / C，并覆盖 external packages。`workspace-package-scope.spec.ts` 中，无名称 activated package 的真实路径与子目录 alias 均不能获取包外祖先的名称；最近 manifest 的路径保留所选 package 的原有身份。
- **Protected property**：治理归属唯一、范围隔离、输出授权不扩大。
- **Evidence / Strength / Confidence**：[workspace tests](../../../packages/limina/src/__tests__/workspace-validation.spec.ts)、[region/facade guards](../../../packages/limina/src/__tests__/workspace-directory-index.spec.ts)、[package-scope guards](../../../packages/limina/src/__tests__/workspace-package-scope.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：canonical package 校验不能证明任意 config alias 都已物理合并；name-based graph 和 path-based source owner 不能合成一个 identity。

- **Discovery guard**：`governance-root.spec.ts` 挑战配置选择、最近 manifest fail-fast、祖先独立性、共享根 manifest 内容、workspace manager 必需与 single manager 可选。`workspace-discovery.spec.ts` 保留同根 descriptor 优先级、显式 manager 优先、所消费声明投影、manager-specific selection 和 lexical alias。`single-package-knip.spec.ts` 将 validated canonical identity 贯通无名称 dependency/owner 匹配，并拒绝重复物理根。即使 manager identity 缺失或开启 nameless-scope extension，嵌套 workspace 声明仍是 hard cut。兼容边界见[发现 authority](./system-model.md#工作区发现-authority)。

**Migration 输入守卫**：精确 `tsconfig` 排除在 outputs 声明读取前生效，不改变 package 激活。可选 outputs 试加入复用完整 reader，保护入口、managed source 与每个 solution 的可达集合；仅 descriptor 数量不能授予接受资格。[Migration 拓扑测试](../../../packages/migrate/src/__tests__/migration-topology.spec.ts)与[新进程 CLI 覆盖](../../../packages/migrate/integration/tests/migration.spec.ts)覆盖自隐藏、稳定隐藏正常成员、缺源码保留、空输入隔离、域外目标内容／路径探测规避及 solution 声明展开。输入消费只验证声明可读与激活范围，checker mapping 留给正常语义分析。完整行为归[迁移生命周期](./lifecycle.md#migration-是另一种事务)所有。

## I02 — semantic authority 不随 final checker owner 改写

- **Statement / Applies when**：managed type config 的 semantic authority 在 facts convergence 后 freeze；后续 promotion/coloring/fallback/finalization 不能改变它。成功 finalization 为 leaf 确定唯一执行 owner。
- **Problem**：为共享 declaration build 选用 Vue checker，可能错误地把原生 TS import 改为 Vue module semantics。
- **Root cause**：解释源码与安排构建使用不同 authority，二者都曾容易被称为 owner。
- **Enforcement / Why it works**：[ownership types](../../../packages/limina/src/core/build-graph/checker-ownership-types.ts) 分字段；[semantic authority](../../../packages/limina/src/core/build-graph/checker-semantic-authority.ts) 限定 lock evidence、保存 frozen 值并在 coloring/finalization 后比对；[resolution](../../../packages/limina/src/core/build-graph/checker-ownership-resolution.ts) 先收齐 requirements 再应用锁。执行选择无法冒充新的语义证据。pending inference 必须同时具有 missing evidence 与合格 pending-framework-candidate；native source requirement 本身不能锁定 framework authority。
- **Concrete example**：`generated-graph.spec.ts` 中 TS app 导入 Vue project 的 theme TS 后可由 `vue-tsc` 构建，同时 semantic/frozen authority 保持 TypeScript。
- **Protected property**：语义稳定、import 顺序不隐藏跨框架冲突。
- **Evidence / Strength / Confidence**：[generated graph tests](../../../packages/limina/src/__tests__/generated-graph.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：freeze 是快照与校验机制，不是全对象 deep freeze；named solution 的 explicit ownership constraints 在 discovery 阶段已经存在。

**Native 阶段资格**：[pending baseline](../../../packages/limina/src/core/build-graph/pending-native-context.ts)在最终 Checker 初始化前建立；locked 阶段重新采集而不重标 pending 对象。框架物理候选有独立来源，只能支持选择。输入/epoch/phase 变化撤销旧资格，冻结后冲突显式报告，不循环重选。

## I03 — Importer roots、支撑准入与解析相互独立

- **Statement / Applies when**：Native roots、编译器请求、物理加载、Coverage 与治理 owner 是独立事实。非 root 实现记录 Coverage 后停止；本地声明 roots 具有当前源配置成员资格时展开；外部受管声明在创建 SourceFile 前停止，仅独立候选验证可授予后续加载资格。
- **Problem**：手工补扫、目录豁免或抹掉真实 types/lib 会制造闭包；把 frontier stop 当失败会丢掉独立入口。
- **Root cause**：解析、成员归属、加载和义务具有不同证明要求。
- **Enforcement / Why it works**：[编译器 inventory](../../../packages/limina/src/core/typescript-semantic/native-program-inventory.ts)保留真实请求；[物理 frontier](../../../packages/limina/src/core/typescript-semantic/native-program-frontier.ts)在 SourceFile 创建之前执行 Coverage 决策；无完整 Program 生产回退。
- **Concrete example**：A→env.d.ts 是政策边界。选定的声明项目独立推导自己的 B.ts 义务，A 不扫描或继承该项目的闭包。JS shadowed require 按编译器实际观察保留，但不因此宣称其为有效 Node runtime 调用。`noResolve` 的解析命中不证明义务。
- **Protected property**：范围内遍历完整、物理截断可解释、独立入口和贡献撤销正确。
- **Evidence / Strength / Confidence**：[编译器观察](../../../packages/limina/src/__tests__/native-program-observation.spec.ts)、[声明边界](../../../packages/limina/src/__tests__/declaration-policy.spec.ts)、[Native 增量](../../../packages/limina/src/__tests__/native-context-incremental.spec.ts)和[缓存](../../../packages/limina/src/__tests__/full-analysis-cache.spec.ts)分别保护观察、Coverage、可达性和恢复。
- **Boundaries**：真实 types/lib/raw references 不删除；stdlib、第三方、Bundler 和 reference 输出不自动豁免。共享声明 roots 是合法独立输入；外部多 Coverage 需要选择，不完整 Coverage 不能证明唯一选择。完整 Program 只用于 Oracle，实际诊断由最终 Checker 给出。

输出投影使用实际生成 options、roots、references 和独立 context，在全部生成配置暂存后观察。它不更改源码 context 的冻结事实；未满足投影能力不能获得成功发布资格。

## I04 — locked dependency fact 必须保持 checker occurrence 与 provenance

- **Statement / Applies when**：locked project dependency 路径保留 occurrence kind/locator、compiler channel/mode/redirect、checker target 与 evidence；generated fact 必须有可信 source mapping，实际 provider 观察可归因，miss 不被 Oxc 补成 semantic target。
- **Problem**：同一个 specifier 在 import/require condition 下指向不同目标；宽松 source map 或 fallback 会把一个合法物理文件冒充 checker 实际看到的依赖。
- **Root cause**：specifier/path 是不完整 identity，runtime resolution 与 checker program 观察也不同。
- **Enforcement / Why it works**：[identity](../../../packages/limina/src/core/typescript-semantic/identity.ts)、[checker-resolution-provider](../../../packages/limina/src/core/import-analysis/checker-resolution-provider.ts) 和 [dependency-record](../../../packages/limina/src/core/project-dependencies/dependency-record.ts) 分别保护 occurrence、locked resolver route 和 target/evidence 一致性。框架 strict-source-map 检查只接受可归因片段。
- **Concrete example**：Svelte conditional export 用例用 occurrence mode 选择 import/require branch；缺少 Checker 观察出处的不同 provider 必须失败，不能凭 `.vue` 原始扩展重建另一目标。
- **Protected property**：checker fidelity、provenance 可追踪、失败不扩大 authority。
- **Evidence / Strength / Confidence**：[project dependencies tests](../../../packages/limina/src/__tests__/project-dependencies.spec.ts)、[Svelte tests](../../../packages/limina/src/__tests__/svelte-semantic.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：pending physical candidate bootstrap 和 runtime-like inspection 有别的 Oxc 路径，但两者都不重新解释带 query 或 fragment 的 specifier；该语法属于 occurrence identity，只有 checker 能赋予其含义。runtime filesystem check 与 missing-provider fallback 也会在路径归一化前停止，因为后接 `..` 的 query/fragment 片段可能在归一化中被消去。TypeScript 类型要求 locked 不等于任意 JS 输入均有 runtime authentication。
- **Observation/cache 边界**：分类不能丢弃 checker target、runtime evidence 或归属输入。[证据快照](../../../packages/limina/src/core/project-dependencies/evidence.ts)保留冻结的 occurrence/context/generation 及独立证据来源。未观察不等于缺失，graph 消费者不能增加 resolver 补齐。未消费 exports 不属于依赖正确性；发布与类型契约是独立检查。

- **静态块边界**：类静态块具有独立的 var 作用域，同时保留词法父级。块内 var/let/function 绑定不能遮蔽兄弟静态块或类之后的外部 require 与不可变 createRequire 别名。[导入分析回归](../../../packages/limina/src/__tests__/import-analysis.spec.ts) 覆盖这些边界及 require.resolve。

- **JSDoc 边界**：已解析 occurrence 的定位不能证明编译器请求或类型供给。精确的当前 Program 节点／inventory 绑定和局部失败由 [JSDoc 回归](../../../packages/limina/src/__tests__/jsdoc-semantic-location.spec.ts)保护；机制由[语义记录](./semantics.md#occurrence证据与建图需求)持有。

## I05 — TypeEvidence 不控制依赖存在性或引用投影

- **Statement / Applies when**：TypeEvidence 仅证明类型供给。Native 编译边需要合格 locked 事实中的独立义务存在性证明；解析、owner、加载和 Symbol 都不能单独代替。
- **Problem**：类型供给或 owner 命中被误用为编译关系，或者普通建图被迫创建 TypeChecker。
- **Root cause**：类型可用性、runtime-use、project-use 与编译义务不是同一命题。
- **Enforcement / Why it works**：[义务合同](../../../packages/limina/src/domain/analysis/native-obligation.ts)保留存在性、结构满足、产物可用性三维；[资格检查](../../../packages/limina/src/core/typescript-semantic/native-fact-qualification.ts)限定 locked 消费；Native 投影不用旧 source-semantic owner 推导。
- **Concrete example**：无 composite 的源码选项、noResolve 或 augmentation 可以解析到同一实现，却不能据此产生 required。已有 reference 且输出缺失可同时是 already-satisfied 与 missing；最终 Checker 决定真实编译诊断。
- **Protected property**：义务证明与类型供给分离，普通分析不查询 Symbol。
- **Evidence / Strength / Confidence**：[领域合同](../../../packages/limina/src/__tests__/native-evidence-contract.spec.ts)、[Native provider](../../../packages/limina/src/__tests__/native-provider-evidence.spec.ts)、[reference 修复](../../../packages/limina/src/__tests__/native-reference-repair.spec.ts)和[TypeEvidence](../../../packages/limina/src/__tests__/type-evidence.spec.ts)覆盖独立消费者。
- **Boundaries**：unknown 不伪装成 not-required 或完整空图，也不自动等于违规/构建失败。框架映射与能力由各自适配器负责。

## I06 — 声明、调度与 artifact attribution 不互相升级

- **Statement / Applies when**：declaration-provider 可产生 generated TypeScript references；framework-schedule 只表达 source execution dependency；生成声明产物与真实原始 reference redirect 保留消费边界。受管源码声明使用独立上下文政策，不通过 TypeEvidence 推断生产者。
- **Problem**：把所有“依赖”画成一种边，会给 Astro/Svelte 制造不存在的 declaration project，或把已经产出的 `.d.ts` 重新连回 source 形成伪依赖。
- **Root cause**：类型供给、源码编译需求、执行先后和输出归属需要不同消费者。
- **Enforcement / Why it works**：[reference-recording](../../../packages/limina/src/core/build-graph/reference-recording.ts) 要求 normalized compiler/semantic requirement；declaration-context-references 提供单独标记的政策贡献；[framework inference](../../../packages/limina/src/core/build-graph/framework-reference-inference.ts) 仅接受符合条件的 source implementation；[framework edge](../../../packages/limina/src/core/build-graph/framework-dependency-edge.ts) 拒绝 declaration path。各 edge type 拥有不同字段和投影。
- **Concrete example**：consumer 命中 managed output `.d.ts`，lookup 可解释它来自哪个输出，但不添加 sourceToBuild reference；Astro/Svelte source prerequisite 可以参与 schedule，却不生成 tsconfig references；框架调度由符合资格的实现需求及所属 Checker 能力决定，不由 ambient 类型或 Program membership 单独控制。missing declaration companion 不得 bootstrap Oxc 或提升 consumer checker。没有 checker target 的带 query 框架组件（如 `./Widget.svelte?x`）不得 bootstrap Oxc、给 consumer 染色或产生 edge。
- **Protected property**：声明关系真实、构建职责分明、artifact 消费不重开源码边界。
- **Evidence / Strength / Confidence**：[generated graph](../../../packages/limina/src/__tests__/generated-graph.spec.ts)、[dependency graph tests](../../../packages/limina/src/__tests__/dependency-graph.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：raw references、solution closure、`implicitRefs` 各有独立 evidence，不要求全部 graph edges 都源自 import；exported dependency graph 也不是 task graph。

**Native 与 runtime**：TS require/createRequire/require.resolve 可继续贡献 runtime/source/package 治理，但不自动形成 Native references 或 Checker coloring 关系。Deny 是独立裁定，不从原始关系或候选投影删除边；unknown relation 保留完整性缺口。原始显式 references 和 implicitRefs 不依赖伪造 import。

## I07 — 声明 component 使用 exact checker identity

- **Statement / Applies when**：成功的 declaration-provider 两端 exact checker identity 相同，`cacheReuse` 为 reusable；参与执行的 SCC 不能含内部 declaration relation，纯 framework scheduling SCC 可以执行。
- **Problem**：不同 checker 的中间声明缓存不可仅因语义 family 相近而视作一个构建；禁止所有环又会错杀纯 framework 顺序分组。
- **Root cause**：identity equality 与 execution dependency direction 是不同关系。
- **Enforcement / Why it works**：[build coloring](../../../packages/limina/src/core/build-graph/checker-build-coloring.ts) 将合法 declaration/solution equality 组成无向 component，单色传播、多色拒绝，再由 [graph-validation](../../../packages/limina/src/core/build-graph/graph-validation.ts) 检查最终边；dependency plan 区分 declaration subset 后检查 SCC。
- **Concrete example**：已明确为 tsc 和 tsgo 的两个 leaf 不能通过 declaration edge 混色；全部框架调度边组成的 SCC 则不因此产生 declaration cycle error。
- **Protected property**：编译缓存兼容与执行计划的可解释性。
- **Evidence / Strength / Confidence**：[generated graph](../../../packages/limina/src/__tests__/generated-graph.spec.ts)、[execution](../../../packages/limina/src/__tests__/execution.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：registry 的局部 cache compatibility helper 可比 final graph guard 宽，不能单独引用 helper 推翻最终约束；Concrete declarations 不建立该 equality，deny 不移除已观察关系的 equality 约束。dependency plan 先滤同 target 自依赖，SCC guard 实际检查两个及以上成员的 component，不是任意图自环检测器。

## I08 — source ownership 与 checker coverage 分别证明

- **Statement / Applies when**：proof 在配置的 source boundary 内，将 expected source 与 checker 实际覆盖分别收集后比较；一个文件有 package/config owner，不足以证明它被所选 checker 覆盖。
- **Problem**：显式选择只理解 Astro 的 checker 后，邻接 Svelte 文件仍可能属于包，却没有进入该 checker 的有效 roots。
- **Root cause**：治理想覆盖的 source 与 checker observation capability 不同。
- **Enforcement / Why it works**：[source-files](../../../packages/limina/src/proof/source-files.ts) 收集 expected source；[coverage](../../../packages/limina/src/proof/coverage-collection.ts)、[source coverage findings](../../../packages/limina/src/proof/source-coverage-findings.ts) 与 framework coverage 比较差集和冲突。前置 route/config 阶段失败时不伪造后续完整证明。
- **Concrete example**：显式 Astro scope 中出现未被 checker roots 覆盖的邻接 framework 文件，不仅凭“文件存在”拒绝 graph，而由适用的 proof source boundary 检查 coverage 缺口。
- **Protected property**：治理覆盖声明不超出实际 checker 能力。
- **Evidence / Strength / Confidence**：[proof tests](../../../packages/limina/src/__tests__/proof.spec.ts)、[generated graph tests](../../../packages/limina/src/__tests__/generated-graph.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：配置 include/exclude/allowlist 决定证明范围；source、graph、proof 通过不证明每个外部工具、package output 或 release 检查均通过。

**Source Config Coverage**：全集先由激活 entry/solution 规则确定，不以成功解析集合替代。发现闭合、成员枚举、配置与物理身份版本一致才证明零/唯一；两个当前已确认不同成员可证明 ambiguous，其他不足为 unavailable。Lexical 命中不遮蔽 canonical 冲突，文件身份不扩大范围。[Coverage 合同测试](../../../packages/limina/src/__tests__/native-evidence-contract.spec.ts)覆盖过期成员和无法界定的配置失败。

## I09 — 事实重用与异步结果受 provider 生命周期约束

- **Statement / Applies when**：生产 preflight 在 command mutation 后更新 generation/providers/cache；materialization replan 可只更新 provider generation。receipt 仅提交给当前 slot；缓存不能仅因 path 相同跨有效期当作新事实。
- **Problem**：命令修改 source 后旧 graph 仍被复用，或旧 materialization promise 晚到覆盖新 receipt。
- **Root cause**：path identity 不是内容版本，analysis generation 与 provider generation 也不总相同。
- **Enforcement / Why it works**：[manager](../../../packages/limina/src/preflight/manager.ts) 替换 provider set；[scheduler](../../../packages/limina/src/execution/scheduler-loop.ts) 等运行任务结束后推进；[materialization](../../../packages/limina/src/preflight/materialization.ts) 检查 slot/promise identity。facts snapshot 保留历史，live context 及时 dispose。
- **Concrete example**：捕获 `import './a.js'` 后编辑成 `b.js`，旧 snapshot 仍表示旧观察，新 context 才看见新输入；两个相同数字 generation 的 namespace token 仍不同。
- **Protected property**：同次分析一致、异步结果不串代、资源回收可归责。
- **Evidence / Strength / Confidence**：[preflight tests](../../../packages/limina/src/__tests__/preflight.spec.ts)、[context tests](../../../packages/limina/src/__tests__/typescript-semantic-context.spec.ts)；**Partially executable / Confirmed**。
- **Boundaries**：外部复用 caches 必须尊重 lifecycle；key 没有普遍 file-content digest；manager ensure-after-dispose 没有统一 guard；Vue active slot 的共享模式另见生命周期页。

**持久化分析有效性**：native importer 复用绑定事实版本、query coverage 和共享环境证据。完整 clean DTO 还在创建 Program 前校验当前 roots／admission、importer scope／mode 输入、lock 信任、本地 typeRoots 、namespace 级有效 `configVersion` 门及完整的逐文件 `configModules` 门；独立 CLI 进程之间，已知配置模块、原始解析边、绑定和已观测 loader 输出摘要必须匹配，mtime 相等信任旧 hash，mtime 不同按单文件 hash fallback。实际模块和显式声明文件共用同一证据门。未执行的动态导入不使配置失去资格；真实 incomplete 证据总触发冷分析，包括原因移除后的首次 complete 调用。严格调用内漂移仍终止执行，不重放命令。Preflight 访问策略可以关闭持久化恢复及发布，但不能关闭调用内有效性保护；调用者的读写／只读权限和 force 均不能覆盖公开配置的禁用策略。冷／dirty 分析建立当前有资格的支撑闭包；失效 Native context 创建新的物理 Bounded Program，完整有效 DTO 恢复无需 Program。恢复数据不授予运行时 ownership 或写权限。仅分析 epoch 的重试不能重放已完成命令。见[持久化缓存生命周期](./lifecycle.md#原生持久化分析缓存)及其回归证据。

**恢复与执行重放守卫**：[Vue 完整图测试](../../../packages/limina/src/__tests__/vue-analysis-cache.spec.ts)保留合法跨项目引用并拒绝一致伪造；[输入重放测试](../../../packages/limina/src/__tests__/execution-input-replay.spec.ts)只允许未变只读阶段内复用观察及同轮祖先绑定，保留真实副作用边界的新一轮内容／绑定漂移检查与每个作用域独立的输出例外。边界由[执行准入生命周期](./lifecycle.md#受管-checker-的执行准入)定义。

**分片持久化**：Scope 文件是存储边界，不是独立语义权威。Root 门先于任何旧块读取；包含中性文件事实和有序回执的完整模型经校验后才能采用。先写块，再经过既有漂移、lease 与物理基线检查后原子发布 index。见[存储生命周期](./lifecycle.md#原生持久化分析缓存)和[存储守卫](../../../packages/limina/src/__tests__/analysis-cache-shards.spec.ts)。

**规划输入 identity**：Migration 配置 overlay 纳入 semantic/provider cache identity，并贯穿 parser、ownership 与 TypeScript host。原生 reference 清单与规范化 source 输入上的推导相分离。Outputs 试加入只在封闭 reader 内复用单次发现快照，重新验证候选输出与物理 authority；末次规划和磁盘消费重新发现。已读取的 manifest 与 workspace descriptor 也纳入写入前漂移检查。Migration bundle 将 provider、namespace、错误类和 writer 的生产消费作为整体内联；新进程 worker 使用同一内嵌源码版本重新读取磁盘，不借用规划 context。包版本元数据观察不成为 semantic evidence。构建源码来源守卫、配对发布守卫与打包消费者测试挑战旧 dist、self metadata 不一致及 worker 资源缺失。这是 generation 内的输入边界，不是持久 read-view runtime；见[迁移生命周期](./lifecycle.md#migration-是另一种事务)。

## I10 — mutation 权限不能从路径字符串推导

- **Statement / Applies when**：managed artifact/managed checker output mutation 需要对应 namespace/plan 或 output authority，并验证 logical 与 physical binding；同 root/generation 字面值不能替代 authenticated token。
- **Problem**：路径看起来在 `.limina` 或 outDir 下，实际沿 symlink 指向其他目录；复制结构相同的 plan 可能使用另一代权限。
- **Root cause**：字符串 containment、文件系统 identity 和 object provenance 属于三种身份。
- **Enforcement / Why it works**：[namespace-core](../../../packages/limina/src/domain/artifacts/namespace-core.ts) 与 [plan](../../../packages/limina/src/domain/artifacts/plan.ts) 认证 object/token；[authority-create](../../../packages/limina/src/utils/mutation/authority-create.ts) 与 [identity](../../../packages/limina/src/utils/mutation/identity.ts) 检查 trusted base、scope、symlink chain 和 binding drift。
- **Concrete example**：给同 root、generation=0 的新 namespace 使用旧 namespace 的 plan，被拒绝；trusted base 内的 `link/result` 经过 symlink 时不能创建隐含写权限。
- **Protected property**：写入范围受控、权限不因名称相似或 stale object 扩大。
- **Evidence / Strength / Confidence**：[mutation tests](../../../packages/limina/src/__tests__/mutation-boundary.spec.ts)、[materialization recovery](../../../packages/limina/src/__tests__/materialization-recovery.spec.ts)；**Strongly executable / Confirmed**。
- **Boundaries**：raw external build、export 用户文件和 migration 是不同 writer contract；不能推广成所有写入经过同一个 namespace，或绝无 OS race。

**Migration 写入边界**：冻结补丁使用隔离的一致性组及既有物理 identity/rollback 守卫。Report 发布失败绝不回滚已提交配置。接入成功还要求新进程消费实际磁盘拓扑；必要写入失败即使伴随其他组成功，也仍为未完成。分析不完整与可消费性分别报告；异常尝试尽可能发布失败审计，不能回退成旧成功。见[迁移生命周期](./lifecycle.md#migration-是另一种事务)。

**迁移预览与创建守卫**：范围接受先于模块求值；实际业务写入必须是已展示冻结操作的子集。defaults 不伪造 configPath。必要配置创建不覆盖后来出现的目录项，真实文件加载前不能形成磁盘隔离证据。dry-run 在所有迁移器控制写入（包括失败报告）前返回，不提供磁盘成功证据。[工作流守卫](../../../packages/migrate/src/__tests__/migration-workflow.spec.ts)及创建／回滚事务反例覆盖这些边界；完整行为归[迁移生命周期](./lifecycle.md#migration-是另一种事务)。

**Evidence 准入**：[生成图 Admission](../../../packages/limina/src/core/build-graph/graph-validation.ts)与 Governance、Core 执行和关系完整性分别表达；候选计划必要前提中的执行/输入故障阻止事务发布；无关 unknown 不构成统一拒绝。治理不能改写已完成的 Core 调度。通过此门禁仍须获得既有 namespace/plan 权限，不能从 evidence DTO 构造写入能力。

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

| Invariant | 主要 executable enforcement                                             | 反例机会 / reviewer 观察                                                        | 代表性回归 guard                                                                                                                   |
| --------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| I01       | validated context、canonical Governance Trie、workspace/facade guards   | cut、重入、external package 与 canonical identity                               | 增强现有重入 guard：package/owner facade 与 path index 一致                                                                        |
| I02       | authority state / freeze assertions / coloring tests                    | TS semantic + Vue final owner、依赖顺序与冲突                                   | missing native source 不锁框架；合格 component candidate 可以锁定                                                                  |
| I03       | effective roots / inclusion ledger / native compiler differential tests | relative types、external closure、source excluded 但可 resolution               | built/unbuilt reference 的 provider identity 与原 source admission                                                                 |
| I04       | occurrence identity / locked dispatch / prepared consistency assertions | import/require condition、mapping ambiguity、kind mismatch、query/fragment      | 完整 specifier 到达 checker；query 与 fragment 不被拆分，也不经 Oxc 救回                                                           |
| I05       | 结构依赖事实与独立显式 proof 测试                                       | Ambient 实现、redirect、augmentation、完整 query source                         | 显式 Program/Symbol proof、结构 redirect、ambient 实现候选、完整 miss                                                              |
| I06       | edge union / reference-recording requirement / declaration guards       | concrete managed output、framework-only schedule、implicit ref、带 query 的组件 | 物理 declaration companion 阻止 bootstrap；missing source 保留真实 schedule edge；已证明 requirement 不被 resource 样 runtime 取消 |
| I07       | equality coloring / final graph guard / SCC declaration guard           | exact checker conflict、pure schedule cycle                                     | 无：局部 helper 与终态 guard 的差异应解释，不误改 helper                                                                           |
| I08       | proof phase、expected vs coverage set comparisons                       | 不可观察的邻接扩展、uncovered/duplicate source                                  | 无：配置边界必须由人审，不增 blanket exclusion                                                                                     |
| I09       | scheduler generation、provider replacement、slot identity、dispose      | stale promise、replan 不推进 task gen、外部 stale cache                         | snapshot 一致性、Program/query 数量、释放及 alias 变化后的新 owner 索引                                                            |
| I10       | namespace/plan auth、physical mutation guard                            | forged/cross-token plan、symlink escape、binding drift                          | 无：已有异常与 filesystem tests                                                                                                    |
| I11       | writer lease、revision、marker、verify、recovery tests                  | 中途写失败、并行 revision drift、stale ownership ledger                         | 无：现有 semantic recovery guard 更稳                                                                                              |
| I12       | sequence/digest/freshness、query/invocation guards                      | torn pair、newer running、corrupt latest、old completion                        | 无：现有 end-to-end CLI tests                                                                                                      |

12 条均有机械连接；11 条在明确作用域内 Strongly executable，I09 依赖额外生命周期契约，列 Partially executable。没有把 Prose-only 的未来愿望伪装成已建立 core invariant。值得机器化但本次不直接实施的部分：若 human 决定统一 disposed API 或将持久化缓存扩展到其他 provider，再增加对应状态拒绝/版本回归；如果扩大架构静态 guard 的语法范围，先增加动态/alias 路径的负例，不要求整个目录保持当前形状。

## Supporting invariants 与 implementation details

- [architecture-boundaries.spec.ts](../../../packages/limina/src/__tests__/architecture-boundaries.spec.ts) 保护选定生产 materializer/controller caller 和相对 runtime import SCC。扫描不完整覆盖 alias、dynamic import、namespace call、re-export tracing，也不证明任意隐式依赖无环。这是 supporting module-boundary guard，不能上升为“整个系统所有依赖静态无环”。
- portable `/` path、code-unit sorting、snapshot schema versions、manifest legacy cleanup policy、Svelte source-map 不重复 rebasing Windows drive 都是重要 supporting contracts；归各 source/tests 与[生命周期页](./lifecycle.md)。
- helper 命名、目录层数、active context slot 数量、默认 timeout、adapter version tag 是 implementation details；只有当改动影响上述 core 性质时才触发 architecture review。
- 产品受众、长期插件扩展、兼容承诺与为何选某工具链是 human judgments。不能用测试写死尚未决定的方向。
