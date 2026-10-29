# 启动性能验收

[English](../startup-performance.md) | [简体中文](./startup-performance.md)

本次实现改善了仓库工作负载的启动耗时，但两个目标均未达成：冷启动 67.364 秒，目标 35 秒；热启动 30.356 秒，目标 15 秒。本记录覆盖一次全量优化和两轮追加评估。完整验收尚未通过：未修改的依赖 tooling 门禁也有失败，详见下文。本地验收记录不构成对其他 workspace 的性能保证。复用与权威合同仍由 [lifecycle](./lifecycle.md) 和 [semantics](./semantics.md) 持有。

## 复现边界

测量环境为 2026-10-29/30 的 Apple M1（8 核、16 GiB）、macOS 27.0.1 / 26A434 arm64、Node 26.13.0、pnpm 12.10.1、TypeScript 6.0.3、Vue 3.5.43、vue-tsc 3.2.4、tsx 4.23.15。基线为干净 `main` 的 `dbefa8d5210539f730749bd3d0557915c32180df`；优化实现为包含本记录的改动。仓库 launcher 选择源码 CLI 入口。

每轮在独立、不计入统计的完整预热后，执行 5 组完整根命令 `pnpm check --force`，随后新进程 `pnpm check`。Force 绕过整个 Limina 分析模型；OS 文件页、tsx 和独立 Checker 缓存保留。治理范围、必要校验和命令均未删减。每个正式样本的开始/结束源码摘要必须一致；所有尝试和慢样本均保留。根默认工作流保留原有禁用的 `checker:typecheck` task；另行要求的 `pnpm run typecheck` 已实际执行并通过。

主指标固定为外部 pnpm 启动到 `graph:materialize.completedAt`，包括 task timer 之前的缓存读取和资格校验。端到端使用单调时钟，另列 graph task 自身时间。Darwin `wait4.ru_maxrss` 是 job/process 高水位观测，不是同时相加的整个进程树 RSS。CPU profile 与启用 metrics 的诊断和正式计时分开。

主机接通电源，未报告温控警告，但并非专用空闲机器。已有 Node 网关占用约一个 CPU 核，浏览器/编译器活动也有波动。因此不能仅凭跨批次中位数确定小幅收益或回退的因果关系。未终止后台服务，也未剔除样本。

## 完整测量

改善百分比为正表示比基线更快；RSS 为绝对值。每行均包含 5 次运行。

| 轮次     | 模式 | Reference Graph 秒：中位数（最小–最大） | 相对基线改善 | 端到端秒：中位数（最小–最大） | RSS MiB：中位数（最小–最大） |
| -------- | ---- | --------------------------------------: | -----------: | ----------------------------: | ---------------------------: |
| baseline | cold |               126.298 (123.532–130.231) |        0.00% |     209.085 (204.469–212.565) | 4569.406 (4326.969–4601.984) |
| baseline | hot  |                  38.330 (38.111–40.655) |        0.00% |     108.868 (108.563–112.535) | 2760.578 (2729.469–2789.156) |
| round1   | cold |                  80.914 (78.724–81.722) |       35.93% |     162.560 (159.898–165.431) | 4675.375 (4174.859–4800.234) |
| round1   | hot  |                  30.389 (30.100–30.498) |       20.72% |     106.312 (104.173–111.588) | 2937.719 (2775.375–3127.656) |
| round2   | cold |                  73.398 (69.486–74.387) |       41.89% |     166.328 (154.281–172.318) | 3962.625 (3862.516–4101.719) |
| round2   | hot  |                  32.027 (30.991–37.079) |       16.44% |     117.207 (110.907–125.456) | 2689.344 (2492.234–3159.812) |
| round3   | cold |                  67.364 (64.642–67.426) |       46.66% |     149.591 (143.455–152.677) | 4159.000 (4107.688–4208.688) |
| round3   | hot  |                  30.356 (30.240–31.564) |       20.80% |     103.642 (101.359–110.720) | 2933.250 (2854.516–2977.984) |

最终距离目标还差冷启动 32.364 秒、热启动 15.356 秒。最终端到端改善为冷启动 28.45%、热启动 4.80%；负值表示回退。

