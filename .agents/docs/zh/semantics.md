# Limina 语义事实

[English](../semantics.md) | [简体中文](./semantics.md)

本页解释 dependency fact 如何产生及其能力边界；实体和 relation 定义归[系统模型](./system-model.md)，不可意外改变的性质归 [I02–I07](./invariants.md)。本页描述当前 adapter 的行为，不宣称与所有上游版本的完整 checker 完全等价。

## 独立 Native Evidence 合同

**当前实现：**[Native Evidence v4](../../../packages/limina/src/domain/analysis/native-evidence.ts) 已接入 Native provider 和 schema 11；领域合同本身不携带 Program、AST、Host 或执行权限，也没有新增用户 API。它保留请求、原始解析、Coverage、停止原因、项目关系、编译义务、完整性与执行失败。[发布](../../../packages/limina/src/domain/analysis/native-evidence-freeze.ts)复制并冻结 JSON 数据，拒绝编译器句柄、可变集合、accessor 和循环。生产切换验收与版本兼容性仍须通过各自门禁，接入代码本身不证明验收通过。

**Coverage 证明：**[索引合同](../../../packages/limina/src/domain/analysis/native-coverage.ts)要求先按已激活的 entry selection 与 solution traversal 建立全集，再了解哪些配置成功解析。Extends 输入、生成配置和声明产物不因此成为 owner。只有发现闭合、当前配置成员枚举完成且文件身份经过验证，才能证明零或一个成员。无法限定范围的解析失败使相关全集保持不完整；只有带证据的目标身份排除才能缩小影响。Lexical 与 canonical 成员匹配均要求目标和成员具有当前版本的已验证身份；过期或不可用的身份不能计入已确认成员。Lexical 命中不跳过 canonical 别名检查。两个已确认的不同成员即使在部分索引中也能证明 ambiguous；其余不完整证据为 unavailable。文件身份只证明等价，不增加作用域。

**编译义务证明：**[义务合同](../../../packages/limina/src/domain/analysis/native-obligation.ts)独立保留存在性、引用结构和声明可用性。已证明存在且结构未满足为 `required`，已证明存在且结构满足为 `already-satisfied`，已证明不存在为 `not-required`，其余为 `unknown`。上下文、原始 references 和端点映射必须匹配。产物缺失或陈旧不抹掉已满足的结构，文件存在本身不证明产物可用。解析目标、owner、加载尝试或 TypeEvidence 均不能单独提供存在性证明。

**请求级证明：**`absent` 只否定当前请求的跨单元义务。编译器清单确认的 augmentation、有效的 module `noResolve`（包括解析观察不可用），以及已证明的消费者 root，均可独立证明 absence。解析、Coverage、归属和其他请求继续保留。`present` 还要求目标具备输入及 emit 资格、源码分类已取得资格，并符合现有 composite／生成声明项目编译作用域。Import 诊断、JSDoc 和每个来源的有效选项与 path 选择独立。共用 TS/JS 资格只识别受支持的 TS 与四种 JS 扩展名，并区分 `noEmitForJsFiles` 与 Program 成员资格。Module 输入许可使用有效 `allowJs`，已经合法选择的 path 不再被该 module 规则二次否定。已重定向的 JS path 如果尚未证明生产者的 emit 义务，保持 unknown，不借用消费者的 JS 抑制规则。`allowNonTsExtensions` 不赋予任意文件 JS 身份。JSON emit 仍未证明。`sourceFileMayBeEmitted` 只作为真实目标 SourceFile 的测试 Oracle，不证明请求引入目标，也不授予加载资格。TypeScript 5.4/5.5 缺少每个来源的 callback 选项 receipt 时保持不可用，不借用全局选项。

**引用观察：**[编译器适配](../../../packages/limina/src/core/typescript-semantic/reference-redirect.ts)区分观察完成且无关联、有项目成员关联但无 `outputDts`、真实声明映射和经过审计的局部 API 不可用。候选 pending 时停止物理回退，直到现有 bounded pass 收敛。每轮将加载观察重新绑定到本轮 Program，最终编译器清单中的目标在发布前完成观察。[事实](../../../packages/limina/src/core/typescript-semantic/native-program-facts.ts)复用这些结果，不在冻结后调用 getter。没有声明路径的成员关联保留原始 reference，并可探测原始路径，绝不伪造 redirect。TypeScript 5.4 没有 JS reference 例外，5.5–5.8 使用编译器经过资格限制的项目成员谓词，5.9/6.0 使用实际 source map 结果；它们对声明输入的关联不必相同：5.9.0–5.9.2 省略声明输入，5.9.3 恢复关联，因此对这些目标的空查询不能证明引用结构缺失。解析 callback 的 redirect 是导入者的解析上下文，不是目标引用结构的证明。

**不确定与失败：**经过审计的 Reference Map API 缺失属于局部 unknown／选择停止，不产生 `NativeEvidenceFailure`。已存在的 getter 抛异常，则按既有 snapshot 合同记录真实失败：`run: unavailable`、traversal 不完整且不能完整恢复缓存。两种情况下均保留独立成立的 absence。解析不可用可以与 `not-required`、观察执行完成及编译关系未确定同时存在，absence 不会删除解析缺口。[结构投影](../../../packages/limina/src/core/typescript-semantic/native-obligation-projection.ts)可从已证明端点及有效 references 为空，或观察完成且无关联的 Map，证明 `unsatisfied`。只有成员关联时保持 `unknown`，真实且适用于当前消费的映射才可证明 `satisfied`。产物就绪状态不能反向修改这些结论。正确类型的候选引用可消除必要 unknown 的风险，但不改写原始证据；framework schedule 不能替代 declaration reference。

