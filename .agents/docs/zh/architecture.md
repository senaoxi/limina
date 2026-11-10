# 仓库架构

[English](../architecture.md) | [简体中文](./architecture.md)

## Limina 边界

仓库安全／报告与外部工作流边界由[基建记录](./infrastructure.md)负责。两个产品通过 `LICENSE.md` 发布生成的第三方许可证 notices。构建期间校验 bundled dependency metadata，不再生成或发布独立 JSON inventory。这些许可证与仓库报告边界独立于 Limina 管理的 artifact namespace。

私有根包 `@limina/monorepo` 编排命令与共享工具。在这个 monorepo 中，`packages/limina` 承载公开核心包 `limina`，其中 `src`、`bin`、`schemas`、`fixtures` 和 `integration` 保留内部组织。第二个公开包 `limina-migrate` 位于 `packages/migrate`。发布目标仅为两个包生成的 `dist` 目录。迁移包仅将 `limina` 作为 workspace 开发依赖，构建时内联当前源码中需要的核心实现。两产品仍共享发布版本；发布态 migrate 没有 Limina dependency、peer 或 optional dependency，并显式声明自身运行依赖及能力 peers。核心包不反向依赖迁移包。Workspace 包通过 `limina/internal/*` 源码模块消费核心。`flow`、`core`、`utils` 和 `check-reporting` 目录使用通配符映射，其余入口采用显式映射。所有目标直接指向当前 `.ts` 源码文件。单文件入口 `limina/internal/flow` 单独映射到 `src/flow.ts`。这些同次发行入口仅供 workspace 使用；核心发布 hook 删除 `./internal` 及全部 `./internal/` 映射，同时保留正常 workers、公开 API、类型与 schema。Migrate 通过此 export map 解析并内联源码模块，不再依赖 migration 专用聚合入口。仅提供 CLI 的迁移包运行 publint 和运行时边界检查，安装后的 CLI 由 tarball smoke 测试覆盖；主包保留针对 TypeScript API 的 ATTW 检查。字段选择与交付验收遵循[依赖放置与打包](./dependency-placement.md)。

其他私有 workspace 为 `docs`、`smoke`、`packages/build-tools`、`packages/gates` 和 `packages/evals`。私有 `@limina/gates` 负责仓库的许可证、提交、隐私、发布与 ESLint 检查；根脚本与配置转调其明确入口，见[仓库门禁](./gates.md)。Fixture 仓库保留独立 workspace 清单和 lockfile，不纳入主 workspace。门禁包先于构建工具通过 TypeScript 自举，不调用 Limina。随后 Rolldown 构建产品，再执行治理与消费者检查。工具链与依赖版本由 [technology-stack](./technology-stack.md) 记录。

根级发布脚本、产品和 build-tools 均通过 dev catalog（`^0.0.4`）消费 registry Logaria，锁定为 0.0.4，不再需要兄弟仓库的 Logaria 构建。包生成器通过 pnpm 解析 catalog，并拒绝不支持的本地协议。

独立迁移包保留既有迁移事务和治理语义。旧 `limina migration` 命令优先转调本地同版本包，否则通过 npm 下载该精确版本。两个包共享版本、发布组和 `limina/v<version>` 标签。证据和独立性门见[迁移状态](./migration.md)，产品不变量见[Limina 架构](./limina.md)。

Vercel 部署 CLI 是既有私有 `docs` workspace 的开发依赖，通过 dev catalog 与冻结 lockfile 解析，不加入双包发布组；见[基建归属记录](./infrastructure.md)。

## 实现内聚与边界

