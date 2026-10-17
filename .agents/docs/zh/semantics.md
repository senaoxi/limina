# Limina 语义事实

[English](../semantics.md) | [简体中文](./semantics.md)

本页解释 dependency fact 如何产生及其能力边界；实体和 relation 定义归[系统模型](./system-model.md)，不可意外改变的性质归 [I02–I07](./invariants.md)。本页描述当前 adapter 的行为，不宣称与所有上游版本的完整 checker 完全等价。

## 从 ownership 候选到 locked context

[checker-ownership-resolution](../../../packages/limina/src/core/build-graph/checker-ownership-resolution.ts) 先 discovery、root evidence、dependency facts 与 requirements convergence，再 freeze semantic authority，最后进行 Vue promotion、build coloring 与 finalization。[semantic-authority](../../../packages/limina/src/core/build-graph/checker-semantic-authority.ts) 只接受 explicit、config、root-file、dependency 作为语义锁证据；build-closure、fallback、solution-constraint、vue-promotion 不重写语义。

Pending discovery 使用 [pending-facts](../../../packages/limina/src/core/build-graph/checker-ownership-pending-facts.ts) 的 native dependency context。framework inference 只接受合格的 `missing + pending-framework-candidate` fact。[physical candidate](../../../packages/limina/src/core/build-graph/checker-ownership-physical-candidate.ts) bootstrap 中，Oxc 提供物理候选，还需已知 framework extension、governed effective membership、唯一 config 和语义域，才形成 ownership requirement。普通 TS/resource 路径不凭物理命中锁框架。native source requirement 支持编译关系，不提供 framework semantic authority；物理 declaration resolution 即使 evidence 为 missing 也禁止 Oxc bootstrap。带 query 或 fragment 的 specifier（如 `./Widget.svelte?x`）同样不 bootstrap physical candidate：checker 没有给出 target 时，Limina 无权通过 Oxc 或文件系统重新解释宿主语法。canonical fallback 后，Vue custom profile 使用 owner 登记的路径匹配。

Locked [ProjectSemanticContext](../../../packages/limina/src/core/project-dependencies/contracts.ts) 在类型层要求 `LockedSemanticAuthority`。它与 pending discovery 是不同入口；构造函数复制 authority 不等于对任意 JavaScript 伪造对象做完整运行时认证。生产调用合法性来自求解流程和类型边界，不能把它写成不可绕过的安全 capability。

## 一个项目的原生语义输入

[依赖 context](../../../packages/limina/src/core/typescript-semantic/index.ts) 对自有 TypeScript **6.0.3** 实例上的物理 TypeScript／TSX 输入使用无 Program adapter：提取共享语法，按消费方的有效选项和模块形态绑定请求，通过 TypeScript 的 module／type／path／lib 通道解析，再遍历有资格的支撑闭包。冷收集和变化文件重算不需要分析 Program 或 TypeChecker。显式 proof API 以及实际 Checker 的诊断／emit 保留各自的编译器生命周期。

[有效 roots](../../../packages/limina/src/core/typescript-semantic/effective-roots.ts) 仍由 Checker 配置解析得到。声明是一等分析节点，不自动成为 Source Config、Owner 或构建任务。A 到达的声明若合法依赖 B 所属实现，可贡献 A→B；B 内部依赖 C 仍由 B 贡献 B→C，不追加 A→C。移除一个入口不影响声明的其他独立入口；最后入口退出后，不可达声明环的贡献必须撤销。

Consumer 包含 JS、虚拟输入、原始项目引用、不支持的编译器或遍历中新到达的不支持输入时，整体切换到既有 bounded adapter。尚未完成的新闭包不发布；可以复用已完整验证的中立语法／解析事实，但不能把部分新贡献与旧成功图拼成完整结果。记录收集方式和能力原因，输入变化后重新判断资格，移除不支持依赖可恢复无 Program 路径。完整 Resolver miss 不触发切换。Bounded 稳定化要求 admission revision 有进展，最多尝试 32 次。