每组 cold/hot 的源码摘要一致。两轮保留优化批次还逐组保留了相同的缓存索引摘要。基线未逐样本采集索引摘要，其热恢复由独立诊断证明，不能补造当时没有采集的摘要证据。

以下为阶段中位秒数。重叠 task 时间不能相加；snapshot 发布也计入端到端。

| 轮次 / 模式     | graph task | 启动及读取 | checker:build | graph:check | proof:check | source:check |
| --------------- | ---------: | ---------: | ------------: | ----------: | ----------: | -----------: |
| baseline / cold |    124.690 |      1.637 |        46.853 |      17.784 |      18.318 |        5.204 |
| baseline / hot  |     26.242 |     12.114 |        63.286 |       7.100 |       7.639 |        5.223 |
| round1 / cold   |     79.304 |      1.640 |        46.987 |      18.024 |      18.560 |        5.094 |
| round1 / hot    |     19.397 |     10.983 |        68.938 |       7.009 |       7.516 |        5.274 |
| round2 / cold   |     71.460 |      1.797 |        50.451 |      18.422 |      19.061 |        5.431 |
| round2 / hot    |     20.260 |     11.591 |        74.565 |       7.132 |       7.687 |        5.696 |
| round3 / cold   |     65.613 |      1.631 |        46.311 |      17.361 |      17.880 |        5.254 |
| round3 / hot    |     19.272 |     11.172 |        66.051 |       7.091 |       7.628 |        5.218 |

以下为相邻批次的实际变化；正数表示降低，负数表示回退。最后一批没有保留的生产代码变化，不能据此声称新增优化收益。

| 相邻批次 / 模式          | Graph 改善 | Graph task 改善 | 端到端改善 | checker:build 改善 | RSS 减少 |
| ------------------------ | ---------: | --------------: | ---------: | -----------------: | -------: |
| baseline → round1 / cold |     35.93% |          36.40% |     22.25% |             -0.29% |   -2.32% |
| baseline → round1 / hot  |     20.72% |          26.08% |      2.35% |             -8.93% |   -6.42% |
| round1 → round2 / cold   |      9.29% |           9.89% |     -2.32% |             -7.37% |   15.24% |
| round1 → round2 / hot    |     -5.39% |          -4.45% |    -10.25% |             -8.16% |    8.45% |
| round2 → round3 / cold   |      8.22% |           8.18% |     10.06% |              8.21% |   -4.96% |
| round2 → round3 / hot    |      5.22% |           4.88% |     11.57% |             11.42% |   -9.07% |

| 轮次 / 模式     | 全部 5 个 Reference Graph 样本（秒）                       |
| --------------- | ---------------------------------------------------------- |
| baseline / cold | 130.231375, 128.422763, 123.686062, 126.298209, 123.532333 |
| baseline / hot  | 40.654808, 38.329869, 38.554378, 38.274458, 38.110635      |
| round1 / cold   | 81.570055, 81.722082, 78.723939, 78.993925, 80.914337      |
| round1 / hot    | 30.405051, 30.219987, 30.388697, 30.497854, 30.099613      |
| round2 / cold   | 73.610980, 74.387209, 69.624253, 73.397534, 69.486274      |
| round2 / hot    | 35.238667, 30.990875, 37.078965, 32.026905, 31.721329      |
| round3 / cold   | 67.417959, 67.425787, 67.134299, 64.642020, 67.363662      |
| round3 / hot    | 30.279691, 30.240219, 30.355671, 31.563910, 30.508130      |

## 保留与放弃的改动