**证明恢复：**Audited-rule 的 existence proof 将 evidence ID 绑定到请求 ID 和当前 context；通用 compiler-observation proof 保留独立的 observation ID。[Bounded 恢复](../../../packages/limina/src/core/analysis-cache/bounded-context-validity.ts)还会检查当前 Native 生产者的单请求 audited provenance、义务身份、当前请求确实存在，以及输入／context 绑定，再接纳 fact／snapshot 副本。每个保留的编译器请求都必须恰有一个义务评估，包括 absent 和 unknown。原始 references 为空时，已声明的目标必须匹配从该请求解析结果推导的唯一 Coverage；存在 references 的上下文保留编译器映射的端点优先级。评估缺失或目标错绑会撤销恢复资格并触发冷采集。副本一致与存储 checksum 正确不能代替这些语义连接。Adapter 身份使旧证明语义失效，不改变 DTO/schema 或缓存完整性定义。缓存支持的 warm 元组仍小于 cold 编译器兼容范围。[观察](../../../packages/limina/src/__tests__/native-program-observation.spec.ts)、[证明](../../../packages/limina/src/__tests__/native-evidence-contract.spec.ts)、[Admission](../../../packages/limina/src/__tests__/analysis-completion.spec.ts) 和[真实存储腐败](../../../packages/limina/src/__tests__/full-analysis-cache.spec.ts)测试分别拥有这些边界。External-library qualification 和 Regions/Coverage 加载规则不变；更广泛的 external-library emit 行为仍是回归风险，不因此扩大分析能力。

**阶段资格：**[上下文合同](../../../packages/limina/src/domain/analysis/native-context.ts)保留实际 TypeScript 实现与版本、host、roots／options／raw references 指纹、源码与 Coverage 版本、工具链、epoch 和 collection 身份。Pending Native 观察可用于 baseline 分析及归属选择，框架候选只用于选择。锁定必须创建新 context 和 collection，TypeScript→TypeScript 锁定也适用。Locked 事实必须由已选语义族重新采集。输入、epoch、阶段、collection 或 locked selection evidence 变化撤销当前资格，不改变历史证据。归属歧义和重复锁定显式返回冲突；合同没有重试循环或最终执行 Checker 字段。这些是数据及生产者合同，不是对任意 JavaScript 伪造对象的身份认证。

**物理边界：**Bounded Host 接纳真实实现 roots，以及具有当前源配置成员资格的声明 roots。共享声明仍分别作为各项目的独立输入。外部受管声明在创建 SourceFile 前物理截断，保留进入声明的请求与解析结果。生成上下文显式携带源配置身份。候选验证为已选择声明授予独立的 bounded 加载资格，其观察不回写源码分析事实，也不生成消费者的编译边。非 root 实现、未覆盖声明、第三方和生成产物边界保持不变。完整 Program 仍仅作测试 Oracle。

**加载前 path 选择：**[选择 receipt](../../../packages/limina/src/core/typescript-semantic/native-path-selection.ts)在创建 SourceFile 前，按已适配编译器的候选顺序探测真实存在性与实际 reference map。Coverage 截断不能选择低优先级 `.tsx` 或 `.d.ts`。[加载资格](../../../packages/limina/src/core/typescript-semantic/native-program-loads.ts)要求真实 root，或来自已接纳源码的已选请求，同时满足 Coverage。被独立入口引入的备选声明保留自己的前驱。晚到资格与 reference map 发现使用 roots/options/references 相同的新 Bounded Program；不伪造 SourceFile、不扩大 roots、不回退完整 Program。redirect 产物真实缺失时允许编译器的正常回退，已存在但被截断时不允许。无法证明的 occurrence 保留 scoped unavailable。[Path 回归](../../../packages/limina/src/__tests__/native-path-selection.spec.ts)同时比较目标、完整 SourceFile 集合、后续请求与关系。 编译器的源码分类需要单独取得资格：备选声明被独立 external 入口合法加载时，仍可能继承被截断 path 回退产生的元数据。该源码及其已加载的非 root 后继保留原始观察，但受影响的 emit 义务保持 scoped unavailable；纯声明的无义务证明和独立 roots 仍可使用。

