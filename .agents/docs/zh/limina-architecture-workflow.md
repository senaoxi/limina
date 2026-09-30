# Limina Architecture Review 与维护

[English](../limina-architecture-workflow.md) | [简体中文](./limina-architecture-workflow.md)

本页定义本次建立的 repo-native 工作机制。它是维护建议与本仓库的操作约定，不是由源码推得的历史设计意图。入口为 [limina.md](./limina.md)，不另建 docs/architecture 或 ADR 副本。

## PR 先说明 invariant impact

先保留 `git status --short` 的 index/worktree baseline，读取最近的 AGENTS 与 owning PCR；以当前改动后的代码重建受影响链路，再核对旧 prose。用一个具体 trigger 解释 before/after，按下表定位影响。

| 修改入口                                                                        | 必须追踪到的消费者                                                        | Invariants / prose owner                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| workspace discovery、regions、exclude、package identity、output scopes          | ownership、graph/source/proof、mutation authority                         | I01/I08/I10；system model / lifecycle           |
| checker selection、semantic authority、pending/final owner、solution closure    | facts、coloring、checker target、proof                                    | I02/I04/I07/I08；system model / semantics       |
| roots、tsconfig options/extends/types、module resolution、source maps           | occurrence identity、TypeEvidence、referenceRequirement、graph projection | I03/I04/I05/I06；semantics                      |
| reference inference、implicitRefs、output attribution、edge type                | coloring、generated config、SCC、checker plan、export view                | I06/I07；system model                           |
| cache key、provider/context ownership、async preparation、executor command step | invalidation、dispose、receipt、snapshot freshness                        | I09/I12；lifecycle                              |
| namespace、materializer、managed output、migration                              | physical authority、revision、partial failure、recovery                   | I10/I11；lifecycle                              |
| findings、issue identity、query、snapshot/schema                                | dedup、terminal/machine output、latest/standalone freshness               | I12；lifecycle                                  |
| 公开 commands/config/package exports/checker tuple                              | schema、docs、tool availability、release/package contract                 | 入口 + 相关 owner；按 observable 决定 invariant |

review 必须回答具体问题，而不是勾选“架构没有影响”：

1. 输入、identity、authority 的创建者是否变化？哪个字段已经 final，哪个仍 pending？是否把 runtime 路径升级成 checker evidence？
2. producer 与 consumer 是否仍使用同一个 relation 含义？source ownership、compiler membership、declaration reference、scheduling、artifact attribution 是否被混写？
3. 成功路径之外，missing/unsupported/conflict/partial-write/取消或未运行如何表达？有没有 silent fallback 或 older-success reuse？
4. 是否增加了 cache lifetime、共享 context 或异步发布？content/config/toolchain/membership 变化由谁使其失效？旧结果还能否发布到新 generation？
5. 有什么最小反例能使新实现出错？它保护 semantic observable，还是只冻结函数名、目录或当前实现步骤？
6. 哪个唯一 PCR owner 及其中英文文件对、guard、公开文档需要更新？没有 architecture impact 时，用一两句解释为何 identity/authority/relation/lifetime/failure/public observable 全部保持。

## Guard 放在哪里

优先在非法状态形成的最近入口用类型或 assertion 拒绝；跨模块性质用 focused semantic test；静态依赖规则可用 architecture test/lint。不要以越来越多的 downstream snapshots 代替缺失的入口契约，也不要为文件搬家写恒等测试。