- 全量优化：单次同步通知共享 hash/binding 派生；有界分析复用首次物理绑定；只为私有发布的 Coverage 建成员索引；只对私有不可变证明复用 canonical 字段顺序；用首条记录 Map 替代反复查找 resolution。冷 Graph 从 126.298 降到 80.914 秒，热从 38.330 降到 30.389 秒。基线冷 CPU profile 中，输入 observation 约 38.77 秒、path binding 约 32.91 秒、Coverage self 约 5.4 秒；inclusive 时间存在重叠。首轮冷/热 RSS 增加 2.32%/6.42%，表中保留该代价。定向语义批次通过 5 个文件的 233 项测试。
- 追加第一轮：批量精确匹配 import literal；在单个 cache generation 内按当前文本/路径/编译器复用中立语法事实；两个同步引用投影共享合格 Vue dependency collection。实际 Program 仍拥有请求和证明。语法微基准约从 170 ms 降到 6.7 ms；冷诊断记录 2,890 次构建、3,578 次语法命中。冷 Graph 降至 73.398 秒，但热 Graph 升至 32.027 秒、热端到端升至 117.207 秒。本轮有明确冷路径收益，不能据此声称热路径改善。修复下述回调遗漏后，141 项受影响测试及定向 Vue replay 情形通过。
- 追加第二轮：试验用一次递归 ancestor Set 替代每个 DTO 节点创建 Set。在包含 9,288 个请求的真实快照上，交替执行、每次预先 GC 的 6 个样本，中位数为修改前 473.638 ms、修改后 469.288 ms，仅改善 0.92%，区间重叠。收益不足以可靠辨认，因此撤回该候选。最终 5 组冷/热测量使用保留的第二轮生产实现，两个批次之间的变化不能算作新增优化收益。保留 sibling alias 所有权回归，保护不可变证明边界。没有删除 Program、Checker、证明、校验或调度任务。
- 放弃：将编码中的 receipt 中间结果标记为已发布 Native 数据会破坏直接解码；修正后不带该标记的方案通过 124 组字节/值对比，却更慢，未保留。实际热 CPU 中 snapshot 语法指纹验证仅 0.092 秒，因此不增加该 memo。没有增加 worker 或并发机制：profile 指向 CPU、观察和表示转换，未证明调度等待是主瓶颈。

生产链继续为 [CLI 配置与 preflight](../../../packages/limina/src/cli/check-run.ts)、[缓存资格校验](../../../packages/limina/src/preflight/analysis-cache.ts)、[恢复或冷准备](../../../packages/limina/src/core/build-graph/prepare.ts)、Checker selection 与实际 bounded Program、reference inference/validation、[物化](../../../packages/limina/src/preflight/materialization.ts)、执行准入及 Checker task，最后[发布](../../../packages/limina/src/execution/executor.ts)。有效热诊断记录 `graphHits=1`、零 semantic Program、零 fallback；declaration candidate 仍需真实验证。冷诊断保留 15 个语义 context、31 个 bounded Program 和 11 个 Vue Program。恢复时零 semantic Program 不等于整个命令零 Program。

## 正确性验收

独立复现 workspace 包含 Native TypeScript 与 Vue、三个项目和真实跨项目 Vue 依赖，pnpm/编译器/框架版本与仓库一致。脚本在单独保留的证据目录中，下文以 `$EVIDENCE_ROOT` 代称；命令从 Limina 仓库运行。断言对比有意义的图数据，而非只检查文件存在。整个仓库的冷/热诊断在基线及两轮保留优化中也均通过 9 类图数据比较；优化后的工作负载包含 952 个依赖 occurrence、4 条不同项目/Checker 边及 20 个 owned artifact。仅忽略编辑导致的源码行号偏移后，基线 950 个依赖 occurrence 全部保留，新增两项来自回归测试导入。13 个 source unit 均保留原有 owned/声明成员、声明引用和 authority；唯一新增源码成员是 Coverage helper。

1. 差分对抗：`node --import tsx "$EVIDENCE_ROOT/coverage-experiment.mjs" semantic "$EVIDENCE_ROOT/evidence/final4-coverage.json"`、`node --import tsx "$EVIDENCE_ROOT/syntax-experiment.mjs" "$EVIDENCE_ROOT/evidence/final4-syntax.json"` 与 `node --import tsx "$EVIDENCE_ROOT/freeze-final.mjs" "$EVIDENCE_ROOT/evidence/final4-freeze.json"`。以旧实现为 Oracle，挑战不完整全集、过期/冲突身份、别名、可变/调用者冻结输入、import/JSDoc 范围、模块扩展名和 DTO 语法。此轮独立于缓存存储检验表示优化。
2. 增量对抗：`node --import tsx "$EVIDENCE_ROOT/fixture-scenarios.mjs" incremental final4`。每种源码正文/新增/删除、依赖重命名、tsconfig、package 模块格式、lockfile 和配置模块修改均先有冷/热阳性控制，再执行变化后的热尝试、强制完整重算和下一次热恢复。manifest、依赖 occurrence、Checker entry、映射、生成文件、ownership、源码/声明成员和语义 authority 必须一致。
3. 恢复/并发对抗：`node --import tsx "$EVIDENCE_ROOT/fixture-scenarios.mjs" recovery final4`。不兼容 schema、损坏 block、伪造 Coverage 必须拒绝恢复且与完整分析一致。非法声明引用必须冷/热拒绝且不替换原索引。两个独立并发进程必须产生相同语义，最多写入一个新修订，除格式已验证的随机修订号外，索引所有字段均须保持一致；后续进程必须正常恢复。