原始 references 只来自源码／解析配置；推断引用不回流 discovery。兼容 adapter 将编译器真实引用映射记录为独立的原始目标、声明目标、引用配置和输出可用性。输出存在或缺失都保留结构，不重新产生源码关系。只有明确引用的正向映射可以许可预期输出尚未生成；不读取陈旧输出，也不伪造内容。直接消费 `.d.ts` 不标识其生产者，无论文件位于源码目录还是 dist。

## 持久化 importer 有效性

[共享文件事实](../../../packages/limina/src/core/typescript-semantic/file-dependency-facts.ts) 保存 occurrence、位置、请求模板、源码显式属性、模块形态与隐式请求触发因素。[上下文绑定](../../../packages/limina/src/core/typescript-semantic/context-requests.ts) 具体化 JSX／helper 请求和有效 mode。同一份 TSX 文本可以共享提取结果，同时在不同 context 中分别产生 React 和 Preact runtime 请求。

复用同时要求语法内容有效、请求上下文等价、查询观察依赖仍有效。Topology fingerprint 相同不足以复用已绑定请求。仅位置变化也更新 line、UTF-16 offset、locator、sourceVersion 和贡献来源；重复 specifier 保持不同 occurrence。Resolver 观察包括成功／失败探测、package scope、有序 manifest conditions、目录、绑定及 redirect context。Importer 内容未变时，候选、mode 输入或观察到的配置变化仍使查询失效。

[无 Program capture](../../../packages/limina/src/core/analysis-cache/programless-capture.ts) 发布完整 consumer 闭包和查询订阅。新进程恢复校验普通 DTO、有效 roots／options、收集身份、当前边界／归属输入、环境及安装证据；拒绝不完整、陈旧和旧 schema 记录。变化 consumer 遍历缓存邻接关系，只重算失效查询，未变化文件不重复解析。V1 可以保守重跑全图 coloring、SCC 和构建校验；访问缓存节点不同于重新读取、解析所有文件。