只有同时满足“当前 invariant 明确、长期语义边界明确、确有缺口、diff 小、无需改生产行为或冻结偶然结构”时才在此类知识维护任务新增 guard。生产 defect 需要行为修复时，先交付可审查的 finding 和反例，不借 prose maintenance 顺手修行为。[evidence matrix](./limina-invariants.md#evidence-matrix-与-guard-决策) 记录本次选择。

稳定的 guard 应能回答“去掉这条检查，哪个错误状态会被接受”。仅检查某类/方法仍存在、使用某个 helper 或文档出现某字符串，通常无法回答。

## 知识更新闭环

```mermaid
flowchart TB
  Change["Source / test / schema change"] --> Impact["identity / authority / relation / lifecycle / failure impact"]
  Impact -->|"语义未变"| Explain["PR 简述无 architecture impact"]
  Impact -->|"语义或边界变化"| Owner["同步更新唯一 PCR owner 的两种语言与相关 invariant"]
  Owner --> Guard["更新最近的 executable guard / 反例"]
  Guard --> Attack["authority、relation、lifecycle、knowledge 四个方向反证"]
  Attack -->|"发现反例"| Owner
  Attack -->|"范围明确"| Evidence["记录实际命令、结果、未知与 human judgment"]
```

需要更新知识的 trigger：新增/删除 authority、改变 phase 输入输出、reference/edge 含义、cache key/lifetime、失败回退、materialization 协议、coverage 边界、公开兼容契约。纯文件移动只更新证据链接；格式与不改变行为的 helper 拆分通常不新增 invariant。测试路径移动不能使旧链接静默失效。

每个 current truth 只编辑一个完整 owner。其他页保留简短结论和链接；不要附加“后来又改成……”的 supersede 链。旧错误直接删除/收窄，在 commit diff 或本次 audit 说明纠正原因。schema/version/tuple 的机械表尽量链接 source 常量；不要让 PCR 第二份枚举成为兼容 authority。

Owner 的对外英文文件为 `.agents/docs/<name>.md`，对应中文文件为 `.agents/docs/zh/<name>.md`，文件名相同且均由 Git 跟踪。每次触发 PCR 更新，必须在同一次变更中同步维护完整文件对，包括纯文字纠正以及新增、重命名、移动和删除。遵循[仓库双语规则](../../../AGENTS.md#bilingual-pcr-maintenance)与[索引中的维护步骤](./README.md#双语发布与维护)。它们是同一个 owner 的两种语言版本，含义和证据完全一致，不是独立的事实记录。

`Confirmed / Derived / Candidate / NOT VERIFIED` 随证据更新；source-established 与 runtime verified 分开。source 与 vouched direction 冲突时保留冲突，不伪造 rationale 或 vouch；decision ledger 只有 human 明确建立后才使用。公开目录不引用私人 memory 作为产品方向。

一次维护结束前检查：map 能否快速找到 owning page；Mermaid 是否与实际依赖/时序一致；每条 core invariant 是否有 statement、适用范围、问题/原因/机制/例子/保护目标、source/tests、strength/confidence；未决问题是否被误写成默认承诺。逐节比较两种版本，确保语义完全一致，文件名、例子、证据、日期和状态一一对应；检查两个位置的链接与标题锚点。

## 可复用的 PR review 记录

```text
Trigger and resulting behavior:
Affected invariants: Ixx / none, with reason
Authority / identity / relation / lifecycle changes:
Owning PCR English/Chinese pair and source guard:
Counterexample: input + expected observable + why independent
Validation: exact command, environment, result, omitted conditions
Findings: P0-P3 + BLOCKING / NON-BLOCKING / NO DEFECT
Human decision required: concrete scope, alternatives, remaining question
```

P0/P1 表示严重 correctness/authority/freshness 破坏；P2 是受限缺陷或可信维护风险；P3 是小范围 drift/clarity。BLOCKING 说明阻断哪一项合入/主张，不能把未决定方向、缺少网络工具链或一次 sandbox failure 自动升级成生产 defect。NO DEFECT 也应说明边界，例如“TypeScript semantic authority + vue-tsc final owner 是已允许组合”。

## 验证选择与已知运行陷阱

先 `pnpm nx show project limina` 发现 targets。涉及 production governed source/config 时按 root AGENTS 执行 `pnpm exec limina check`，失败读取 `pnpm exec limina check --issues --format json`。涉及 tests/guard 按 package AGENTS 运行 unit/typecheck/lint；当前 lint target 使用 `eslint --fix`，dirty tree 不应让无关内容被改写，应使用非 fixing ESLint 检查并报告替代原因。只改 PCR 时检查格式、中英文内容一致性、links、source anchors、相关 semantic evidence 与 Git 边界，不强制触发 build/package/release 全套任务。

实证结论遵守 root verification protocol：在 `$EVIDENCE_ROOT/<topic>/` 建立忠实最小复现；至少三轮独立改变会影响结果的维度，以推翻命题为目标；记录 intent、独立性、命令/条件、观察。修正命题后重做相应反证。无法保留 toolchain/platform 条件时写 NOT VERIFIED，不用 source 阅读冒充实测。

以下 supporting traps 保留已发生的原因与 source/test 锚点，不提升为新的 core invariant：

| Trap                                         | 操作与原因                                                                                                                                                                                                                  | Evidence owner                                                                                                                                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI 子进程返回空 stdout                      | 先保留 stderr/exit；tsx `listen EPERM` 发生于 IPC 启动，未到业务断言                                                                                                                                                        | `bin/limina.js`；[本次验证](./limina-architecture-audit.md#validation)                                                                                                                                                                |
| 同一 `.limina` 的进程测试相互污染            | namespace-mutating commands 顺序执行；已产生 inventory 后的独立 queries 可只读；矩阵优先 in-process，保留代表性 CLI wiring                                                                                                  | [cli tests](../../../packages/limina/src/__tests__/cli.spec.ts)、[attempt tests](../../../packages/limina/src/__tests__/check-attempt.spec.ts)                                                                                        |
| Windows 单测超过单个用例时限或丢失定时器重叠 | 将独立的 CLI 与语法矩阵拆为有界用例，不删减输入；并发断言等待 runner 实际启动，不假定负载下 10–30 毫秒定时器必然重叠                                                                                                        | [CLI 测试](../../../packages/limina/src/__tests__/cli.spec.ts)、[语法差分](../../../packages/limina/src/__tests__/source-syntax-differential.spec.ts)、[checker build 测试](../../../packages/limina/src/__tests__/typecheck.spec.ts) |
| 生成配置投影测试重复启动编译器进程           | 每个变体用 TypeScript Program 检查源配置，再用一次 SolutionBuilder 构建两个生成配置；断言声明和输出产物。完整测试集负载下，启动三个进程的单个用例可能超过 Windows 的 30 秒时限。                                            | [生成图测试](../../../packages/limina/src/__tests__/generated-graph.spec.ts)                                                                                                                                                          |
| Windows path / inline ESM                    | fixture.path/portable helpers 用于比较；filesystem 可用 native path；child import 使用 file URL                                                                                                                             | [package AGENTS](../../../AGENTS.md)、[path helpers](../../../packages/limina/src/__tests__/helpers/path.ts)                                                                                                                          |
| materialization contention 夹杂轮询竞态      | paused child 使用已打开 IPC 通道释放，失败附带 stdout/stderr                                                                                                                                                                | [recovery tests](../../../packages/limina/src/__tests__/materialization-recovery.spec.ts)                                                                                                                                             |
| Region 索引 cut 后丢失 owner 归因            | 预计算必须保留最近 activated package 的归因身份：同一 owner 的更深 boundary 仍需替换先前 boundary，descendant activation 则重新选择 owner；只传播 cut 后的 null owner 会改变 diagnostics                                    | [workspace directory index tests](../../../packages/limina/src/__tests__/workspace-directory-index.spec.ts) 的 nearest owner cut、canonical relocation 与 re-entry 反例                                                               |
| repository config 集成测试重复全仓语义分析   | 加载真实 root config 后，仅将 graph provider 的 rootDir 指向临时最小 pnpm workspace；保留真实 checker 选择、入口路径与非空 references 断言。全仓 graph 仍由 CI 的 `pnpm check` 覆盖，避免此命令契约测试的成本随仓库规模增长 | [root config test](../../../packages/limina/integration/tests/root-config.spec.ts)、[CI](../../../.github/workflows/ci.yml)                                                                                                           |
| scoped pnpm fixture 在 Windows 不可达        | namespace 目录保持 physical，逐 package junction；避免 namespace 本身是嵌套 reparse point                                                                                                                                   | [integration helpers](../../../packages/limina/integration/helpers)                                                                                                                                                                   |
| detector fixture 的 HOME/XDG 隔离隐藏 pnpm   | 隔离前解析 host Corepack cache，保留 COREPACK_HOME、关闭 latest discovery，fixture override 不得覆盖保留值                                                                                                                  | [detector environment](../../../packages/limina/integration/helpers/detector-environment.ts)、[harness tests](../../../packages/limina/integration/tests/detector-harness.spec.ts)                                                    |
| 流故障 fixture 丢失另一流或未命中次数        | 按受控 helper 的 stdout/stderr 完整换行记录对计数，延后至两条流均转发后再注入。流错误会终止子进程；管道可能拆分或合并 write，两条流也独立到达。保留输出与故障消费断言。                                                     | [观察器](../../../packages/limina/integration/helpers/fault-process-output.ts)、[测试](../../../packages/limina/integration/tests/fault-injection-harness.spec.ts)                                                                    |

[pipeline discovery 渲染测试](../../../packages/limina/src/__tests__/pipeline.spec.ts) 等待明确的 generated-graph provider 启动信号，然后在该 provider 的结果仍未完成时断言完整任务树。discovery 启动前还要完成 attempt 发布 I/O 与 workspace 校验；`vi.waitFor` 默认的一秒时限不是启动契约。将启动信号与 pipeline 完成事件竞速，避免更早的失败让测试一直等待不会被调用的 provider。在 `finally` 中释放被挂起的 provider 并等待 pipeline 结束，再删除 fixture；渲染断言失败时也必须如此。这只调整测试同步方式，不改变生产调度或超时策略。

生成命令测试必须区分启动身份与路径文本：安装后的 Limina 入口可能位于 `node_modules/.pnpm` 下，workspace 或 Node 路径也可能包含 `pnpm`。禁止该子串会误判直接 Node 调用。应比较命令 tokens，以及 shell probe 的 canonical Node 可执行文件和安装后的 CLI 入口，同时保留精确 argv/cwd 与真实 shell 回放检查。[命令测试](../../../packages/limina/src/__tests__/standalone-invocation-command.spec.ts) 覆盖包含 pnpm 的路径；[打包消费者 smoke](../../../smoke/generated-command.spec.ts) 覆盖安装入口身份。本地 POSIX 回放不能证明 Windows PowerShell 成功；后者需要 [Windows CI jobs](../../../.github/workflows/ci.yml) 验证。

生成的 invocation 查询使用 `shell-quote/quote.js` 为 POSIX 参数添加引用，并为 Windows PowerShell 5.1 与 PowerShell 7 保留现有的 Base64 JSON Node 传输。Windows 只输出带标签的 PowerShell 命令：不能把 POSIX 引用语法用于 CMD，也不再提供 CMD variant。仅引入 quote 入口可避免打包未使用的 parser，并移除 shescape 的 shell 发现依赖，同时保持 Limina 的 Node 支持下限。不要用 JSON 字符串化或临时编写的转义逻辑替代 shell 引用。POSIX 适配层按 `!` 拆分每个参数，通过库为每个片段和分隔符添加引用，再连接为同一个 shell word：否则，当参数同时包含单引号时，shell-quote 1.10.0 会在双引号内的 `!` 前添加反斜杠，而 POSIX shell 会保留该反斜杠。敏感参数回归测试覆盖了这一组合输入以及开头、结尾和连续出现的感叹号。PowerShell runner 会将尾随参数追加到编码的 argv 后，使 `--format json` 和查询 filter 等选项传递给 Limina。[单包回放测试](../../../packages/limina/src/__tests__/single-package-cli.spec.ts) 在移除配置后追加 JSON 输出选项，并保留 I12 的查询身份与不修改状态检查；[打包消费者 shell 回放](../../../smoke/generated-command.spec.ts) 在各个支持的 shell 下执行安装后的入口。平台验证仍以原生 Windows 执行为边界。

生成命令 smoke 测试中的 PowerShell 证据探测有独立的子进程时限。一次 Windows / Node 24.11 CI 失败在 shell 回放前耗尽了原来的 30 秒时限，stdout/stderr 均为空；日志无法区分耗时来自 shell 启动还是命令发现。探测应使用非交互模式，仅在命令发现的脚本块内禁用模块自动加载，并把 pnpm 查询限制为 PATH 中的应用和脚本，查询错误必须终止执行。其有界的 180 秒时限与现有 shell 回放预算一致；不能吞掉探测失败、跳过任一 PowerShell 版本或提高全局超时。保留 pnpm 来源与版本断言，以及精确 argv/cwd、可执行文件、安装入口和 invocation 检查。受控子进程计时测试可以证明时限与错误传播行为，但不能证明原生 Windows 已恢复或定位 runner 的耗时来源；平台证据仍须来自 Windows CI。

PowerShell 命令发现可能返回多个 pnpm 来源，包括 `.ps1` 和 `.CMD` 启动器。证据探针将具名的 `pnpmSources` 数组和 `version` 字段序列化为 JSON；按 stdout 行号取值无法区分第二个来源与版本。模块自动加载限制仅置于命令发现的脚本块内，使后续 `ConvertTo-Json` 能加载其内置工具模块。拒绝空来源或格式错误的来源，并保留独立的 5.1/7 版本断言。[解析回归测试](../../../smoke/generated-command.spec.ts) 覆盖单个、多个来源和错误格式；原生 Windows shell 回放仍不可省略。

[CLI 回归测试](../../../packages/limina/src/__tests__/cli.spec.ts) 通过 `console.info` 捕获 CAC 7 的帮助文本；监听 `console.log` 会在帮助文本已经输出时仍得到空捕获。独立命令失败必须只输出一条适用于当前平台的带标签查询命令，且没有 CMD variant。解码 PowerShell 传输或解析 POSIX 命令，比较 Node 可执行文件、CLI 入口和完整 argv；另行检查 PowerShell 工作目录。在同一个回归用例中保留 snapshot 不被替换与跨目录 issue 查询检查。包含 `pnpm` 的 mode 用于防止把普通参数文本当作启动器身份。 将六条失败命令分成三个使用独立夹具的用例（checker、graph/proof、package/release）；每个用例在现有 60 秒时限内最多启动三次源码 CLI。写入命令仍串行执行，并在第二次失败后查询两份记录，保留先前 invocation 共存的检查。checker 用例同时保留成功构建不替换 snapshot 的断言。这样避免将七次源码 CLI 启动计入同一个时限，不提高超时，也不删减命令、argv 或查询覆盖。 并发 checker 回归仍同时启动两条真实 CLI 进程。屏障应位于配置加载阶段、生成产物锁之前：编译器持有的读锁可能阻塞另一条命令的物化写锁，而只检查 CLI 退出码 1 也会误接受编译器屏障退出码 99。明确断言两个配置加载参与者均获释放，以及两个编译器分别退出 7/8。写入结束后在进程内查询两份完整记录；独立的 source-check CLI 查询与[打包消费者 shell 回放](../../../smoke/generated-command.spec.ts) 保留真实子进程查询、argv 和 cwd 覆盖。并发用例的 45 秒时限保持不变。

Windows 发布工具应通过当前 Node 执行 npm 的 JavaScript 入口，并直接传递 argv。对 npm.cmd 调用 execFileSync 会在 pack/view/publish 执行前失败。保留所选 npm 的身份、cwd、错误 stdout/stderr 和退出码，不引入 shell 插值。打包、registry integrity 查询、上传、渠道提升和 npm 版本校验应使用同一执行入口。测试通过假 npm launcher 验证空格及特殊字符，通过本地回环 registry 验证部分上传恢复；发布目标校验、trusted publishing 条件和权限门禁仍是权威。

依赖的 license/security policy 归 [dependency admission](./dependency-admission.md)、workspace pins 与实际 CI 配置，framework semantics 不拥有例外授权。accepted toolchain tuple 变更需要测试相应条件，不能用 pnpm store/hoist 路径充当兼容谓词。