差分复现通过 28,000 项 Coverage 断言、181 个语法样例和 38 项 DTO 断言。8 种增量变化均通过：正文修改创建 3 个语义 context，完整分析为 5 个；lockfile 修改为 1 对 5，其余情形保持保守的 5 个重建。5 种恢复/并发情形均通过。

保留了复现早期的失败记录：直接比较起初包含每次编译器收集生成的 UUID 及其派生 request/obligation 摘要；修正后的比较器先验证关联，再仅规范化这些不透明身份。负控制仍能检测删除边、Coverage 成员及 owned source。另一次断言误要求索引修订号字节不变，但直接 preflight 复现允许重新发布；修正为最多一个写入者、内容不变和合法修订转换。这两项修正没有修改生产代码或放宽语义断言。实施期间 execution-admission 测试还发现过真实的回调迁移遗漏：Native semantic 子类仍向新语法 reader 转发 boolean。两个工厂入口及子类已修复，受影响的 141 项测试通过，并重新执行完整最终门禁。

持久回归归属：[Native evidence](../../../packages/limina/src/__tests__/native-evidence-contract.spec.ts)、[增量 context](../../../packages/limina/src/__tests__/native-context-incremental.spec.ts)、[input replay](../../../packages/limina/src/__tests__/execution-input-replay.spec.ts)、[Vue 恢复](../../../packages/limina/src/__tests__/vue-analysis-cache.spec.ts)、[完整缓存](../../../packages/limina/src/__tests__/full-analysis-cache.spec.ts)、[配置模块](../../../packages/limina/src/__tests__/config-module-cache.spec.ts)、[缓存 lifecycle](../../../packages/limina/src/__tests__/analysis-cache-lifecycle.spec.ts)、[执行准入](../../../packages/limina/src/__tests__/execution-admission.spec.ts)、[发布失败](../../../packages/limina/src/__tests__/output-publication-failures.spec.ts)。既有测试还覆盖 tool/adapter 身份、环境变化、等内容改指、失败传播和发布边界。修改断言保留原有语义要求。

下表 `$REPO` 表示 Limina checkout 根目录，记录最终生产代码验收批次；加入本双语报告后，另行检查格式、双语链接、隐私与仓库门禁。

| 实际命令                                                                                                                                                                                                                                                                                          | 结果   |      耗时 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------: |
| `pnpm run build`                                                                                                                                                                                                                                                                                  | passed |    3.76 s |
| `pnpm run test:unit`                                                                                                                                                                                                                                                                              | passed | 1492.32 s |
| `pnpm run test:tooling`                                                                                                                                                                                                                                                                           | failed |   10.61 s |
| `pnpm run test:integration`                                                                                                                                                                                                                                                                       | passed |  190.28 s |
| `pnpm run test:smoke`                                                                                                                                                                                                                                                                             | passed |  167.65 s |
| `pnpm run docs:build`                                                                                                                                                                                                                                                                             | passed |    4.99 s |
| `pnpm run typecheck`                                                                                                                                                                                                                                                                              | passed |  160.48 s |
| `pnpm run lint:check`                                                                                                                                                                                                                                                                             | passed |   94.95 s |
| `pnpm run check`                                                                                                                                                                                                                                                                                  | passed |  142.14 s |
| `pnpm run lint:packages`                                                                                                                                                                                                                                                                          | passed |   11.49 s |
| `pnpm run gates:check`                                                                                                                                                                                                                                                                            | passed |    0.19 s |
| `pnpm run docs:privacy --context-records .agents/docs`                                                                                                                                                                                                                                            | passed |    0.21 s |
| `git diff --check`                                                                                                                                                                                                                                                                                | passed |    0.04 s |
| `node --import tsx --test $REPO/packages/gates/src/commit/staged.spec.ts`                                                                                                                                                                                                                         | passed |    4.08 s |
| `node --import tsx --test $REPO/scripts/release/check-tag-cli.spec.ts $REPO/scripts/release/cli.spec.ts $REPO/scripts/release/publication.spec.ts $REPO/scripts/release/shared.spec.ts $REPO/scripts/release/workflow.spec.ts $REPO/scripts/docs/privacy.spec.ts $REPO/scripts/git/hooks.spec.ts` | passed |   78.15 s |