实现按能力及其状态生命周期组织。只服务于该能力的类型、常量与 helper 可以与实现共置；独立文件应具有可理解的职责、稳定接口、适配器／进程边界或真实复用价值。文件长度与调用者数量是审查线索，不独立构成拆分或合并理由。Barrel 不提供边界时，可直接导入包内实现。[ESLint 策略](./gates.md#eslint-结构策略)将这些取舍交给职责审查。

| 区域         | 内聚实现与保留边界                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core 分析    | Build-script 解析、workspace export 展开、source-config collection、Coloring、生成配置 reader、Knip preparation、TypeEvidence 编排、Native 闭包投影和带标签缓存 codec 持有局部 helper。Source-config discovery 与 Coverage 仍独立于成功收集结果。Semantic authority、execution ownership、source ownership、coverage、compilation obligations 与缓存恢复资格仍是不同概念与 owner。框架／编译器适配器和受观察输入 reader 保留边界。 |
| 运行时与展示 | CLI 选项解析、execution setup/run、scheduler readiness、flow-task completion、checker-host pending request、dependency-plan 构造、配置观察诊断和局部 checker 解析与各自 owner 共置。Scheduler settlement、generation control、受管 mutation、输出发布和渲染状态具有不同生命周期。Checker host、renderer 与 migration verifier 进程入口保留 source/bundle 解析和资源归属。                                                          |
| 检查与报告   | Source／graph 阶段编排、dependency graph 的收集／边／模型、内置规则 predicate、ATTW adapter、单个 package entry 运行与单次 check recorder 共置局部操作。Detector 领域、Knip／进程适配器、proof 维度、归档清理和原子报告发布保持独立职责。Dependency graph 文档是观察结果，不是执行计划。                                                                                                                                           |
| 迁移         | 规划、membership 改写、JSONC／配置编辑与每次 invocation 的组执行共置局部状态和 helper。Transaction 入口直接负责 prepared-plan 执行与写入策略分派。声明引用 provenance、语义比较、output adoption、prepare/apply/rollback、新进程验证与审计发布保持不同阶段和 authority。                                                                                                                                                           |
| 仓库工具     | Gates 与 build-tools 保留明确包入口；根脚本继续作为命令／CI 适配器。文档采集、终端解释、回放和可视组件各自保留职责。Smoke 用例仍是安装后消费者边界。                                                                                                                                                                                                                                                                               |

上文的 package imports 与 workspace-only exports 仍是跨包访问合同。共置不扩张公开 exports、不延长缓存生命周期、不把实例状态提升到模块作用域，也不改变初始化、错误、Promise 或释放语义。[架构 workflow](./architecture-workflow.md)负责这些审查；结构验收同时遵循[开发 workflow](./development-workflow.md#验证与交付)。

## 可分发的智能体技能

[`skills/limina`](../../../skills/limina/SKILL.md) 负责可安装的消费者技能，与承载仓库维护流程的 `.agents/skills` 分开。该技能改编自 [docs-islands 的 `1e79a5859ec667e86ceea83fa28c04b9f6bf9ed8`](https://github.com/senaoxi/docs-islands/tree/1e79a5859ec667e86ceea83fa28c04b9f6bf9ed8/skills/limina)；独立许可证保留上游 MIT 声明。这是源码迁移，不表示已经远程安装或发布。

入口保留任务选择和必要边界；五份参考资料分别覆盖配置、CLI 工作流、归属、包检查与诊断。示例以随附源码为依据，在其他项目中操作时则以该项目安装版本的帮助、公开声明、Schema 和对应源码为准。技能不要求消费者拥有 Limina checkout，不强制使用 pnpm，不将内部导入暴露为公开 API，也不授权升级或发布。

产物检查指导区分临时打包与检查状态写入、依赖安装、registry 访问和发布，保留任务的实际权限及结构化报告合同，区分未执行、失败和覆盖不完整，不从 registry authority 错误推断产物检查结论。这些是通用操作规则，不包含评测题号、预期报告值或评分答案。

命令、配置、检查器支持、根发现、缓存或包行为变化时，随源码 owner 同步维护对应技能参考。保留任务指南定位，不另建完整 Schema 或 issue code 目录。[Init 安装命令](../../../packages/limina/src/commands/init/shared.ts)以及[英文](../../../docs/en/cli.md)、[中文](../../../docs/zh/cli.md) CLI 指南均指向 `senaoxi/limina --skill limina`。既有 [init 测试](../../../packages/limina/src/__tests__/init.spec.ts)覆盖接受安装时的命令及跳过安装时的提示；拒绝提示和安装失败继续使用各自独立的用例。技能迁移改变安装目标，不改变治理身份、关系或缓存生命周期。

## 独立 Skill 评测

私有 [`packages/evals`](../../../packages/evals/README.md) workspace 负责 Skill 实验控制端及适配器，与产品运行时依赖和消费者 smoke 测试分开。它实现本地执行、26 项任务校准及预登记的对照流程；实验是否完成及其结果由经过验证的控制端记录确定。仓库检查不得启动模型评测。

执行边界采用固定版本的本地 Codex、ChatGPT 认证及其原生沙箱，并使用独立的本地 Docker verifier。认证保留在原宿主存储中；Agent 工具不获得凭据文件、宿主管理 Socket 或控制端访问权限。控制端先按 TaskSpec 验证修改权限与依赖变化，再重建评分输入。F0、准备后的 S0 与最终 S1 分别记录；不完整证据不能产生通过结果。Grader、封存验收资料及结果存储必须位于 Skill 修订环境之外。全局预算与用量记录覆盖诊断、失败及补跑，不用虚构值代替缺失测量。评测包 README 记录当前实现限制；局部探针通过不代表完整实验验收通过。

每个原生客户端使用全新的控制端专属 `CODEX_HOME`，只委托访问规范路径下的宿主认证文件，不复制宿主全局指令、配置、技能或插件；客户端进程结束后移除认证委托。[原生提示词检查](../../../packages/evals/src/runner/local-codex.ts)在预算预约前以零推理方式检查已经组装的输入，不继承正式执行的轨迹写入器。新的[轨迹捕获](../../../packages/evals/src/runner/native-trace.ts)还会拒绝注入的 `AGENTS.md` 指令消息；历史轨迹读取保留原合同。Evals 的隔离目录生命周期和轨迹反例测试提供最近的可执行边界。

任务卷的父目录不得继承宿主 Git 仓库或祖先 package manifest。否则原生 release check 可能在检查给定产物前读取无关祖先 manifest，而 Docker 只观察隔离根。应选择干净、规范的临时父目录，不扩大宿主读取权限。题面必须明确授权所需的临时打包与检查状态写入，并声明结构化报告的类型和路径基准。澄清题目会改变 Bank 内容身份，不能据此削弱产品断言或改写旧校准及成绩。

Token 完整不代表货币已经结算。[预算账本](../../../packages/evals/src/core/budget.ts)将历史上由 Token 推导的 inclusion／零金额标签解释为财务未知，并保留原始日志。独立货币证据可以追加，但不能改变已经完整的 Token 测量。报告区分已观察实际金额、缺失的货币证据及附条件的派发策略上界；符合套餐内执行条件不等于取得美元账单。财务报告使用独立的源码身份，对所有条件统一适用；恢复实验仍要求原冻结执行与评分输入。候选准入依据其独立的套餐内预约及完整用量与轨迹，不要求货币 inclusion 标签。刷新原生额度时，自动充值设置观察仍保留自己的来源与时间。

[预估 API 等价值](../../../packages/evals/src/core/estimated-cost.ts)是独立的派生测量。其控制端只读取明确选择的运行及完整性校验通过的原生捕获，以冻结的公开价格快照逐请求计价，将缓存读取视为输入的子集，并保留缺失或不支持的用量为未定价。报告记录计算、价格和输入身份；保留失败尝试及补跑，不改写执行日志、评分或实际支出账本。这不代表订阅账单或实际扣除的 Credits。[评测 README](../../../packages/evals/README.md#estimated-api-equivalent-cost)负责命令和已准入的价格覆盖范围。

轨迹闭合与 Token 覆盖分别判断。已记录的 `inference_failed` 是终止事件，其未返回的 Token 用量仍为未知。缺少终止事件或引用的 payload 仍会使轨迹不完整；已知 Agent 错误及不完整终态不能变成通过。已返回的部分计数仅为观察值之和，不是完整总量。尝试结束后，只有重新确认的套餐内零付费准入可以在用量部分缺失时继续执行，付费派发仍被阻止。Runner 变化使用新的 campaign 身份及完整预登记批次，保留原记录与同一全局预算。

捕获范围属于 TaskSpec，并参与执行与评分身份。运行缓存的排除规则不能遮蔽 fixture 输入、授权项目修改、必需产物或 Skill 状态；涉及缓存行为的任务必须保留相关缓存状态。评分预算是重建、容器启动及命令共用的单调时钟阶段期限，不能为每条命令重新计时。Docker 客户端被终止后即使返回退出码零，也仍属于超时。见[捕获策略](../../../packages/evals/src/core/capture-policy.ts)与[评分期限](../../../packages/evals/src/core/deadline.ts)。

任务校准必须证明命令实际检查了预期目标。[入口覆盖](../../../packages/evals/src/graders/C02.ts)与[排除入口闭包](../../../packages/evals/src/graders/R03.ts) Grader 对 TypeScript 使用真实 checker build 和指定源码的诊断；仅面向框架的 typecheck 可能以 disabled 状态成功退出。它们在构建后读取新生成的 manifest，并控制自动入口发现，避免其掩盖显式 solution reference 缺失。引用顺序和目录别名属于语义等价，不应导致评分失败。

各任务可以固定不同的依赖闭包；为某项任务安装框架 peer，不能消除另一项任务的缺失 peer 条件。Vue checker 校准需要项目内依赖路径：固定产品在使用外部 node_modules 符号链接时无法解析生成的辅助声明，即使直接运行 vue-tsc 可以通过。[DockerVerifier](../../../packages/evals/src/runner/docker-verifier.ts)可以从固定镜像填充全新的匿名依赖卷，并只读挂载到项目路径。Preflight 将其内容与准入依赖包逐字节比较，并测试禁止写入与替换；清理时删除匿名卷。原生 Agent 配置也将项目 node_modules 设为只读。可写依赖副本仅用于诊断对照，不能作为可信评分输入。

Agent 准备阶段复制 TaskSpec 授权的冻结依赖树，并仅在排除捕获的依赖目录内创建已声明的相对 workspace 链接。复制前后均核对完整依赖树；原生配置将根目录及嵌套的依赖路径设为只读。完整 Skill 在 S0 前安装，并在评分时从冻结字节重建。执行后的依赖完整性与项目 diff 证据分别记录；完整性未知时不能通过评分。APFS 项目位于私有卷的子目录中，因此无需为操作系统卷元数据增加 Agent 路径捕获排除。见[任务 workspace 准备](../../../packages/evals/src/runner/task-workspace.ts)。

Verifier 内存限制冻结在工具链身份中，同一任务的各实验条件必须一致。适配器仅接受 1024 MiB（默认）或 2048 MiB。框架运行时归档可能超过项目快照容量，因此依赖包 preflight 使用独立的 512 MiB 字节上限；这不会扩大 Agent 项目捕获排除范围，也不会放宽完整性检查。资源变化与其他工具链变化一样，会使校准身份失效。

Verifier 必须禁止 pnpm 在 run/exec 前隐式安装依赖。固定调用参数及嵌套命令环境要求离线运行并忽略安装脚本，仅对已经准入的不可变依赖闭包关闭运行前依赖安装。仓库全局依赖准入保持不变；显式安装计划仍须使用冻结输入和 lockfile。脚本评分必须保留 shell 命令边界：把换行归一化成参数分隔符，会把实际失败的脚本判为成功。[输出工作流 Grader](../../../packages/evals/src/graders/W02.ts)在执行固定工具前验证有界的单行语法。

Data-only 配置仍可声明可执行的 pipeline 步骤。因此，TaskSpec 的 pipeline 权限须在 verifier 准入前约束内置任务、外部命令及固定脚本参数前缀，并拒绝环境变量和工作目录覆盖。JSON 字段权限也适用于静态解析的 Limina 配置，编辑 pipeline 不代表获准修改治理规则。解析过程不得求值提交的模块。共享验证逻辑变化会使原校准身份失效；保留历史证据，并在正式派发前重新校准。

[静态配置读取器](../../../packages/evals/src/core/static-config.ts)将括号和 TypeScript `satisfies` 约束视为不改变值的包装，嵌套字面量值也适用。来自 Limina 的纯类型导入不增加运行时能力；唯一允许的值导入仍是 `defineConfig`。内部字面量、字段和 pipeline 权限继续生效。函数、getter、计算属性名、展开表达式及任意调用仍被拒绝。静态准入不代表类型正确，独立 Grader 仍须拒绝真实 TypeScript 错误。[当前 I01 定义](../../../packages/evals/src/tasks/v2_1/I01.ts)明确这些权限，并校准带类型的等价配置与禁止的表达式；合同变化产生新的 Bank 和 Runner 身份，不改写既有成绩。

实验 manifest 在派发前冻结全部槽位，并区分执行、评分与可比性身份。续跑不能用后续成功替换 Agent 失败，也不能静默缩减计划。基础预检只建立本地能力证据；任务准入与校准仍须分别满足。报告重新核对存储证据，保留未执行槽位及未知状态，先按任务聚合，再对领域等权汇总。封存报告的汇总数据仍属于控制端资料，不能作为同一轮 Skill 修订的反馈。

[正式派发](../../../packages/evals/src/controller/formal.ts)在启动批次前核对全量任务校准、依赖准入记录、修订环境隔离证据和全流程共享预算。[单次执行](../../../packages/evals/src/controller/slot.ts)先独立重建并核对 S0，再预留预算。派发前失败的槽位保持未执行；派发后即使轨迹或评分出错，仍保留已知 Agent 失败。只有经过修改授权检查的项目状态可进入已校准的 Docker Grader。

Runner 在异步账户、发现及 S0 准备结束后、预算预留和槽位认领之前，再次执行控制端的同步 STOP 检查。随后预算预留、槽位认领及进程创建之间不再等待异步工作。准备期间出现停止标记时，槽位保持 `not_run`，不产生预约或模型调用；已经准入的尝试保留其退出与捕获。任何已存在的停止项，包括目录和失效符号链接，都会关闭派发；读取错误同样拒绝派发。最终检查定义准入时点，先前的准备起点不能替代它。该修正改变 Runner 身份，需要用新 campaign 执行完整登记批次，原记录保持不变。

[修订输入导出](../../../packages/evals/src/controller/revision-export.ts)在复制明确的文件与字段白名单前，重新验证冻结产物、完整 Skill 和全部开发任务校准。导出内容包括开发 fixture／提示词、公开合同 Markdown 及仅限开发集的诊断摘要，不包含 Grader 源码、参考解、原始轨迹、证据路径或 Git 历史。诊断证据必须匹配导出的产物与当前 Skill。新输出目录必须与受保护存储分离，且不得位于任何宿主 Git 祖先目录中：位于产品 checkout 外的目录仍可能继承另一仓库的上下文。使用前再次检查导出完整性。原生沙箱隔离和全新的修订会话仍是独立的运行时要求；Git 命令无法启动，不能证明其对象文件不可读取。

### 带版本的模型 Campaign

Campaign 为每个模型冻结一份 Profile，为每个模型和阶段保留独立实验。既有单槽 Runner、独立 Docker 评分和全局预算账本仍是执行权威。Profile 绑定准确的目录模型 ID、推理强度、请求服务档、Codex/helper 摘要、原生指令及执行限制；名称只用于展示。原生轨迹同时检查会话、每个推理事件和请求 payload；没有服务端模型或档位回执时保持未观察状态。严格对照要求共享执行与指令合同一致，原生 Profile 的描述性对照保留其已声明差异。

会话的模型、Provider 与推理强度取自冻结的 Model Profile，独立于会话的沙箱权限对象；权限元数据不能提供模型默认值。Native Trace 回归覆盖非默认模型及推理强度，并拒绝矛盾的会话身份或扩大的沙箱权限。修正采集器会产生新的 Runner 身份，历史尝试及其原判保持不变。

V1 读取器及不可变公开快照继续可用。V2 与 V2.1 题库身份均独立于 TaskSpec Schema 版本，两者必须经过 Campaign/Profile 入口，未知版本不得回退。V2 开发题复用受保护的 V1 语义，调整题面并为选定场景增加组合条件；封存定义和校准、审题资料保留在私有存储中。N01 另编译独立的公开 API 消费者。Grader 校准不能证明任务校准或模型区分度。V2 正式派发还要求独立任务审查回执、完整套件校准、逐 Profile preflight 与 smoke，以及同一个全局预算。V2 smoke 要求三个条件全部通过，并以执行日志前缀绑定完成证据；失败模型保持未准入。Pilot 是每模型 18 槽的独立开发诊断，不进入正式成绩。

各题库版本保留完整的 26 题及 17/9 划分。修改题面、Fixture、权限或 Grader 时冻结新 Bank ID，历史定义、回执和独立审题失败提交均归档保留。独立审题者在全新上下文中只接收任务输入及准备好的工具合同，冻结提交后再执行私有评分。反事实环境分别绑定 Runtime 与工作目录身份；它们用于任务校准，不增加正式独立场景，也不证明模型区分度。

初始化诊断分别记录请求调用目录和原生根解析成功返回的目录；解析受阻时，不能把最近 manifest 的目录当成已经解析的治理根。[版本化任务](../../../packages/evals/src/tasks/v2_1/I03.ts)明确报告字段含义，只授权诊断交付，并捕获初始化生成状态，使越权写入保持可见。[Grader](../../../packages/evals/src/graders/v2_1/I03.ts)分别检查报告字段，独立观察产品拒绝行为及项目状态保全；产品探针不能证明 Agent 自己执行过这些操作。历史题库版本及判定保留原合同。

准备好的 pnpm PATH 入口使用只读、绑定身份的脚本，为嵌套调用固定禁安装参数。显式安装命令在调用原生二进制前失败；沙箱网络和依赖保护仍是独立边界。共享源码变化需要新的校准/计算身份。严格重放历史私有数据使用归档源码闭包，既有公开 JSON 保持不变。

Skill 安装、原生可发现、已观察发现、完整内容读取与遵循指导分别取证，缺乏观察时保持 unknown。带版本的归因日志只追加，不能改变预分配组别、执行结果或成绩。V2 可判槽位要求模型及配置证据通过；槽位为 unknown 时仍保留已知 Agent 失败原记录。报告保留未决分配槽，展示可判成功率、覆盖及范围；回归与增益使用同模型配对，并按任务和领域等权。跨模型对照按共同冻结场景对齐，仅在严格可比且完整的数据上输出数值。

公开矩阵选择已校准题库完整 Bank Identity 下各 Campaign 的最新开发集及验收集报告，仅在相同 Campaign 和 Model Profile 内合并这两个阶段。两个任务清单都必须已执行；未启动槽位、未准入模型、Smoke、Pilot 及 Confirmation 不进入合并视图。已执行但结果未决的尝试保留原始状态及报告完成标记，并在成功率旁显示可判覆盖率。较新的未执行完报告不回退到较早报告。显式绑定的当前任务汇总还可纳入其准确来源 Campaign 和 Bank 下的另一阶段；无关历史仍被排除。合并视图保留阶段及任务来源，不挑选最高分 Campaign，也不计算跨 Campaign 模型效应；不可变历史快照和兼容读取器继续保留。

[RunStore 评分复核](../../../packages/evals/src/core/run-store.ts)仅为已结束的 `grader_error` 追加哈希关联裁决。冻结任务、准备和评分工具链、完整提交快照、模型证据、原始记录及原评分产物必须保持绑定；离线复核在冻结时限内提供原合同的完整断言集。裁决可以为通过或断言失败，不能替换已知 Agent 失败，也不创建额外执行。Run ID、用量及实际执行计时保持不变，复核计时和来源独立记录。原始日志字节及评分文件继续保留，固定历史前缀仍读取原来的 unknown；新报告绑定追加后的日志并获得新报告身份。

Docs 自有其批次视图的 TypeScript 测试。根工具测试通过已有的 TypeScript 测试 Runner 执行这些文件，使源码导入保持在 Docs 内，并保留测试的类型检查证明。

Campaign 发布同时绑定实际 Campaign、Manifest、执行和归因日志前缀、只读账本快照、计算源码和报告字节。后续追加不能改变已有报告，账本副本不具备派发权限。根导出脚本通过只读 CLI 边界读取包内生成的公开 JSON，页面使用本地公开数据视图合同。公开投影只输出明确字段；原始证据、题面、评分器、参考答案、私有路径及推测费用保持私有。冻结的阶段顺序在准入模型间均衡，共同最终决策明确保留未入组名册。缺少报告资料与有证据支持的未准入分别记录。快照文件名包含报告身份，同一 Campaign/阶段的后续报告与早期快照并存。Dashboard 加载完整 Bank Identity 与当前校准摘要一致的 Campaign，以及显式绑定的当前任务汇总的准确来源 Campaign 及另一阶段。该来源仍须是其自身 Campaign／阶段的最新报告；来源缺失或被更新报告取代时拒绝加载。历史快照和兼容性测试继续归档。校准或源码变更均不提供模型成绩。真实模型、工具沙箱和区分度验收仍须由操作员执行；常规 CI 只跑离线测试。见[评测 workspace](../../../packages/evals/README.md)。

### 公开评测结果

[英文](../../../docs/en/evals.md)和[中文](../../../docs/zh/evals.md)结果页共用异步加载的[展示组件](../../../docs/.vitepress/theme/EvalsDashboard.vue)与[最新题库摘要](../../../docs/.vitepress/theme/evals-latest-bank.json)。既有 Vue 和原生表格／展开控件已覆盖这项有界展示，无需额外图表运行时。页面继承站点浅深色主题，标明冻结题库版本，并展示一张采用当前已执行开发集及验收集结果的模型矩阵。页面不再提供历史题库选择器或结果入口，底层历史快照保持不变。

[校准导出](../../../scripts/docs/export-evals-calibration.ts)核对显式固定哈希的私有证据索引、Bank 身份、每题校准和独立冻结提交评分，以及公开输入等价性回执。它只公开受控状态、计数及来源／计算身份，写入不可变快照后原子更新最新指针。题面、断言名、参考解、原始轨迹、自由文本审题记录和证据路径均不公开。校准符合预期包含错误修复及越权修改被正确拒绝，不等于 Agent 成功率。

模型结果在索引匹配最新题库或显式绑定的当前汇总来源族后按需加载；每个来源的 Bank、Campaign、报告和阶段必须与各自索引项匹配。某模型缺少任一已完整执行的任务清单时，合并页面在加载结束后明确显示空状态，不回退到历史成绩、不停留在加载状态，也不虚构模型行。已测量 Campaign 保留配对对照、回归、覆盖、未决样本及最小激活／归因摘要。校准本身不能证明模型区分度、稳定性或 Skill 增益。

历史费用导出保留已观察 API 等价值之和，包含失败执行及补跑，并标注不完整总量。发布时绑定私有成本报告哈希，核对完整尝试集合后仅导出聚合字段；请求身份及轨迹内容保留为私有。估算值不会填入实际结算字段。

冻结的标准 API 价表支持准确的 Terra 和 Sol 模型 ID。逐请求按捕获的 Token 应用缓存及长上下文规则；用量不完整的执行不进入完整尝试的均值，但保留已观察小计。离线重新计价先用原先经过审查的价格快照重现已有测量的报告，再按当前冻结费率生成新的计算及报告身份；未知价格身份会被拒绝。重新计价保留执行身份、评分、原始轨迹、账本项和早期公开快照，不派发模型，也不改变实际结算。见[成本估算器](../../../packages/evals/src/core/estimated-cost.ts)和[重新分析边界](../../../packages/evals/src/controller/campaign-report.ts)。

当前 Campaign 报告将[测量统计](../../../packages/evals/src/core/campaign-measurements.ts)绑定到准确冻结的执行集合。输入 Token、耗时和 API 等价成本先在每题每条件内平均，再让有测量的单元等权；模型行与任务行合并 Base 与 Skill，负控独立。输入 Token 包含缓存子集，不重复相加。只有记录完整的用量进入 Token 均值；部分输入总数保留为已观察小计，并展示执行覆盖。第 2 版测量增加任务聚合及输入 Token；第 1 版按原字段重放，不补造字段，再通过离线重分析写入新身份。失败、未知及替补执行均保留。Agent 执行时间与端到端耗时分开。均值保留执行覆盖及有测量／已分配单元数；不完整估算保留已观察小计，完整总量仍为未知。页面展示 Agent／版本、平均耗时、API 等价成本估算及覆盖。主表成功率使用有证据支持的通过次数除以全部实际执行次数，主表不设独立 Unknown 列，非零未决次数显示在对应条件的可判／执行覆盖旁，为零时隐藏。任务／领域宏平均继续保留在报告和合并视图的独立字段中；估算不充当实际账单，未准入模型在归档报告中的正式测量继续为 N/A，不进入完整结果视图。

[任务结果发布](../../../scripts/docs/export-evals-task.ts)复用现有只读 Campaign 发布进程。来源索引绑定原始执行日志、模型、题库、Fixture、评分及执行身份。显式任务选择将 I03 绑定到开发集、P03 绑定到验收集；旧版 P03 投影继续可读。I03 指针按 canonical model ID 区分非旧版模型，同时兼容原 Terra 指针；发布 Sol 不能替换 Terra 来源。单题单条件结果要求三次计划中的独立尝试全部可判，不含替补或隐藏的额外执行；完整的失败结果仍可发布。父批次未执行的槽位不会变成任务执行数，也不会使正式批次变为完成。明确字段投影保留测量及未知实际费用，写入不可变快照并更新对应任务的指针。任务结果保留自身 Bank Identity 和样本范围，为显式选择的当前结果汇总提供来源，不改写历史全题库分数，也不补造未测量的 Base 组。历史日志、unknown、快照和兼容性测试继续保留。

[当前结果发布](../../../scripts/docs/export-evals-summary.ts)绑定完整 Campaign 快照及完整任务快照的字节哈希，然后仅选择一次对应任务条件。评分或执行合同变化时，必须通过显式修订绑定原始及新的 Bank、Fixture、评分与执行身份，不能据此放过无关身份错配。页面按 Campaign／模型／阶段至多接纳一项选择，因此开发集 I03 和验收集 P03 可同时更新同一模型行而不相互覆盖。它重新计算计数、任务／领域宏平均、描述性组间差值、耗时、成本及覆盖；负控独立，未知费用仍为未知。公开汇总具备独立计算／内容身份，保留两份来源的题库及报告、选中／来源执行数，以及不可变历史文件。页面将选中任务合入一行模型及其任务表，不再提供第二张单题成绩表。不同来源的条件不取得同实验配对身份，描述性差值不构成新的 Skill 因果估计。保留的汇总产物将每个模型行绑定到准确来源；页面不再增加下载面板。

页面直接展示合并开发集与验收集的模型表格，不再提供阶段选择器。[合并视图](../../../docs/.vitepress/theme/evals-combined.ts)按通过次数／全部执行次数计算主任务和负控成功率；每个显示百分比直接由相邻的分子、分母计算，差值使用相同执行成功率。未知结果保留在执行分母中，单独计数，并保留可判／执行覆盖；这不将其判为已知 Agent 失败。基础设施替补执行继续计入执行分母及未决计数。原任务／领域宏平均和相应差值在合并数据及不可变来源报告中以独立字段保留。测量均值继续按任务／条件单元等权。负控拥有独立计数及静态表格，不进入主成绩或主测量。展开模型后显示 24 道主任务和两道负控，保留原始分组标签、输入 Token、Agent 耗时、API 等价成本、覆盖及逐次尝试标记。任务行没有嵌套展开。每个阶段报告及显式选定任务来源保留原始身份；描述性合并不产生新实验或跨来源配对。零次执行的成功率为 N/A；有证据的零次通过为 0%。标记保留包含替补在内的实际尝试，并提供符号及可访问状态。统计方法、来源、校准及历史证据资料继续独立归档。视觉参考为 [Next.js Evals 表格](https://nextjs.org/evals)，不沿用 pass@k，也不丢弃未决证据。

[离线报告重分析](../../../packages/evals/src/controller/campaign-report.ts)读取固定哈希的历史来源索引及其账本快照，不打开写入器，也不读取活动账本。先用绑定输入完整重现历史报告，再写入新的报告／来源索引，记录测量计算身份和原报告／索引哈希。计算器变化不能成为未经重放就信任历史汇总的理由。发布时核对新计算与准确来源；旧报告和公开快照保持不可变。既有 Node、定价与 Vue 能力已覆盖这项有界聚合／导出工作，无需新依赖。

[发布数据脚本](../../../scripts/docs/export-evals.ts)先核对显式提供的汇总哈希，再读取完整报告和尝试导出。它投影明确的公开字段，检查独立重复和领域聚合，保留未知货币总额与不完整 Token 覆盖；不导入评测 Runner，也不启动模型。公开数据包含任务 ID 与汇总观察，不含任务正文、隐藏断言、参考解、原始轨迹、账户设置或本机证据路径。[发布测试](../../../scripts/docs/export-evals.spec.ts)覆盖错误来源身份、私有字段注入、原始失败保留、未知状态和推断零账单。

历史[正式批次](../../../docs/.vitepress/theme/evals-results.json)、[开发集](../../../docs/.vitepress/theme/evals-development-retest.json)及 [I03 诊断](../../../docs/.vitepress/theme/evals-i03-supplement.json)导出继续归档，用于来源核对和审计。它们不进入当前页面，也不进入其他批次的评分或测量。原始执行及评分证据继续保存在私有控制端。

完整开发集重测属于独立批次：[`--development-retest`](../../../scripts/docs/export-evals.ts) 要求 102 个唯一比较槽位，并在写入[单独的公开快照](../../../docs/.vitepress/theme/evals-development-retest.json)前核对原批次的产品、完整 Skill 与报告摘要。评分使用选定的比较观察，耗时和 Token 则包含全部实际执行。经过单独审计的原生轨迹基础设施补跑保留首次未知记录，不能替换已知的 Agent 失败。统一评分复核单列身份与额外耗时。完整重测、原始评分及此前仅针对 I03 的诊断继续分别归档。不完整的比较证据不能被发布为完整整体成绩。

Markdown 页面仅作为组件入口，不含结果载荷。分数和结果文案保留在独立组件／数据资源中，避免开发资料导出器通过其公共合同 Markdown 选择夹带封存结果。私有控制端和原生修订沙箱仍负责隔离；发布冻结任务集的结果，不代表该集合对后续修订仍然未见。展示单次尝试成功率、八领域等权、独立负控、样本量和推断限制；参考其他站点视觉时，不沿用其 pass@k 或费用估算口径。

## 公共文档内容

公共站点介绍当前受支持的能力、接口、工作流和使用约束。页面、示例、导航与搜索内容不介绍已移除的 API、废弃入口、字段新旧对照、内部兼容分支或实现格式演进。直接说明当前行为，并同步维护中英文内容。

影响当前使用的接入工作流、工具链要求、能力限制和恢复操作应予保留。标识符包含 `legacy` 本身不代表受支持的选项已过时；应根据公开契约及消费实现判断其状态。历史背景保留在更新日志和内部记录中。替换历史标题或锚点时，同步更新仓库内的入站链接，不新增公共兼容说明。修改公共文案不代表可以移除运行时兼容代码。

[文档共写流程](../../skills/doc-coauthoring/SKILL.md)负责源码依据、语言一致性和站点检查。当前 [CLI 注册](../../../packages/limina/src/cli/register/setup.ts)、[公开导出](../../../packages/limina/src/index.ts)和[配置 Schema](../../../packages/limina/src/config/schema.ts)建立对应接口边界；[公共配置参考](../../../docs/zh/config/index.md)负责使用说明。

## 文档命令输出

首页由 `HomeFeatures.vue` 负责功能导航，`CommandTerminal.vue` 负责命令输出与控件，`use-command-playback.ts` 负责回放状态。组件文件按职责命名；props、data attributes 和样式中的命令选项及索引使用命令术语。英文与中文文案共享同一份 CLI 运行记录。选择其他命令或功能组时，完整输出保持展开，方便读者对照。其阅读区在当前视口下采用固定高度：运行记录的长短不得改变粘性终端的高度并反向触发滚动驱动的功能选择。输出保留实际打印的列布局，窄屏通过横向滚动阅读。

[命令运行记录](../../../docs/.vitepress/theme/command-transcripts.json)由[录制脚本](../../../scripts/docs/capture-command-transcripts.ts)在独立的双包 pnpm workspace 中运行新构建的 CLI 生成。先运行 `pnpm run build`，再运行 `pnpm exec tsx scripts/docs/capture-command-transcripts.ts <new-workspace>`；验证时使用 `~/Project/dev-server-repo/repros/` 下的新目录。录制需要 Python 3 与 POSIX PTY。可选参数指定输出 JSON，以及系统代理包装 pnpm 时使用的明确 pnpm 可执行文件。脚本拒绝已有 workspace 目录，移除父工作区的 bin 设置，为本地依赖生成 lockfile 后运行 `pnpm install --frozen-lockfile --offline`。由 pnpm 创建 workspace 链接与可执行 shim，并保留默认依赖校验。展示与执行的命令是相同的 `pnpm exec limina ...`。记录 JSON 纳入 docs TypeScript 项目。发布流水线从 `packages/core` 运行，其构建生成包／发布检查所需的清单与产物。边界失败使用跨包相对源码导入。

2026-10-03 的记录使用默认交互终端分支：stdout／stderr 共用真实的 100 列、80 行 PTY，设置 `TERM=xterm-256color`，不设置 CI 与颜色覆盖变量。[终端帧提取](../../../scripts/docs/terminal-frames.ts)通过 xterm 解释光标移动、擦除与折行，不将简单去色后的重绘流拼接为日志。间隔不超过 20 ms 的写入合并观察；原始采集保留在录制工作区。屏幕帧裁去外围未使用的视口空白，保留内部空行、缩进、报告边框、诊断和 invocation 查询。回放替换上一屏内容，命令打字后使用记录的帧间隔；完整输出展开区展示终端最终屏幕。界面标明交互式记录及其尺寸。数量、耗时、折行与本地查询路径描述该工作区／该次运行。记录同时保存源码、CLI 与原始输出哈希及工具链版本。CLI 输出变化时须刷新记录；这属于文档契约，不改变产品不变量 I01–I12，也不证明 Windows、其他终端尺寸或部署结果的一致性。

`@xterm/headless` 6.0.0 是仅用于录制的开发依赖，负责解释 VT 终端状态。本地去除转义序列的例程无法保留重绘语义；非正式的本地 VT parser 会增加标准维护负担。2026-10-03 的准入检查发现其 MIT 许可证一致、registry 未标记废弃、6.0.0 为持续维护的 xterm.js 项目的稳定版本，前一周 npm 下载量为 2,001,724，前一月为 6,573,679。其 buffer API 是实验性的，已固定精确版本，升级时须运行终端控制复现并重新采集 CLI 输出。选定的包没有运行时依赖，仅由录制脚本导入，不进入 docs／client 或已发布 CLI 的入口。因此该依赖不适用生产产物体积阈值；记录的屏幕帧数据仍需正常的文档构建与浏览器检查。

## 文档侧栏

文章侧栏通过 [reading.css](../../../docs/.vitepress/theme/styles/reading.css) 适配既有 VitePress 组件，保留 [reading-tokens.css](../../../docs/.vitepress/theme/styles/reading-tokens.css) 中暖色的浅深色配色。选中与普通链接共用行内留白，避免选中时文字偏移；用柔和背景与字重表示选中，用间距分隔分组。导航、折叠、历史记录与移动菜单仍由既有 VitePress 行为负责；这项视觉调整无需增加依赖或另写导航实现。

关闭的移动侧栏设为隐藏，使其控件退出键盘导航。移动链接与折叠控件保留至少 44px 的点击区域。键盘焦点有轮廓线，高对比度选中态使用系统 Highlight 轮廓线，因为单靠背景色无法在该模式保留标识。浏览器验收须覆盖中英文、长标题、断点边缘、滚动、折叠、导航／历史、移动开关、键盘焦点、减少动态效果及高对比度模式；格式、类型检查与文档构建不能证明这些交互结果。