缓存支持自有 TypeScript 实例和物理 host；`tsc` 与 `tsgo` 保持不同 Checker 身份，不在此模型缓存完整诊断或 emit。完整兼容 context 也可无 Program 恢复，但输入变化必须重新评估能力。配置、host 或安装证据 unknown 时不恢复持久化结果。访问策略、事务及发布边界见[生命周期](./lifecycle.md#原生持久化分析缓存)。

[Vue analysis records](../../../packages/limina/src/core/analysis-cache/vue-records.ts) 支持没有自定义 Vue 插件的物理项目，版本范围限定为 TypeScript 6.0.3、vue-tsc 与 language-core 3.2.4、Volar TypeScript 2.4.27。稳定 identity 包含有效选项、原始 references、source profiles、config closure 和 toolchain identity；运行期 generation 在恢复时重新绑定。受支持的 preparation facts、映射解析及 resource type evidence 使用已校验 DTO，在取得 Vue live context 前查询。查询覆盖必须完整。Host 读取、完整 manifest 内容、成功与失败探测、目录／路径绑定、生成脚本／映射摘要和安装环境构成 context receipt。未观测的目录枚举及 unsupported／opaque 结果不能授予完整性。工具模块字节和绑定在每次调用重新观测。Vue collection 使用现有 Vue context 观察直接源码依赖和支持输入，并将这些查询的覆盖与 resolution、preparation 分开记录。

混合图要求所有贡献的 native 与 Vue context 都完整。图中的 Vue 引用恢复为当前解析的 identity；Program、AST、Symbol、可执行 host、插件对象和 artifact authority 均不进入 DTO。自定义插件、虚拟输入及 Astro／Svelte 继续冷回退。[Vue 缓存回归](../../../packages/limina/src/__tests__/vue-analysis-cache.spec.ts)覆盖独立进程、失效、残缺记录、运行期 generation 和缓存访问策略。这仅复用分析；checker 诊断与 emit 仍由 checker 执行。

## Occurrence、证据与建图需求

数据流为：共享语法 → 上下文请求 → 观察到的解析 → 有资格的 consumer 闭包 → occurrence 贡献 → Owner／Provider／Checker／policy 投影 → 项目边。运行时治理资格与编译支撑贡献资格分开，保留来源分类并进入同一投影路径；并非所有字符串或编译器请求都自动生成 references。

| 请求                                              | 资格及闭包规则                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| import、re-export、import type、字面量动态 import | 合法收集的 occurrence 使用 module 通道；有资格的目标扩展支撑闭包，但有效配置可限制加载。                                                                                  |
| CommonJS                                          | 受支持的词法 `require` 和不可变 `createRequire` 绑定属于治理请求。Shadowed 调用不宣称为 Node 加载；JS 兼容 context 中由结构证据确认实际加载的声明，仍贡献其自身合法依赖。 |
| ambient／augmentation                             | 脚本 ambient module 名称不是依赖；外部模块中的有效 augmentation 可保留已解析实现候选，但其名称不能单独准入声明。                                                          |
| 声明内 import 与 JSDoc                            | 合法声明导入独立贡献；仅作说明的 TypeScript JSDoc 不扩展闭包，JS 编译器请求依据兼容 adapter 的实际输入证据。                                                              |
| path／types／配置 types／lib                      | 分别使用自身编译器通道和有效配置；准入不改变 roots 或 Ownership。已从其他有效入口纳入的声明按独立入口分析。                                                               |
| JSX／helper                                       | 按有效编译选项、pragma 和模块形态具体化受支持请求；单独的 `jsx` 选项或字符串匹配不足以证明请求。                                                                          |

`noResolve` 不删除 occurrence，也不阻止对实现目标进行治理解析；它限制支撑闭包扩展，未加载的已解析实现仍可保留源码需求。`skipLibCheck` 抑制特定 Checker 诊断，不等于停止依赖加载。[无 Program 测试](../../../packages/limina/src/__tests__/programless-context.spec.ts)、[Native 测试](../../../packages/limina/src/__tests__/native-provider-evidence.spec.ts)和[生成图测试](../../../packages/limina/src/__tests__/generated-graph.spec.ts)负责正反例。

[需求判定](../../../packages/limina/src/core/dependency-semantics.ts) 依据完整解析和真实 redirect 结构，不查询 Symbol 或 TypeEvidence。物理实现产生源码候选；直接声明、完整 miss 或明确引用重定向不产生新源码候选。Unsupported、failed 和 unobserved 不能伪装成完整 miss。Ambient 类型、external-library 标记和 Program membership 不能单独取消已解析的受治理实现；最终仍经 Owner、deny、Provider 能力、关系类别和去重决定边。

TypeEvidence 保留为显式类型供给证明 API，请求时可使用 Symbol 和实际 Program identity；普通依赖存在性、引用投影和 Native 缓存资格不调用它。纯类型可用性诊断由实际 Checker 负责；source 检查保留物理资源存在性、包授权、源码归属和边界。

包含 query／fragment 的完整 specifier 保持原始身份。不删除 `?raw` 或 `#fragment`，不借 Oxc 修复 Checker miss，也不从声明扩展反推生产者。Checker 按精确 `paths` key 解析成功仍有效。[目标分类](../../../packages/limina/src/core/import-graph/declaration-classifier.ts) 独立描述物理目标，不等同于类型供给。

## Locked resolution 与 framework preparation

[checker-resolution-provider](../../../packages/limina/src/core/import-analysis/checker-resolution-provider.ts) 的 locked routes 将 Oxc 设为 null。checker miss 保留 miss；runtime/resource 分类不能补一个 semantic target。此限制适用于该调用链，不能扩张成“Oxc 在 Limina 的所有分析中都不产生 evidence”。Astro pre-semantic eligibility 只跳过已知 virtual specifier、纯粹的显式非源码扩展名和 Oxc 识别出的 resource 目标；query 或 fragment 语法不是 skip authority，完整 specifier 会到达 Astro adapter，其结果照单接受。

[PreparedDependencyFact](../../../packages/limina/src/core/framework-semantic/contracts.ts) 保留 occurrence、mapping、原始解析及结构 redirect 证据。Native 与框架共用同一需求判定，完整 observed miss 不同于观察不可用。Pending 观察产生 dependency-semantics failure，不能发布完整图。不同 provider 必须有可归因的 Checker 结构；路径和扩展不能制造 positive TypeEvidence。

[框架支持贡献](../../../packages/limina/src/core/framework-semantic/support-contributions.ts)在 Astro/Svelte 的完整依赖 preparation 中从各适配器现有 Program 和 Resolver 收集。物理非 Root 支持输入保留 direct-source 来源；生成代码继续要求既有源码映射。模块 import 和合法 path/types 指令可以贡献义务，但不会成为 Roots。已归属其他 Scope 的实现内部依赖由其自身分析。治理层排除外部支持目标，保留 workspace 目标；声明文件中的 JSDoc 示例不属于编译 occurrence。仅解析的 preparation 仍保持惰性。

统一的是依赖事实与编译义务，解析器、虚拟文件映射和 Program 生命周期仍由各适配器管理。Vue→Vue 继续依据能力选择 declaration-provider；Astro/Svelte 的组件关系可由治理层选择 framework-schedule。Limina 观察真实 Project Reference Redirect 结构，不重新推断其生产者，不把推断引用回灌 discovery，也不持久化 Program、AST 或 Symbol。

| Family     | 实际语义通道                                                                                                                                                                           | 必须保留的限制                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript | 物理 TypeScript 无 Program 收集及 consumer 级 bounded 兼容                                                                                                                             | collection 保留 roots 和合法支持贡献；支持输入不因此取得 Ownership                                                                                                       |
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

`TypeInputProjectionReceipt` 仅证明 `config-type-directives` 入口保持，不代表完整类型环境或全部请求关系等价。现有 `outputs.target` 选择及默认值继续有效，默认库集合不同本身不是错误。独立的[输出投影](../../../packages/limina/src/core/build-graph/output-projection.ts)检查实际输出治理依赖是否被既有输出关系覆盖；未覆盖或无法观察的输入报告能力限制和来源链，不扩张源图、不推断任意声明生产者。新进程分别校验类型入口保持与输出有效性。类型入口选择和证明查询使用同一观察解析缓存；图回执保留生成入口选择所用的查询，使后续局部变化在干净恢复后仍可复用它们。

推断引用可以前向指向随后由有序 `tsc -b` 创建的声明。不要求构建前 Checker 诊断成功或产物已存在，也不许可陈旧输出成为 discovery 证据。生成配置不能建立源 Checker 权威。

治理层的 source type leaf 不允许手写 `references`；[config reader](../../../packages/limina/src/core/build-graph/generated/config-reader-basics.ts) 拒绝该形状，solution 负责聚合，`implicitRefs` 记录明确动态/虚拟关系。底层 semantic context 支持 raw references，不等于治理层放宽 leaf shape。[generated-configs](../../../packages/limina/src/core/build-graph/generated-configs.ts) 将 declaration outDir/declarationDir 指向同一 managed dts root，防继承输出改写；`rewriteRelativeImportExtensions` 仅在 effective source 启用时覆盖，避免无条件引入旧 compiler 不认识的 option。支持的 solution 不带 outputs。

Managed-output lookup 可解释明确管理的输出，但不能将声明消费升级为源码关系。Locked ownership 和 coloring 保留有资格的已解析实现需求，真实 reference redirect 不提升 consumer Checker。框架调度使用合法源码需求及既有 Checker 能力。修改这些边界时应联合检查 [I03–I07](./invariants.md)，包括实际生成配置构建，不能只看 Resolver 命中。