完整产品单元测试通过 3,347 项，macOS 按既有平台条件跳过 1 项 Windows junction 测试。集成测试通过 316 项，打包消费者 smoke 通过 21 项。Gates Vitest 部分为 35 项通过、1 项失败。Tooling 状态为**失败**，不算验收通过：未修改的锁定 Vercel 65.4.0 产物内置 Zod 4.1.11，既有门禁要求至少 4.6.7。独立 Array、Set、Map 探针拒绝超限值时仍访问三个元素。依赖声明、lockfile 和该门禁不在性能 diff 中。随后单独运行被短路的 commit（2 项通过）和 release/docs/git（51 项通过）测试；这些通过不能把完整 tooling 结果变绿。安装中的失败 chunk 与 registry tarball 字节一致，tarball integrity 也与 lockfile 相符，因此重装该锁定版本不是已证明有效的修复。没有修改断言、依赖或已安装产物来掩盖失败。

未执行：原生 Windows/Linux 文件系统与子进程、其他 Node 版本、完整外部 TypeScript/Vue 版本矩阵（packed smoke 消费者实际覆盖了 TypeScript 5.8.2）、远程 CI、发布和部署。可移植路径词法测试与本地已安装 adapter 测试不能证明这些环境。实验不证明单次命令对外部编辑的原子观察；继续适用有界读取及独立校验边界合同。

## 代价与剩余瓶颈

| 轮次     |     活跃引用字节（中位数） | 批次结束保留字节 |
| -------- | -------------------------: | ---------------: |
| baseline | 29,028,902（仅批次末观测） |      185,676,178 |
| round1   |                 29,026,874 |      372,096,401 |
| round2   |                 29,033,510 |      558,551,960 |
| round3   |                 29,035,306 |      841,025,248 |

最终峰值 RSS 中位数：冷态从 4,569.406 降到 4,159.000 MiB（减少 8.98%），热态从 2,760.578 升到 2,933.250 MiB（增加 6.25%）。热态 `checker:build` 为 66.051 秒，仍比基线慢 4.37%。即使热端到端改善 4.80%，这些代价仍然存在；现有证据不能证明它们对所有工作负载都可接受。

活跃存储仍约 29 MB。保留总量包括反复冷发布后不可达的 block；既有发布协议没有垃圾回收。它们不代表活跃模型大小回退，但磁盘增长真实存在，没有清理掉后再美化报告。缓存格式/schema 和依赖均未修改。

剩余瓶颈排序区分冷图准备、下游发布与热恢复。冷准备以 coloring/有界 context 收集为主；热恢复以资格校验、绑定和重建为主，其次为重复证明表示转换。没有证据将调度等待列为主要原因。

第二轮后有效热诊断记录 setup/read/qualification 9.031 秒、graph task 20.590 秒。inclusive CPU 包括缓存图绑定 5.577 秒、Vue 引用重建 5.132 秒、证明指纹 3.605 秒、DTO 冻结 2.939 秒。冷 coloring 仍约 59.20 秒；31 个 bounded Program 约 15.00 秒，11 个 Vue Program 约 4.09 秒。该冷诊断中发布约 28.93 秒。这些是诊断观测，不是正式端到端样本，也不能相加。完整热检查的 `checker:build` 从基线 63.286 秒升到第二轮 74.565 秒，最终阶段对比保留于上表。当前证据不能分离主机竞争与实现对该回退的影响。

测量范围止于本记录所述的保留实现。后续修改需要新的实测瓶颈假设；未达目标或更快的微基准都不能成为削弱恢复、准入和发布检查的理由。