**编译准入：**[类型化前提](../../../packages/limina/src/core/build-graph/compilation-prerequisite.ts) 将原始 request 连接到各自的 resolution target，以及生产者登记的当前 locked context 内经过验证、完整且唯一的 Coverage，而不是用旧 origin 与自身比较。反序列化或未绑定候选没有运行期投影资格。证据资格与义务存在性证明分离：required-only 依赖写入器保留原合同，Admission 可以对必要 unknown 取得资格。投影依据已选 source 的语义／框架能力及 producer 共用的声明／源码选择规则，不依据候选恰好具有哪条边。required、already-satisfied、必要 unknown 使用同一身份和关系种类检查。引用身份包含 source config、Checker、实际生成配置与当前投影；原本 already-satisfied 的义务也适用。声明义务需要 declaration reference，同端点 framework schedule 不能替代它。正确引用可以消除候选风险，但不改写原始 unknown。Svelte/Astro 的源码消费能力不意味着必须启动 provider Checker 进程。执行阶段针对实际引用重新检查选定作用域；生命周期和失败规则由[执行准入](./lifecycle.md#受管-checker-的执行准入)拥有。[准入测试](../../../packages/limina/src/__tests__/analysis-completion.spec.ts) 使用真实 required、unknown 和 already-satisfied Native 证据，执行当前 context 与带类型引用的替换，并保留原始状态。

## 从 ownership 候选到 locked context

[checker-ownership-resolution](../../../packages/limina/src/core/build-graph/checker-ownership-resolution.ts) 先 discovery、root evidence、dependency facts 与 requirements convergence，再 freeze semantic authority，最后进行 Vue promotion、build coloring 与 finalization。[semantic-authority](../../../packages/limina/src/core/build-graph/checker-semantic-authority.ts) 只接受 explicit、config、root-file、dependency 作为语义锁证据；build-closure、fallback、solution-constraint、vue-promotion 不重写语义。

Pending discovery 使用 [pending-facts](../../../packages/limina/src/core/build-graph/checker-ownership-pending-facts.ts) 的 native dependency context。framework inference 只接受合格的 `missing + pending-framework-candidate` fact。[physical candidate](../../../packages/limina/src/core/build-graph/checker-ownership-physical-candidate.ts) bootstrap 中，Oxc 提供物理候选，还需已知 framework extension、governed effective membership、唯一 config 和语义域，才形成 ownership requirement。普通 TS/resource 路径不凭物理命中锁框架。native source requirement 支持编译关系，不提供 framework semantic authority；物理 declaration resolution 即使 evidence 为 missing 也禁止 Oxc bootstrap。带 query 或 fragment 的 specifier（如 `./Widget.svelte?x`）同样不 bootstrap physical candidate：checker 没有给出 target 时，Limina 无权通过 Oxc 或文件系统重新解释宿主语法。canonical fallback 后，Vue custom profile 使用 owner 登记的路径匹配。

Locked [ProjectSemanticContext](../../../packages/limina/src/core/project-dependencies/contracts.ts) 在类型层要求 `LockedSemanticAuthority`。它与 pending discovery 是不同入口；构造函数复制 authority 不等于对任意 JavaScript 伪造对象做完整运行时认证。生产调用合法性来自求解流程和类型边界，不能把它写成不可绕过的安全 capability。

## 一个项目的原生语义输入

[依赖入口](../../../packages/limina/src/core/typescript-semantic/index.ts)只有一个 Native 发现权威：[按版本适配的 TypeScript 观察适配器](../../../packages/limina/src/core/typescript-semantic/native-observation-adapter.ts)。请求来自编译器实际 inventory，包括绕过 resolver callback 的自身 ambient 模块、重复 occurrence、JSX/helper 隐式导入、三斜线以及 types/lib。Host 保留原始解析、options、types、lib 和 raw references；普通收集不调用 TypeChecker、完整 semantic diagnostics 或 emit。明确的 TypeEvidence 请求有独立生命周期。

[有效 roots](../../../packages/limina/src/core/typescript-semantic/effective-roots.ts)仍来自配置解析。A→B.ts→C.ts 在 A 中停于 B。对于 A→b.d.ts→C.ts，政策提供 A→B，B 独立观察到的实现编译义务提供 B→C。不能把 B 的闭包或此前按 A 的 paths 得到的解释展开为 A 的直接边。

既有 TypeScript 支持范围保持为 5.4–5.9 和 6.0。窄适配层在 5.4/5.5 使用编译器回调的 redirect options，在 5.8 之前使用编译器的库映射及名称规范化器，在 5.9 之前使用成对的 reference redirect 方法；后续版本使用已暴露的 Program 方法。实际版本和实现始终属于 context 身份。[打包 Native smoke](../../../smoke/native-compiler.spec.ts)覆盖各次版本首个稳定版本的实际 peer；未来补丁和预发布仍须通过 API 资格检查，不能由这些样例证明。Native DTO 持久恢复保留既有的 6.0.3 能力边界；其他受支持版本重新采集 Bounded Program，不使用替代发现算法。

不支持的编译器或观察 API 显式产生 unavailable/failure，不切换算法。JS、虚拟配置和原始 references 不触发 Programless 回退。每次冷采集构建新的 Bounded Program，随后释放编译器句柄；首版不保留 `oldProgram`。有效完整 DTO 可以独立恢复而不创建 Program，失效 context 重新采集。不存在按 hook 次数判断完整性的合同。

[义务适配器](../../../packages/limina/src/core/typescript-semantic/native-program-obligations.ts)区分源码选项和生成声明项目的已审计规则，保留 raw reference/redirect 映射。解析命中、Coverage owner、加载尝试或类型证据不单独形成编译边。已有 reference 的结构满足与产物缺失/陈旧可以同时成立；未知产物不冒充可用。生成输出以实际投影选项和 references 建立独立 context，不覆盖源码事实。

## 声明入口治理

[声明闭包投影](../../../packages/limina/src/core/typescript-semantic/native-closure.ts)只消费已采集的物理有界事实，保留入口、最后 occurrence、支持关系与正常停止原因。它不重新执行包来源准入策略。相对导入、paths、package imports、公共包入口、托管输出和替换标准库均服从相同 Coverage 规则；解析来源只解释结果，不提供豁免。

多成员声明可以继续展开；实现文件必须具有完整唯一性证明，且非 root 实现仍停止。无覆盖不自动产生治理违规。`noResolve` 的真实编译器行为限制加载，不能用解析成功补出编译义务；`skipLibCheck` 不授予输入删除权限。移除最后入口撤销不可达环；独立入口和菱形前驱保留各自来源。[声明回归](../../../packages/limina/src/__tests__/declaration-policy.spec.ts)覆盖包分支、配置入口、循环、别名改绑与独立 Oracle。

Core 遍历所有可信合格入口；预期 Coverage 边界、确定歧义、正常 miss 和未知义务只停止对应分支。配置/文件/编译器/内部故障单独记录影响范围，独立上下文保留证据。[分析 outcome](../../../packages/limina/src/core/build-graph/analysis-outcome.ts)分别表达执行、范围内遍历、编译关系完整性、Governance 和 materialization Admission。Governance 不改写原始事实，投影不能删除违规/未知关系后宣称完整。Core 工作清单分别记录 baseline、selection、locked 的执行资格和结果。所有合格工作处理完毕后，即使仍有 authority-unavailable，也可完成调度；跳过合格工作不能宣称完整。真正执行故障单独记录。治理拒绝或 output projection 故障只改变建图事务，不改写已完成的 Core。Admission 检查具体候选计划的必要入口和编译引用；必要前提之外的 unknown 不形成统一拒绝。完整遍历不等于所有编译关系已确定。 候选前提分别保留声明引用与框架调度。已有合格候选关系可满足同一目标的必要前提，即使某个 occurrence 的义务仍为 unknown；缺少必要关系仍阻止准入。真正的收集故障在独立合格工作处理完后报告，不改判为治理违规。显式语义族冲突只使受影响的末端入口 unavailable；同语义族的 Checker 冲突仍属于治理判断。

Checker 归属阶段的工具链／语义脚本失败保留为执行失败和受影响上下文；独立项目的证据继续保留，不转换为治理违规。普通解析未命中可供迁移报告说明，仍不构成 Core 执行失败。迁移在 Coverage 边界留下关系不完整状态，并保守保留原生 reference；不能把已知边当成完整关系集。

## 持久化 importer 有效性

[Bounded context capture](../../../packages/limina/src/core/analysis-cache/bounded-context-capture.ts)保存编译器完整 inventory、occurrence 事实和实际输入 receipt。Schema 11、Native adapter、领域版本和 collection mode 共同排除旧 Programless 成功图；旧缓存不转换、不删除。Roots/options/raw references、配置全集、当前 lexical/canonical 身份、正负解析探测、目录、manifest 条件与安装环境均参与恢复资格。相同 importer 文本不足以证明旧 context 有效。

[恢复绑定](../../../packages/limina/src/core/build-graph/native-cache-binding.ts)将图、已验证 context、原始快照与 locked ownership fact 绑定；缓存中的 summary 或 owner 字段不能自授资格。正常 Coverage stop 可完整恢复；执行失败、未知安装证据、残缺通道或伪造绑定触发冷采集。输入失效时原子替换 consumer 贡献，不把旧成功与新失败拼成完整图。纯 Native 完整命中不创建 Program；冷/变化 context 重新创建 Bounded Program，不承诺只解析变化文件。详见[生命周期](./lifecycle.md#原生持久化分析缓存)和[独立进程回归](../../../packages/limina/src/__tests__/full-analysis-cache.spec.ts)。

[归一化图视图](../../../packages/limina/src/core/build-graph/native-graph-views.ts)引用合格 context 的 Coverage、Native evidence 和 occurrence facts，不再持久化它们的独立副本。编译器产出的 inventory 仍是独立完整性见证，不从待检事实重新生成。有序 occurrence 引用保留重复次数与诊断位置。物理成员身份采用 lexical／canonical 路径与文件绑定，独立于源码内容；函数体变化使订阅 context 失效，不把所有重叠 Coverage 的成员身份伪装成变化。Bounded context 观测到的 declaration target 还保留独立、可重放的元数据 receipt，即使 frontier 在创建 SourceFile 前停止也如此。这在不改变 workspace 成员身份的同时，保留生产者输出刷新与执行准入漂移检查。[执行交接测试](../../../packages/limina/src/__tests__/execution-input-handoff.spec.ts)覆盖相关／无关输出变化，以及并发生产者／消费者交接。Context 替换仍一起更新依赖、事实与贡献。

[双向缓存校验](../../../packages/limina/src/core/analysis-cache/bounded-inventory-validity.ts)要求实际 Program 成员与 source/importer 集合一致，并将具有源码 occurrence 的编译器请求与 occurrence/fact 一一对应。删除、孤立或重复记录不能借空集合取得完整性；配置级请求不强制产生源码 occurrence，合法无导入成员仍保留。原始请求与 resolution 也必须一一对应。存储解析和 [context adoption](../../../packages/limina/src/core/analysis-cache/context-records.ts) 使用同一校验，因此拒绝旧 graph 后不会复用缺失事实的上下文。Program 释放前会捕获并冻结编译器 inventory 回执：将每个原始 request 绑定到精确 occurrence（UTF-16 范围、kind、ordinal 和 synthetic 元数据），同时记录完整 SourceFile 集合、已接纳 roots 及实际加载别名。恢复时用回执校验消费投影，并将每个成功 load 反向关联到实际成员；两个同时截短的投影相等并不足够。Redirect 保留编译器实际返回的 SourceFile，不强制 lexical 路径相等。缺失回执或旧 adapter 身份必须冷采集；恢复不能从缓存投影重新生成回执。仅 graph 损坏时可以保留合法 context。校验只撤销缓存恢复资格，不把 scoped unavailable 改成执行失败，也不改写已完成 Core。损坏存储按既有完整模型策略冷回退；直接 context 恢复仍保留独立合法上下文。[真实 store 回归](../../../packages/limina/src/__tests__/full-analysis-cache.spec.ts)覆盖有效 checksum 封装内的 source／occurrence／fact 损坏、重新采集、发布及下一进程恢复；这不证明正常生产者会自然生成该损坏状态。

[Vue analysis records](../../../packages/limina/src/core/analysis-cache/vue-records.ts) 支持没有自定义 Vue 插件的物理项目，版本范围限定为 TypeScript 6.0.3、vue-tsc 与 language-core 3.2.4、Volar TypeScript 2.4.27。稳定 identity 包含有效选项、原始 references、source profiles、config closure 和 toolchain identity；运行期 generation 在恢复时重新绑定。受支持的 preparation facts、映射解析及 resource type evidence 使用已校验 DTO，在取得 Vue live context 前查询。查询覆盖必须完整。Host 读取、完整 manifest 内容、成功与失败探测、目录／路径绑定、生成脚本／映射摘要和安装环境构成 context receipt。未观测的目录枚举及 unsupported／opaque 结果不能授予完整性。工具模块字节和绑定在每次调用重新观测。Vue collection 使用现有 Vue context 观察直接源码依赖和支持输入，并将这些查询的覆盖与 resolution、preparation 分开记录。

混合图要求所有贡献的 native 与 Vue context 都完整。图中的 Vue 引用恢复为当前解析的 identity；Program、AST、Symbol、可执行 host、插件对象和 artifact authority 均不进入 DTO。自定义插件、虚拟输入及 Astro／Svelte 继续冷回退。[Vue 缓存回归](../../../packages/limina/src/__tests__/vue-analysis-cache.spec.ts)覆盖独立进程、失效、残缺记录、运行期 generation 和缓存访问策略。这仅复用分析；checker 诊断与 emit 仍由 checker 执行。

## Occurrence、证据与建图需求

Native 数据流为：编译器实际请求 → 原始解析 → Coverage frontier → 独立义务证明 → qualified locked fact → reference projection。没有先验手写 request 列表作为 Native 入口门槛。

| 请求                                           | Native 与 runtime 的边界                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| import / export / import type / dynamic import | 保留编译器 occurrence、mode、重复位置及真实解析。                                                                                           |
| CommonJS                                       | JS 中编译器识别的 require（含其实际 shadowed 行为）属于 Native；TS 中普通 require/createRequire 留在独立 runtime 收集器，不自动形成编译边。 |
| ambient / augmentation                         | 保留自身 ambient 快路径；编译器清单确认的 augmentation 证明请求级 absence，单独的解析命中不能确认其角色。                                   |
| JSDoc / declarations                           | 按实际 TS/JS 编译器 inventory 和每个声明的 Coverage 决定，不扫描任意注释字符串。                                                            |
| path / types / lib / JSX / helper              | 保留独立通道、配置来源和真实隐式请求；不删除 types/lib，不制造额外 roots。                                                                  |

[Runtime source collector](../../../packages/limina/src/core/project-dependencies/runtime-source.ts)保留 source/package 治理及导出图需要的词法 require、createRequire 和 require.resolve。其请求目的、缓存身份、输出资格与 Native 分开，`referenceRequirement` 为 null。Graph Check 的 Native 目标使用[已证明义务](../../../packages/limina/src/core/typescript-semantic/native-fact-qualification.ts)，不由 FileOwnerLookup 命中重新推出。

Graph Check 通过[独立 workspace Governance 消费者](../../../packages/limina/src/graph-check/native-coverage-governance.ts)读取已证明无覆盖的实现文件事实。既有 source-package 策略可报告 unmapped/outside-graph import，不依赖其编译义务资格。不可用 Coverage 与声明停止不满足该诊断条件；缺失或无类型的包入口仍使用既有 runtime 策略诊断。该消费者不创建 reference 边。文件系统 detector fixtures 保留这两类策略反例，也保留被拒绝的生成 reference，后者必须继续在图中可见。

TypeEvidence 是独立按需类型证明，不能创造或抹除编译义务；实际 Checker 负责纯类型诊断。完整 specifier（包括 query/fragment）保持身份，Oxc 不能修复 Native miss。Framework 的映射、能力和调度仍由各自适配器负责，不能把 runtime-use 升格为 Native reference。

JSDoc 定位将既有 occurrence 绑定到真实解析 AST 节点，并覆盖所有相邻注释块；TypeScript 公开的 tag ownership helper 会遗漏部分编译器请求。[定位器](../../../packages/limina/src/core/typescript-semantic/source-file-literals.ts)保留精确 UTF-16 范围与节点身份，不发现新请求、不伪造 SourceFile，也不只凭 specifier 解析。框架类型查询将脱离 Program 的候选重新绑定到当前 Program，并要求其 inventory 包含同一个 JSDoc 字面量后才查询 Symbol。元数据缺失、范围不匹配或歧义仍为 scoped unavailable；已定位的编译器 miss 保持 missing，独立观察继续保留。[JSDoc 回归](../../../packages/limina/src/__tests__/jsdoc-semantic-location.spec.ts)覆盖原始 node:test 注解、重复 occurrence、@import、被忽略的文档、noResolve 和物理截断。缓存 adapter 身份使旧观察失效；不改变 roots、编译器选项、references 或发现权威。

框架支持输入展开在一次解析源码批次中定位合格模块 occurrence，匹配 specifier 和精确范围，并拒绝歧义节点。索引只在本次展开内存在；可变 AST 与后续上下文重新读取。CommonJS 收集器在遇到首个字面量调用候选时才建立词法作用域图，仍保留全文件遮蔽、别名和重新赋值检查。这消除了重复 AST 工作，不改变准入、解析或发现权威。[Import 收集测试](../../../packages/limina/src/__tests__/import-analysis.spec.ts)与 [occurrence 回归](../../../packages/limina/src/__tests__/jsdoc-semantic-location.spec.ts)同时保留计算量边界和语义反例。

## Locked resolution 与 framework preparation

[checker-resolution-provider](../../../packages/limina/src/core/import-analysis/checker-resolution-provider.ts) 的 locked routes 将 Oxc 设为 null。checker miss 保留 miss；runtime/resource 分类不能补一个 semantic target。此限制适用于该调用链，不能扩张成“Oxc 在 Limina 的所有分析中都不产生 evidence”。Astro pre-semantic eligibility 只跳过已知 virtual specifier、纯粹的显式非源码扩展名和 Oxc 识别出的 resource 目标；query 或 fragment 语法不是 skip authority，完整 specifier 会到达 Astro adapter，其结果照单接受。

[PreparedDependencyFact](../../../packages/limina/src/core/framework-semantic/contracts.ts) 保留 occurrence、mapping、原始解析及结构 redirect 证据。Native 使用独立编译义务证明，框架保留自身适配器判定，完整 observed miss 不同于观察不可用。Pending 观察产生 dependency-semantics failure，不能发布完整图。不同 provider 必须有可归因的 Checker 结构；路径和扩展不能制造 positive TypeEvidence。

[框架支持贡献](../../../packages/limina/src/core/framework-semantic/support-contributions.ts)在 Astro/Svelte 的完整依赖 preparation 中从各适配器现有 Program 和 Resolver 收集。物理非 Root 支持输入保留 direct-source 来源；生成代码继续要求既有源码映射。模块 import 和合法 path/types 指令可以贡献义务，但不会成为 Roots。已归属其他 Scope 的实现内部依赖由其自身分析。治理层排除外部支持目标，保留 workspace 目标；声明文件中的 JSDoc 示例不属于编译 occurrence。仅解析的 preparation 仍保持惰性。

统一的是依赖事实与编译义务，解析器、虚拟文件映射和 Program 生命周期仍由各适配器管理。Vue→Vue 继续依据能力选择 declaration-provider；Astro/Svelte 的组件关系可由治理层选择 framework-schedule。Limina 观察真实 Project Reference Redirect 结构，不重新推断其生产者，不把推断引用回灌 discovery，也不持久化 Program、AST 或 Symbol。

| Family     | 实际语义通道                                                                                                                                                                           | 必须保留的限制                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript | 编译器驱动的物理 Coverage-bounded Program                                                                                                                                              | collection 保留 roots 和合法支持贡献；支持输入不因此取得 Ownership                                                                                                       |
| Vue        | 由 Vue source profile 区分 native channel 与 Vue host/service script；[resolution](../../../packages/limina/src/core/vue-semantic/resolution.ts)                                       | 需要匹配的 VueSemanticIdentity；普通 native TS occurrence 不必都通过 SFC source map。strict mapping 失败不能任意挑另一段映射                                             |
| Astro      | [context](../../../packages/limina/src/core/astro-semantic/context.ts) 的 lazy language-service Program、Astro 类型环境和 generated snapshots；其他原生 channel 可走 TS                | root/config/toolchain 决定上下文；不能把能读取某邻接扩展等同于全部 framework checker 功能                                                                                |
| Svelte     | leaf-owned svelte2tsx / compiler / TS，TS host 解析 generated script；[module-resolution](../../../packages/limina/src/core/svelte-semantic/module-resolution.ts) 保留 occurrence mode | 显式 `.svelte` 解析不传 occurrence mode；虚拟 `.d.svelte.ts` 只在实际源存在且没有真实 `.svelte.d.ts` 时映回 source；真实 declaration 优先，无第二套 package exports 解析 |

Svelte adapter 的边界是 source transformation、generated host、严格 source mapping 和该 host 的 module resolution；它不加载完整 `svelte.config` / preprocess pipeline，不能据此承诺所有 svelte-check 配置同构。native `.ts/.js` 仍按 native roots/facts 枚举。生成图中 Astro/Svelte 是完整 leaf typecheck targets，不生成 declaration wrappers 或透明 build solutions。

Toolchain 来源、accepted versions 和 capability checks 以 [checker](../../../packages/limina/src/checker) 中具体 resolver/runtime 与各 framework context 为准。source adapter 接受一个版本范围，只证明代码的 admission 条件；已安装 tuple 的测试只证明该 tuple 的样例。跨 minor、Windows、未安装 optional checker 仍需相应验证。

具体 tuple owner 是 [Vue compatibility](../../../packages/limina/src/checker/vue-semantic-compatibility.ts)、[Astro compatibility](../../../packages/limina/src/checker/astro-semantic-compatibility.ts) 和 [Svelte toolchain](../../../packages/limina/src/core/svelte-semantic/toolchain.ts)。Vue 从 vue-tsc 解析 Language Core/Volar/TypeScript；Astro 从 check-owned Language Server 解析 compiler，不能用 workspace-root retry 隐藏 leaf 缺依赖。路径用于 provenance/instance identity，不是 pnpm 布局兼容谓词。

截至 **2026-10-01**，Astro check 准入使用共享的 external-checker 契约 `>=0.9.6 <0.10.0`，并保留既有 `includePrerelease: true` 策略。Language Server、compiler 和 Volar 继续要求精确 tuple 与 internal API shape；不受支持的组合仍按 [I04](./invariants.md) fail closed。[Astro toolchain 守卫](../../../packages/limina/src/__tests__/astro-semantic-toolchain.spec.ts)覆盖版本与预发布边界，[打包消费者守卫](../../../smoke/consumer.spec.ts)覆盖实际安装的 `0.9.6` 搭配 TypeScript `5.9.3`，以及 `0.9.10` 搭配 TypeScript `6.0.3`。这些样例不能证明未来所有补丁或预发布版本都兼容。

Svelte [source-mapping](../../../packages/limina/src/core/svelte-semantic/source-mapping.ts) 要求 generated dependency 每个 UTF-16 offset 被明确 segments 连续、单调映射到当前 source；部分覆盖、cross-source 或非连续映射产生 mismatch，完全未映射保留 unmapped observation。[generated-script](../../../packages/limina/src/core/svelte-semantic/generated-script.ts) 构造 TraceMap 不加 map URL，避免 absolute Windows source drive 被再次 rebasing。Vue/Astro 则通过自身 mapping 算法处理 full-token/inner-content、ambiguity 与 mismatch，不能把一种框架的 map 条件套给全部框架。

实际消费者 occurrence 提供 package exports 解析。Graph check 与 graph export 消费同一套保留的 checker facts；两者都不构建 eager exports index、不尝试第二个 profile，也不以 runtime evidence 修复 checker miss。Self-name、conditions 与框架映射遵循所选 checker。[Vue 守卫](../../../packages/limina/src/__tests__/vue-semantic.spec.ts)及 [Astro/native 守卫](../../../packages/limina/src/__tests__/workspace-export-resolution.spec.ts)使用真实消费者；Svelte 守卫使用组件生成依赖。条件行为仍取决于工具链版本。

Vue 语义上下文中的原生文件使用同一套 Vue 所属 TypeScript 实例、语言服务 host 和编译选项计算模块格式。因此，懒加载的 SourceFile 对 .mts、.cts 和受包作用域影响的 .ts 文件选择与最终 Program 一致的 import/require 条件，无须仅为确定格式而构造 Program。[Vue 语义回归](../../../packages/limina/src/__tests__/vue-semantic.spec.ts) 将懒加载解析与实际 checker 的类型提供者比较，并断言 Program 仍保持懒加载。

默认原生 `tsc` 执行使用 Node 调用从 Limina 安装位置解析的 `typescript/bin/tsc`，与运行时依赖预检和原生语义分析保持同源。执行目录的 `.bin` 和环境 PATH 不能选择另一版 TypeScript。显式内部 runner 命令覆盖保留所请求的命令及参数契约。[命令来源测试](../../../packages/limina/src/__tests__/checker-command-origin.spec.ts)在没有 PATH 的情况下检查实际编译器版本，并保留 build/watch 与覆盖命令参数。

## 配置投影的边界

输出 target 的继承保留 TypeScript 数组顺序，即使同级分支共享祖先也一样。继承解析、环诊断和有效选项由 TypeScript 配置解析器负责。框架意图读取实际解析得到的配置闭包，包括包的 `tsconfig` 入口、带点文件名和无后缀文件；解析失败不能静默回退为默认 target。[Compiler target 回归测试](../../../packages/limina/src/__tests__/compiler-target.spec.ts) 将菱形、深层、重复、反向顺序和自身覆盖情形与 TypeScript parser 对照。

[Compiler overrides](../../../packages/limina/src/core/build-graph/compiler-overrides.ts) 通过[类型入口投影](../../../packages/limina/src/core/build-graph/type-input-projection.ts)保持源配置实际选中的 config type-directive 入口。不能直接重定位相对字符串：竞争的 `typeRoots` 候选可能先被源配置选中。直接、继承、绝对和自动／通配入口保留编译器选择，源 miss 不得变成无关 generated hit；不补多余边、扩张 roots 或删除 `typeRoots` 掩盖偏差。

[标准库投影](../../../packages/limina/src/core/build-graph/library-projection.ts)在生成配置改变查找起点时保持 TypeScript 的库选择。它通过已有适配层复用当前编译器的 `libMap`、Program 库请求与 `resolveLibrary`，不另建 Resolver 或 Checker hook。不加载源码的目录探测向编译器查询全部合法库名，使显式、隐式及声明引入的库请求保持逐名称的选择；这些探测不增加源 roots、Native facts 或 references。`outputs.target` 仍可激活不同的默认库集合。受影响的包族通过生成的 package manifest，将 `types` 指向原来选中的文件，包括同族入口的内置库回退。TypeScript 仍以库角色加载这些文件，保留文件身份、相对依赖及 `skipDefaultLibCheck` 行为。不复制声明内容、不把库改成普通 configured type，`libReplacement` 继续继承。

库回执独立于类型指令回执，绑定实际编译器、源／生成配置及选中目标。源查找查询保留已观察的正负候选；投影探测验证暂存映射，不把生成目录物化前的状态保留为不可变的源证据。持久图恢复要求这些回执及准确的暂存 manifest；缺少回执的旧图重新采集。执行前检查已物化 manifest 的字节，并重新计算源／生成配置的实际库选择，之后才允许 Checker 启动。恢复和准入也会运行这些不加载源码的投影探测；Native context 缓存命中不表示整条命令完全不创建 Program。[标准库回归](../../../packages/limina/src/__tests__/library-projection.spec.ts)覆盖真实 Checker 产物、默认库检查、配置／指令／默认入口、输出 target、跨进程恢复、候选变化及 manifest 篡改拒绝。

`TypeInputProjectionReceipt` 仅证明 `config-type-directives` 入口保持，不代表完整类型环境或全部请求关系等价。现有 `outputs.target` 选择及默认值继续有效，默认库集合不同本身不是错误。独立的[输出投影](../../../packages/limina/src/core/build-graph/output-projection.ts)检查实际输出治理依赖是否被既有输出关系覆盖；未覆盖或无法观察的输入报告能力限制和来源链，不扩张源图、不推断任意声明生产者。新进程分别校验类型入口保持与输出有效性。类型入口选择和证明查询使用同一观察解析缓存；图回执保留生成入口选择所用的查询，使后续局部变化在干净恢复后仍可复用它们。

Vue 输出投影复用现有 `vue-tsc`／Vue Language Core／Volar provider 和共享声明闭包策略。[独立输出 identity](../../../packages/limina/src/core/vue-semantic/output-identity.ts)保留源 roots、profiles、配置闭包及工具链，并应用有效输出编译选项。Vue Owner 下的原生文件和映射后的 SFC 依赖均通过该 provider 重新收集；源与输出 target 可以不同，但每个受治理输出需求必须已有输出引用。缺失 identity、不支持的观察及未覆盖依赖继续 fail closed。[生成图回归](../../../packages/limina/src/__tests__/generated-graph.spec.ts)通过真实 `vue-tsc -b` 产物检验两个 target 方向，并独立移除输出关系作为负例。不新增依赖或第二套框架 Resolver。

推断引用可以前向指向随后由有序 `tsc -b` 创建的声明。不要求构建前 Checker 诊断成功或产物已存在，也不许可陈旧输出成为 discovery 证据。生成配置不能建立源 Checker 权威。

治理层的 source type leaf 不允许手写 `references`；[config reader](../../../packages/limina/src/core/build-graph/generated/config-reader-basics.ts) 拒绝该形状，solution 负责聚合，`implicitRefs` 记录明确动态/虚拟关系。底层 semantic context 支持 raw references，不等于治理层放宽 leaf shape。[generated-configs](../../../packages/limina/src/core/build-graph/generated-configs.ts) 将 declaration outDir/declarationDir 指向同一 managed dts root，防继承输出改写；`rewriteRelativeImportExtensions` 仅在 effective source 启用时覆盖，避免无条件引入旧 compiler 不认识的 option。为声明输出关闭 rewrite 时，必须通过启用 `allowImportingTsExtensions` 保留其隐含的 TS 扩展名导入许可，包括 source 未设置该选项或显式设置为 false 的情况。TypeScript 以这两个选项的逻辑或计算有效许可，声明专用输出允许显式开启该许可。[generated-graph 回归](../../../packages/limina/src/__tests__/generated-graph.spec.ts) 通过真实 `tsc -b` 覆盖 source 许可的三种状态，并检查声明中的模块标识符保留 TS 扩展名。[Graph parity](../../../packages/limina/src/graph-check/dts-typecheck-parity.ts) 与 [Proof parity](../../../packages/limina/src/proof/declaration-parity.ts) 比较该有效许可，而非原始写法，包括两份配置都没有显式许可键的情况。真实的许可增加或丢失仍产生诊断，不将该选项豁免于一致性校验。支持的 solution 不带 outputs。

Managed-output lookup 可解释明确管理的输出，但不能将声明消费升级为源码关系。Locked ownership 和 coloring 保留有资格的已解析实现需求，真实 reference redirect 不提升 consumer Checker。框架调度使用合法源码需求及既有 Checker 能力。修改这些边界时应联合检查 [I03–I07](./invariants.md)，包括实际生成配置构建，不能只看 Resolver 命中。

## 受管声明的配置上下文

[上下文决策](../../../packages/limina/src/core/build-graph/declaration-context-decisions.ts)将声明消费连接到当前 Coverage。完整且唯一的 Coverage 自动选择 B，不要求 Emit 资格。多个配置合法覆盖同一声明时，外部消费者通过 `liminaOptions.declarationContexts` 选择，否则保留 `awaiting-selection`；证据不完整时为 unavailable。本地 roots 保持本地角色，不生成 self-reference。绑定到请求的 noResolve 证明只排除该 module occurrence 的声明政策贡献；roots 和独立 types 请求保留各自的输入责任。解析命中、不产生 emit 义务与输入引入资格不能互相替代。Native module 加载授权使用源文件的有效选项；实际 configured/automatic types 请求保留独立授权路径。file/config 路径相对消费者 ordinary source config，不支持 glob，也不继承全局 owner；implicitRefs 是独立的项目关系。

[政策贡献](../../../packages/limina/src/core/build-graph/declaration-context-references.ts)复用 declaration-provider 边与 Checker 相等约束，不修改 NativeCompilationObligation。正常政策停止表示 bounded 观察完成，但候选必要条件未满足。未被消费的共享声明不会制造全局歧义错误。

[候选验证](../../../packages/limina/src/core/build-graph/declaration-context-validation.ts)解析暂存的声明/output 配置，检查实际引用闭包与声明输入映射（包括没有 outputDts 的输入），将委派请求、mode、目标及 callback redirect 与 owner 的独立观察比较。引用闭包决定映射是否合法，不代表消费者 Program 实际加载的声明集合。仅对候选实际加载的声明比较委派请求；当前消费者自己的消费决策仍必须加载。完整的 own ambient inventory 证明不要求 resolver callback redirect。resolved 和已完成的 unresolved module/type 请求仍须证明使用选定上下文；unavailable 观察不能生成 admitted receipt。实际可达的竞争映射与引用环不论排序如何都拒绝。只有被外部选中的 provider 必须允许检查声明；skipLibCheck/noCheck，或作用于该 provider 自身观察到的默认库声明的 skipDefaultLibCheck，不能兑现这项责任。普通本地消费保留自身检查选项及 root 映射保护；同一配置兼任外部 provider 时仍承担严格责任。框架对自己的声明 roots 保留既有分析能力，新的资格门控用于跨项目委派。当前取得资格的 Checker 是原生 tsc；未取得资格的 Checker 与 command override 返回 unavailable。版本/API 能力缺失时不回退到消费者选项。

B 的项目检查与 A 的模块解析重定向是两个承诺。A 保留自己的 TypeChecker 选项。增量构建可以复用此前检查；候选 receipt 证明配置/解析绑定，不表示本轮 Checker 已重新检查成功。Generated-graph、full-analysis-cache 和 execution-admission 回归分别保护这些边界。
