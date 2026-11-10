# 仓库基建

[English](../infrastructure.md) | [简体中文](./infrastructure.md)

本记录负责独立仓库依赖自动化、协作、安全、CI 报告及外部工作流集成。源码建立行为事实；本地结果不证明远程启用或平台验收。

本记录的提交引用指向脱敏后的历史。CI 与审计结果仍属于原有执行；重写提交不会重新运行检查，也不会转移原有 CI 状态。

## 依赖与安全

[Astro 测试基线与兼容性下限策略](./technology-stack.md#astro-测试基线与兼容性下限)负责基线升级与冻结的最低版本 fixture。Checker 分组匹配依赖名，使 npm 别名继续遵循预期的自动化策略。

[Renovate](../../../.github/renovate.json)提出需审查的 catalog／lockfile 更新，不 automerge。排除 peer／engine 契约和独立 fixtures。Checker 家族、package-manager 变化及 major 更新需 dashboard approval；Vite 5 保持既有版本线。不引入第二套更新 bot 或旧 postinstall 自举。

提交校验使用 `@commitlint/cli` 与 `@commitlint/config-conventional` 21.2.3 提供共享解析器、规则引擎、配置和诊断，使用 Husky 9.1.7 安装与执行钩子。仓库特有的排版规则保留在 [commitlint 配置](../../../commitlint.config.mjs)中。这些私有门禁包与根钩子安装开发依赖归属 [catalogs](../../../pnpm-workspace.yaml)，不进入两个产品产物。2026-10-04 的[准入审查](./dependency-admission.md)发现 registry metadata、带标签源码与分发包中的 MIT 许可证一致，所选版本均未废弃，维护者与受维护的发布来源可识别，Node 下限兼容仓库要求（commitlint 为 `>=22.12.0`，Husky 为 `>=18`）。npm 在 9 月 27 日至 10 月 3 日的下载量为两个 commitlint 包各约 1290 万、Husky 约 4410 万，近期七天窗口总量呈上升趋势。来源为 [CLI registry](https://registry.npmjs.org/@commitlint/cli)、[conventional-config registry](https://registry.npmjs.org/@commitlint/config-conventional)、[Husky registry](https://registry.npmjs.org/husky)及其 npm 下载 API。未新增依赖准入、release-age、trust 或 audit 例外。

私有 [pnpm ESLint 适配器](../../../packages/gates/src/eslint/plugins/pnpm-plugin/index.ts)识别限定父包／版本的 overrides 中的 catalog 引用。上游 eslint-plugin-pnpm 1.9.1 错误地将整个 selector 当作包名；适配器只消除这类 unused-item 误报，保留真正未使用的条目报告。根 duplicate-catalog 规则在既有 Vite 允许项之外增加 `path-to-regexp`，因为部署依赖图需要 major 6 和 8 两套 API。这是具名 lint 允许项，不是 audit、trust 或依赖准入例外。ESLint 归属边界的回归测试使用真实临时 workspaces，包含 scoped、限定版本的 selector，并同时展示上游失败及适配后的结果。

[依赖审查](../../../.github/workflows/dependency-review.yml)以 high 为门禁，覆盖 runtime／development／unknown scope。允许列表在[配置](../../../.github/dependency-review-config.yml)中维护，与 [bundled-license 策略](../../../packages/gates/src/license-policy.ts)配套；[仓库门禁](./gates.md)在 pre-commit 与 CI 中拒绝配置漂移，不改写任何一侧。Action 不穷尽拒绝未知 license metadata；构建插件另行拒绝缺失／冲突／禁止的 bundle 证据。未打包依赖仍需准入审查。

[安全 CI](../../../.github/workflows/security.yml)沿用 docs-islands 的 workflow 组织方式，在 PR／main／每周／手动事件集成依赖审计、许可证报告、目录级 SBOM 和可达历史 secret scan。Bash／jq 步骤直接解析 pnpm advisory JSON，进程／registry／schema 异常时失败；high／critical 按既有排除之后返回的 advisory 明细判断。报告作为 workflow artifacts 保留，Security Summary 拒绝失败／取消／skipped 状态。Gitleaks CLI 8.30.1 保留官方 Linux archive 校验值与脱敏报告。不增加自动 issue／PR 消息或 audit／trust 排除。

安全维护使用[workspace 配置](../../../pnpm-workspace.yaml)中的 `security-patches` catalog。保留 undici 和 minimatch 10 brace-expansion overrides 的既有范围，新增 fast-uri 和 moment overrides 分别限定于 Ajv 8 和 rollup-plugin-license。2026-09-30 的本地全类别审计在未变更的 18 项 GHSA 排除下未返回 advisory 明细。Release-age、trust 和 peer 策略继续生效；未新增 audit、trust、release-age 或 deprecation 例外。

2026-10-01，registry 审计针对 Astro 宿主依赖返回了六项 devalue advisory。`astro@^7.0.0>devalue` override 从该 catalog 选择 [5.9.3 安全补丁](https://github.com/sveltejs/devalue/releases/tag/v5.9.3)，满足两个已安装 Astro 版本声明的 `^5.8.1` 范围。Astro 7.0.0、7.3.2 和独立兼容性夹具工作区保留各自版本与边界。所选补丁使用 MIT 许可证，未被 deprecated，发布于 2026-09-18。冻结安装和本地全类别审计通过，在相同 18 个排除项下返回零项 advisory；未增加策略例外。

2026-10-03，对 main `eb6ae0715203650b9c393eb284e5aa0cfdbe0de7` 的本地与远程审计在未变更的排除项下返回两项新的 high advisory：经 Astro 引入的 [http-cache-semantics](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)和经清理／部署开发工具引入的 [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)。当时 registry 的最新版本分别为 4.2.0 和 3.0.3，两项 advisory 均未列出已修复发布版。两个实际 bundle inventory 中均未出现这些包。但全 workspace 的 Security 门禁仍失败；这项观察不授权新增排除或越过失败门禁发布。

docs 隐私审查从远程 main `8f8892f6a491adc2933bee1e438d19d166ad064b` 开始，该基线在此前 18 项之外已经排除这两项 advisory。它的 Security workflow 和采用相同政策的本地审计通过。仅移除这两项排除的独立 manifest／lockfile 控制审计再次返回两项 high advisory；截至 2026-10-03，上游公告仍未列出修复版本。继承的排除是现有门禁的限制，不证明有漏洞的依赖已得到修复。隐私守卫独立于安全排除项和依赖版本；通过该守卫不授权 npm 发布或手动部署。

2026-10-06 的审计返回了一项高危 [sharp advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) 和一项严重 [shell-quote advisory](https://github.com/advisories/GHSA-pqg4-j6r4-53mv)。Workspace 现在在 dev catalog 固定 shell-quote 1.11.0，并从 `security-patches` 将 sharp 0.35.5 限定用于 Astro 7 宿主。最低／当前 Astro 版本与独立夹具工作区保留各自版本和边界。Sharp 补丁将平台包更新到 0.35.5、libvips 包更新到 1.3.4，提供 librsvg 2.63.2。当两个 Astro 宿主无需 override 即可选择安全的 sharp 版本时，移除此限定 override。未增加 audit、release-age、trust、peer 或脚本审批例外。

所选发布包和对应 tag 源码保留 shell-quote 的 MIT 与 sharp 的 Apache-2.0 许可证、兼容的 Node 下限，且没有安装脚本；所选版本均未被 deprecated。Tarball integrity 与 registry 签名校验通过；sharp 的 npm／SLSA attestation 与其 tarball 及 `lovell/sharp` 在 `v0.35.5` 的发布 workflow 匹配。[Quote 入口回归](../../../packages/limina/src/__tests__/standalone-invocation-command.spec.ts)拒绝 comment token 后的 LF、CR 和两种 Unicode 换行符：四项在 1.10.0 上均失败，在 1.11.0 上均通过。Limina 传入字符串 token，既有真实 shell 的 argv 回放仍通过。两个 Astro 宿主在 Linux 上均加载 sharp 0.35.5 与 librsvg 2.63.2，并将小型 SVG 转为 PNG。仅应用依赖补丁时，可比的构建 `dist` 总体积中，Limina 从 3,310,673 增至 3,310,974 字节（+301 字节，0.0091%），migrate 保持 2,065,819 字节；两个 bundle inventory 均不包含 sharp。冻结安装和本地全类别审计通过，在相同 20 个排除项下返回零项 advisory。本地证据不证明原生 Windows／macOS 或远程 CI 验收。

[CodeQL](../../../.github/workflows/codeql.yml)显式加载[范围](../../../.github/codeql-config.yml)，无需产品构建即可分析 JavaScript／TypeScript，覆盖两个产品／私有工具／脚本，排除生成产物／fixtures／测试。静态扫描不代表穷尽运行时／文件系统证明。

## CI 与制品

每次 `docs:build` 都在构建前后运行 `docs:privacy`，覆盖 CI 的 Build Validation 和另行设有门禁的部署构建。[扫描器](../../../packages/gates/src/privacy/index.ts)检查中英文源码、演示数据、public 资源和所有构建文件，包括 HTML、JavaScript、搜索数据及存在的 source map。它解码常见 JSON／URL／HTML 转义、内联文本／source-map 数据、压缩产物和 PNG 文本元数据，拒绝个人／机器路径、本地文件链接、私有主机、终端身份及凭证特征；错误只报告相对位置与类别。仅源码扫描排除依赖目录和不公开的构建／缓存目录；构建目标被独立要求并扫描。这是有边界的模式防护，由 Gitleaks 和人工图片／链接审查补充，不是穷尽的密钥检测或图片 OCR。 PCR 与保存的审计文字通过显式 `--context-records` 使用同一扫描器，增加窄范围的对话归因与私有运行标识检查。仓库相对源码路径、技术证据日期和产品用户概念仍然有效；模式检查仍需语义复核。

[终端录制](../../../scripts/docs/capture-command-transcripts.ts)移除绝对 cwd 元数据，并在终端渲染前替换工作区、CLI 和运行时路径，涵盖被 PTY 读取分块切开的路径。公开查询示例保留可运行的工作区相对命令与交互帧；输出 hash 描述该公开流。写入前再次检查录制输出。录制工作区必须在 docs 的物理目录之外，包括经父目录别名访问的情形，从而避免原始日志和本地链接成为文档输入。[隐私控制测试](../../../scripts/docs/privacy.spec.ts)覆盖录制进程边界、终端渲染、编码输入、嵌套公开文件、压缩图片元数据和不回显隐私的失败报告。2026-10-03 的源码基线因录制个人路径未通过新防护；重新生成的 Linux 录制通过。产品 authority 不变量和安全豁免均未变更。

发布集成 fixture 使用子进程内的时钟推进元数据轮询等待，不实际休眠，同时保留对本地测试 registry 的真实 npm 请求。这移除导致 main 在 2026-10-03 Windows 进程超时的四次五秒等待。既有断言仍要求两个版本的 integrity 可见后才提升渠道，并拒绝已过截止时间的情况；生产轮询、超时限制和手动 workflow dispatch 保持原状。

仓库检查通过 `limina check` 使用 Limina 的[内置默认工作流](../../../packages/limina/src/pipeline/steps.ts)，通过 `limina check <pipeline>` 执行 [limina.config.mts](../../../limina.config.mts)中的命名 pipelines。根脚本、文档构建和发布编排将固定工作流交给这些入口。根配置不再重复定义 `pipelines.check`，默认流程保留 graph、source、proof 与 checker 验证。自定义 pipeline 按检查用途命名：`typecheck`、`format`、`lint`、`packages`、`privacy`、`gates`、`release-tag` 与 `release`。`typecheck` 运行受管理的 `checker:build` 任务，由任务选择并落盘当前 TypeScript 与 Vue 图入口。外部命令输入固定在配置中，遵循 [CLI 工作流边界](./system-model.md#pipeline-与-phase-contracts)。`docs:privacy` 脚本直接调用扫描器，通过其专用输入契约接收目标路径、`--built` 和 `--context-records`；固定的 `privacy` pipeline 仍可执行默认扫描。提交消息文件使用独立集成入口。未使用的 `graph`、`lib`、`vue`、`package` 与 `publish` 别名已移除：前三者手动选择生成的 checker 路径，`lib` 与 `graph` 使用同一 tsgo 入口，包／发布检查现在由实际入口调用。[根配置集成守卫](../../../packages/limina/integration/tests/root-config.spec.ts)在小型 workspace 中执行两个配置的编译器范围，分别拒绝 TypeScript 与 Vue 源码错误。产品不变量 I01–I12 不变。

根配置启用可选的 Knip 分析；Graph 和 Proof 无需空声明即可加入固定默认工作流。共享 build-and-check action 执行一次 `pnpm run check`，移除重复的 `pnpm run typecheck`，后者的流水线只包含同一 Checker Build。独立 typecheck 脚本及流水线、产品构建和框架生产者依赖仍保留。根配置及 CI 工作流测试保护治理覆盖和执行次数。

共享 build action 调用根 `format:check` 与 `lint:check` 别名，分别通过 `limina check format` 和 `limina check lint` 执行只读 Prettier 和 ESLint 校验。[CI 守卫](../../../packages/limina/src/__tests__/ci-workflow.spec.ts)解析实际配置的命令步骤，保护只读参数。两命令覆盖整个仓库；修改仍显式通过 `format:write` 与 `lint:fix` 执行，复用当前 `format` 和 `lint` 脚本。

[CI](../../../.github/workflows/ci.yml)保留单一工作流。[CI 控制器](../../../packages/gates/src/ci/cli.ts)属于仓库治理，通过 Node 直接运行，不依赖工具 Bootstrap，也不增加 Limina 产品 API。`LIMINA_AFFECTED_CI` 默认为 `shadow`：生成影响计划，但所有领域仍执行；`enabled` 才允许 PR/main 增量调度。`disabled`、schedule 和手动运行保持全量，新合同首次运行也全量。远程 shadow/canary 验收之前不得启用增量模式。

冻结计划逐项列出必需 Job、原生 tuple、shard 和 Step。Repository Gates 在 Linux 22 Bootstrap 私有工具后只执行一次 gates/format/lint，其 Bootstrap Artifact 供 Linux 22 Native Build 使用；其他原生 tuple 独立 Bootstrap。每个 Validation 环境分别运行根 Checker、产物检查、Migrate Unit、Tooling 和两套 Integration；显式检查取消状态、Setup 和 Artifact 前置条件，单个领域失败不阻断其他独立 Step。消费者等待 Native Matrix 完成后只准入自己的 producer，不以其他 tuple 的聚合成功为条件。精确相同的 OS/Node tuple 去重。Core 只有在规定的所有原生构建、Checker 和产物检查成功后才能推进。

[Filter](../../../.github/ci/filters.yml)按领域基线分类最终 Git 文件树差异，[Policy 与执行清单](../../../packages/gates/src/ci/contract.ts)决定验证影响。dorny/paths-filter v4.0.3 固定为 `ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d`，使用 Node 24、本地 Git（`token: ''`）、显式 base SHA、JSON 列表和 `some-with-excludes`。其 MIT 许可的发布入口只负责分类，不负责 Checkpoint。哈希、历史和证据复用 Node 内建能力、Git 与既有 GitHub REST API，不新增 npm 依赖、数据库、Tag 或共享 Checkpoint 文件。独立 NUL parser 对照 `git diff --no-renames --name-status -z` 审计 Action 输出。未知路径、基线树中的新目录、特殊 Git 条目、无效 UTF-8、输出缺失、控制合同变化或预算超限一律全量。本地 Node 24 发布入口实验发现：含 LF 的路径可能被较窄 Filter 匹配，却被 `all_files: '**'` 漏掉；独立集合审计拒绝该差异，不丢弃路径。

[Checkpoint Resolver](../../../packages/gates/src/ci/history.ts)分别查询 Repository Gates、Core、Limina Unit、Migrate Unit、Tooling、Integration、Smoke、Windows、Checker Compatibility 和 Docs 的 main push 执行历史。成功证据最多 30 天，解析预算为 60 秒和 1,000 条 Run；分页不完整、来源不明或证据缺失退回全量。发现候选后，对相关祖先区间逐 SHA 查询，不使用创建时间或 success 过滤，覆盖窗口前创建但后来 rerun 的记录。最近实际失败使旧成功失效；unaffected 跳过不推进或替换证据。Checkpoint 之后的失败会强制执行，即使后续恢复让净 Diff 为空。部分 rerun 只有在 API 时间戳、Step 状态、原始 attempt 和收据能唯一证明来源时才复用 Job，禁止跨 Run 拼接成功。

main push 验证事件 SHA；普通提交首次执行已过期时不能产生成功 Status 或收据。目标 commit message 以 `release:` 开头时（不区分大小写，不裁剪前导空白），强制执行全部验证领域，绕过 Checkpoint／路径过滤和 stale-head 优化，并使用独立的 `CI-release-<run-id>` 并发组，关闭自动取消。Planner 读取实际目标 commit，Workflow 并发条件读取 push 事件的 head message。该例外保留全部必需结果、Artifact 检查及发布收据门禁，不在验证完成前授予成功。PR 验证事件对应的精确 merge SHA，对照事件核对两个父节点，Checkpoint 必须属于第一父节点的 Base 历史。Base 身份无法证明时全量验证固定目标；目标不可取得或 checkout 不符时失败。Checkout 获取完整历史。普通 main push 与 PR 分组取消旧运行，schedule、manual 和恢复运行隔离。attempt 大于一且重新执行 Planner 时强制全量并绕过 stale 优化。过期、取消或来源无法追溯的恢复入口是对发布门禁所选 main push Run 执行 **Rerun all jobs**。

Artifact 绑定仓库、Run、producer attempt、plan/contract hash、目标 SHA、OS、架构、精确 Node、pnpm、lockfile 和文件摘要。消费者先核对，再恢复明确列出的 dist 文件及 producer 权限模式；不共享 node_modules、`.limina`、`.tsbuild` 或测试缓存。构建与测试产物保留 30 天，计划和审计收据保留 90 天，受仓库保留策略约束；缺失或过期时恢复失败。`CI Status` 用 Jobs API 与收据逐项核对完整计划，保留独立 Step 的成功和失败结果，并重新核实 unaffected 证明。缺失、取消、失败和非法跳过均失败。候选收据只有在 Status 与对应 Run attempt 最终成功后有效，上传后被取消不能准入发布。Planner 无法查询 API 时可以冻结数字 Workflow ID 未解析的 Full Plan，但 Status 必须再绑定当前仓库、CI workflow 路径与 Run 才能接受。

[发布](../../../.github/workflows/publish-npm.yml)保留最新精确 SHA 的 main push CI/Security/CodeQL 查询，只增加 CI 收据校验。所选 Run、当前 attempt、SHA、合同、完整执行清单和 unaffected 历史证明必须一致；收据缺失、过期或出现较新实际失败时拒绝。手动 CI 不替代 push 证据。本地控制器、真实 Git 与固定 Action 测试不证明 GitHub Matrix 取消、rerun 分组、排队时间或原生 Windows/Linux 行为。远程 canary、shadow/full 对照及 wall-clock/runner 时间测量仍是启用增量模式的验收条件，不预设性能收益已实现。

既有 Windows focused job 还选择路径 helper、框架配置收集和 type-evidence 回归，随后执行两个 Svelte 执行准入用例，覆盖已消费输入及受管刷新间的实时 CommonJS 证明。[`ci-workflow.spec.ts`](../../../packages/limina/src/__tests__/ci-workflow.spec.ts)保护这一选择。快速 job 补充完整平台 matrix；macOS 或 Linux 上的合成 Windows 路径不能替代原生 Windows loader、文件系统和进程验收。

完整矩阵的 Unit Tests 步骤通过 `VITEST_MAX_WORKERS` 将 Vitest 限制为两个 worker，为 CLI 子进程和框架宿主留出资源。独立的 integration 步骤不会继承这个步骤级环境，因此 [integration 配置](../../../packages/limina/vitest.integration.config.ts)也直接将 worker 限制为两个。每个 worker 可能启动多个真实编译器进程；本地复现应使用同一上限，不依赖宿主 CPU 数量。这项限制约束进程扇出，不改变测试选择、默认时限或 invocation 内部的 checker 并发。隔离 CLI 夹具实际复制运行时源码，排除 `__tests__` 目录；依赖链接、编译器 shim 和仓库边界仍由夹具自身持有。安全断言保持不变。

集成夹具遵循生产者优先的默认计划，以及命名 pipeline 的步骤内准备。[故障 launcher](../../../packages/limina/integration/helpers/fault-injection-launcher.ts)通过真实默认计划覆盖默认物化；命名步骤故障不要求存在该独立支撑任务。[默认工作流授权夹具](../../../packages/limina/integration/tests/default-check-workflow.spec.ts)提供物理可解析但未声明的包，防止编译器失败遮蔽 Source 权限拒绝。[构建缓存夹具](../../../packages/limina/integration/tests/config-process-cache.spec.ts)区分已恢复的完整图与生产者阶段的新 Program，并在 force 和禁用分析缓存时保留精确的 build-info 字节及 mtime 检查。

[Vue 跨项目矩阵夹具](../../../packages/limina/fixtures/vue-semantic-matrix/cross-project.mjs)在临时源码 owner 的开发依赖中声明 `vue`，版本取自已安装的 tuple。即使手写 SFC 没有 bare import，Vue 编译器生成的类型导入也需要这项声明。仅有物理 package link 不授予 Source import authority；保留完整默认检查及所有精确 checker tuple。

Windows 保留四份互补 Limina Unit 分片，macOS 保留两份，每份均为两个 worker。[控制器测试](../../../packages/gates/src/ci/ci.spec.ts)与 [Workflow 清单守卫](../../../packages/gates/src/ci/workflow.spec.ts)保护覆盖完整性以及缺失／取消拒绝。Migrate、Tooling 和 Integration 在每个验证环境只执行一次，不再随 Limina 分片重复。Linux 保持不分片。原生验收分别测量排队、依赖等待、Step 执行和 Runner 总消耗。

Limina Unit 与 Validation Job 保留 90 分钟期限，不增加单例测试或子进程时限。成功及失败运行均保留可用测试报告和执行收据；[开发工作流](./development-workflow.md#验证与交付)继续负责 fixture 预算。

六个使用真实 Astro 声明图的跨领域用例各有 120 秒时限，分别覆盖 package imports、核心治理域、两类跨配置边、Proof 的观察集合以及 Build 目标选择。[Windows / Node 22.22.3 日志](https://github.com/senaoxi/limina/actions/runs/40097787173/job/120883562891)记录了 31.713–93.150 秒耗时，超出默认 30 秒预算。全局时限、两 worker 上限、原断言和 Svelte 核心治理用例的 30 秒时限保留。较大的有限时限适用于这些真实工具链用例，在所有平台一致执行；它不修复或证明 Windows 性能，也不替代修改后的原生 Windows CI 验收。

[License plugin](../../../packages/build-tools/src/license.ts)校验 bundler 提供的依赖记录，包含实际打包的开发依赖，并生成各产品的 `LICENSE.md`。它拒绝这些记录中缺失／冲突／禁止的 metadata，不再生成或发布 `bundled-dependencies.json`。这保留 bundle license 门禁与 notices，同时移除独立的机器可读版本清单；其他报告并未因此等价于逐产物 bundle inventory。安全工作流为 `pnpm licenses list --prod --json` 显式选择 limina 和 limina-migrate；这份基于源码 manifest 的依赖报告不替代 bundle license 门禁。构建两个产品后，固定版本的 Anchore／Syft Action 扫描工作目录，在 .reports/sbom 生成 CycloneDX SBOM。扫描范围是目录，不是逐 tarball 依赖 inventory，也不保证消费者最终解析结果。原始审计数据与 Markdown 报告位于 .reports/security，许可证数据与报告位于 .reports/licenses。自制的包体积、SHA-512 和逐包 SBOM 报告已移除。

仓库报告与管理的 .limina namespace 分开。产品不变量 I01–I12 及 guards 不变，不将 I10／I11 推广到任意报告／外部服务。Audit／license／SBOM 报告失败会使 Security 工作流失败。发布和部署分别要求原生依赖审计通过。发布还直接核对 tagged SHA 的完整 CI、Security 和 CodeQL workflows；合并时的 required checks 仍由仓库管理负责。

## Vercel CLI 准入

文档工作区固定 Vercel CLI 65.4.0。[部署 workflow](../../../.github/workflows/deploy-docs.yml) 继续通过 `VERCEL_CLI_USE_NATIVE_BINARY=0` 选择 Node 24.22.1 上的 JavaScript CLI，使用 workspace 冻结依赖图。它在 Vercel 命令前用 Bash `unset` 清除 HTTP、HTTPS、ALL 的六个大小写代理变量。GitHub 会在创建 job 前拒绝仅大小写不同的重复 YAML `env` 键。[Workflow 回归](../../../scripts/release/workflow.spec.ts)检查该执行边界，并以无外部操作的 pnpm 替身执行实际 Bash 步骤，验证三次 Vercel 调用均不接收代理变量。发布包代理 chunk 内嵌 Undici 5.29.0；这些变量会绕过 workspace override 激活它。此路径要求 runner 可以直连网络；用于依赖代理的环境前必须重新评估。[Workspace 配置](../../../pnpm-workspace.yaml)已不再排除 `@vercel/vc-native-*` 可选分发包，因此锁文件中包含平台二进制，安装时也可能引入它们。其内嵌依赖无法继承 JavaScript 补丁或依赖 overrides；二进制、运行时、内嵌依赖与平台审查仍独立于 workflow 的 JavaScript 选择。产品 Node 支持范围保持不变。

Vercel 65.4.0 保持未打补丁状态。已删除内嵌 Zod 版本及超限容器提前拒绝的专项测试，以及仅服务于它的私有 chunk 加载代码与测试 schema 类型。该检查依赖带 hash 的内部产物，而非稳定公开接口。新增第三方 CI 门禁应优先采用受支持的公开接口与实际使用行为。删除后会失去对 Vercel 内嵌副本的专项预警，但不改变产品或部署执行逻辑；此前实验未证明实际部署路径存在可利用漏洞。[Gates 测试池](../../../packages/gates/vitest.config.ts)将 worker 限制为两个，避免 lockfile／准入检查放大并发 ESLint project-service 启动；默认 timeout 保持不变，[根配置冷启动用例](./gates.md#回归归属)单独持有其限定预算。

[Smoke 测试池](../../../smoke/vitest.config.ts)也将 worker 限为两个，约束并发消费者安装和语义 checker 进程，不增加子进程或测试时限。其 pnpm launcher 同时识别点号与连字符形式的原生可执行文件名，使临时消费者在尚无清单时仍沿用调用方固定的版本。消费者 workspace 使用 `packageImportMethod: copy`：其他安装或清理可能在内容与 `mtime` 不变时修改共享硬链接的 `ctime`，使物理身份证据失效。夹具使用独立 inode，避免这种跨测试变更，同时保留 inode、时间戳及同 mtime 篡改检查。

当前 `zod` override 将 registry 声明的依赖解析为 4.6.7；依赖图中已没有 Zod 3，也没有 `GHSA-mrhx-c7xc-m3w5` audit 排除项。[依赖守卫](../../../packages/gates/src/__tests__/dependency-admission.spec.ts)拒绝低于经过审阅的 4.6.7 下限的任何 Zod 版本，包括重新引入的 Zod 3，不再要求存在旧版本或维护 builder 专属消费者例外。依赖图也可以完全移除 Zod，无须保留过时例外。该守卫覆盖解析后的依赖图，不检查 Vercel 内嵌副本，也不证明所有消费者的兼容性。依赖维护者在 Vercel／Zod 变更及 advisory 更新时重新评估该边界。

当前 Vercel 相关 `trustPolicyExclude` selector 为 `vercel` 和 `@vercel/*`，覆盖所有匹配包的版本，而非精确版本列表。它们豁免这些包的 `no-downgrade` 检查，不豁免完整性或签名校验；安装成功不代表每个匹配包及版本的 provenance 都已经审阅。Registry 签名、分发许可证及相关内嵌代码分别审阅。Release-age、严格 peer 和脚本审批策略继续生效。兼容安全更新选择 tar 7.5.22、Ajv 的 fast-uri 3.1.9 和 Undici 7.30.1。产品 bundle 许可门禁和独立消费者检查继续适用；CLI 安装成本不能替代交付产物测量。

[Workspace 配置](../../../pnpm-workspace.yaml)中当前的 `path-to-regexp` overrides 使用独立 security catalogs，仅将 6.1.0 替换为 6.3.0、8.3.0 替换为 8.4.2。Vercel 65.4.0 的 Node 和 Remix builders 同时声明旧 major 6 API 与指向 6.3.0 的 `path-to-regexp-updated` 别名；Backends、Express 和 Hono builders 声明 8.3.0，Fun 已声明 8.4.2。发布的 Remix wrapper 对比原名 `path-to-regexp` import 与安全别名，但返回原名 import 生成的结果，因此仅有安全别名不能保护这条路径。保留两套 API major：major 6 返回 `RegExp` 并填充 keys 参数，major 8 返回包含 `regexp` 和 `keys` 的对象。安全更新会刻意改变歧义路由：6.3.0 将 `/:a-:b` 匹配 `/a-b-c` 的结果拆分为 `a-b` 与 `c`，并拒绝 `/:a:b` 等相邻参数；8.4.2 将可选组和数组的路由组合总数限制为 256。这些属于兼容性边界，不保证所有旧路由行为等价。

这些 overrides 处理 registry 声明的依赖图，以及 `pnpm audit --json` 报告的 [major 6 回溯](https://github.com/advisories/GHSA-9wv6-86v2-598j)、[major 8 可选组](https://github.com/advisories/GHSA-j3q9-mxjg-w52f)和 [major 8 wildcard](https://github.com/advisories/GHSA-27v5-c462-wpq7)告警。验收要求冻结安装、没有残留 `path-to-regexp` audit 告警，以及两套 major 的路由对照，包括对歧义参数和过多可选组展开的刻意拒绝。它们不改写 CLI JavaScript 或原生分发中的内嵌解析器；依赖 audit 清零不能证明所有内嵌路由代码都已修复。其他包的告警保持独立处理。

带父包限定的 `@vercel/static-config>ajv` override 从 security catalog 为 `@vercel/static-config@3.4.4` 选择 Ajv 8.20.0，替换 8.6.3，同时保留独立的 Ajv 6.14.0 消费者。既有 Ajv 8 override 继续使用 fast-uri 3.1.9。已移除 [Ajv advisory](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6) 的忽略项；验收要求冻结安装、不排除此告警的 audit，以及通过已发布配置提取器和验证器的正反例，包括 URI 引用。该验证器使用默认 `new Ajv()`、`compile()` 和 `errorsText()`，没有启用 `$data`。启用 `$data` 属于独立兼容性边界：无效的动态正则表达式在 8.6.3 中抛错，在 8.20.0 中返回验证失败。该 override 覆盖声明依赖，不覆盖 CLI 内嵌副本，也不保证任意恶意正则的安全性。

历史 Vercel 65.2.0 基线于 2026-10-24 使用 macOS arm64、pnpm 12.10.1 和 Node 24.22.1，另有 Node 22.22.3 兼容性夹具。这些结果不代表 Vercel 65.4.0 已通过验收。旧版 56.3.1 输出、有界解析器回归、显式工作目录选择和双语静态 HTTP 交付仍是独立的验证边界。本地证据不证明 Linux／Windows 执行、远程配置或凭据、`vercel pull`、部署上传、CDN 行为或生产网关。手动部署和发布门禁继续生效。

## 外部门禁与协作

[发布](../../../.github/workflows/publish-npm.yml)保持手动，限制为 senaoxi/limina 和 Release environment。仓库通过 dev catalog 消费 registry Logaria，因此本地 release CLI 和 workflow 均不再要求迁移启用变量。[Release CLI](../../../packages/gates/src/release/release.ts)执行通常的 Git、版本、认证和包检查。本地 release 准备仍将 provenance 发布交给手动 dispatch 的工作流；移除启用变量不会触发工作流，也不授权 npm 上传。发布与部署 runner 均在 tag 检查前执行 `pnpm run build:tools`：发布检查入口使用门禁包已编译的导出，而全新依赖安装不会构建这些产物。[Tag 检查](../../../scripts/release/check-tag-cli.ts)拒绝导入标签，要求两个公开源码包的名称／版本完整且一致、checkout 精确对应 tag 且位于 origin/main 历史中。发布前，实际 Bash workflow 按 Git 解析的 checkout SHA 查询 CI、Security 和 CodeQL 最近一次 main push run，拒绝缺失／pending／失败／取消／skipped 或身份不符的响应，并保留响应与 SHA。其他分支或提交的绿色 run 不能满足此门禁。Checkout 还必须等于 npm provenance 使用的 dispatch 事件 `GITHUB_SHA`；应以 release tag dispatch，或在 main 仍指向同一提交时使用 main。仅改变 checkout 不会改变证明中的事件提交。发布 jobs 串行执行；Vitest 保留 CI 的两个 worker 限制。发布与部署使用原生 `pnpm audit --audit-level high` 在外部操作前执行审计。

[版本规划](../../../packages/gates/src/release/shared.ts)在未指定 preid 时沿用已有预发布标识，稳定版默认使用 alpha；显式标识参与 SemVer 递增，降级仍会拒绝。交互提示显示当前标识；完整版本号需使用 `--version`。默认 npm 渠道根据最终版本的首个预发布标识选择；数字或 SemVer range 形状的标识使用 `next`。显式 `--npm-tag` 可覆盖渠道，但空值、编码字符、选项形状及版本范围会在规划阶段拒绝。[双包边界](../../../packages/gates/src/release/publication.ts)再次检查渠道，确保非法标签在打包或上传前失败。

[整仓检查](../../../packages/gates/src/release/release.ts)按发布组执行一次 build、unit、tooling、integration 和所需 smoke，然后分别检查两包的版本、产物、发布一致性与 pack。直接运行 test:\* 脚本避免 test／smoke 包装器再次构建。`--skip-tests` 只跳过测试；`--skip-build` 复用既有产物并跳过构建及逐包检查，不再隐式重建；未跳过的测试仍执行，上传边界校验仍生效。这些是外部发布编排契约，不改变 I01–I12 的产品 authority／generation／namespace 规则。

发布 runner 安装 npm 11.21.0，获准入口拒绝 `^11.21.0 || >=12.2.0` 之外的版本，与 [npm 的可信 dist-tag 要求](https://docs.npmjs.com/trusted-publishers/#managing-dist-tags-with-trusted-publishing)一致。两个包均需已有获准的 publisher，并允许 publish 和 dist-tag 操作；dist-tag 能力默认单独关闭。新包必须先存在，才可配置 publisher。这些账户前置条件不会因 workflow 修改、公开包 metadata 或 `npm whoami` 成功而启用。

[双包发布](../../../packages/gates/src/release/publication.ts)先打包两个产品，在上传前比对 registry 的不可变 integrity，用 candidate tag 发布这些精确 tarball，然后才将两个包推进到请求的渠道。流程回读渠道，并遵守 [latest 保留及包命名空间自举规则](./migration.md)。npm 操作仍不具原子性：第二包上传失败时第一包的 candidate 已可用；第二包渠道推进失败时两个版本已存在，但渠道可能暂时不一致。获准 CI attempt 在 `.reports/release/npm` 保留实际 tarball、预期／观测 integrity、渠道快照与失败阶段；客户端失败后回读 registry integrity 核实实际上传情况。对未变更产物重试时跳过匹配的上传、修复渠道，并拒绝不同的不可变内容。失败 attempt 不会报告为双包成功。这些证据由 publisher 负责，不恢复已移除的通用包体积／逐包 SBOM 报告流程。

元数据可见性默认使用每包三十分钟的单调时钟期限，以容纳上传后的 registry 处理。两个发布命令均接受 `--metadata-timeout <ms>` 和 `--registry-query-timeout <ms>`；`LIMINA_RELEASE_METADATA_TIMEOUT_MS` 与 `LIMINA_RELEASE_REGISTRY_QUERY_TIMEOUT_MS` 为获准 CI 入口配置相同预算。显式选项优先于环境变量，环境变量优先于默认值。输入必须是子进程超时范围内的正整数毫秒，并在发布工作前完成准入。发布中的每次元数据或渠道查询默认使用三十秒进程超时；轮询时按剩余可见性预算缩短查询超时，并拒绝在期限后观测到的结果。E404 仍按五秒间隔轮询；其他读取失败、查询超时及完整性不匹配立即失败。发布 receipt 保留实际生效的预算。既有完整性、双包渠道提升和恢复规则保持不变。实现复用共享 npm executor 与 Node 子进程超时能力，不新增依赖。

[手动发布表单](../../../.github/workflows/publish-npm.yml)提供数字类型的 `metadata_timeout_ms` 与 `registry_query_timeout_ms` 输入，默认分别为 `1800000` 和 `30000`。工作流仅在 npm 发布步骤通过上述环境变量传递输入，因此覆盖值不影响之前的构建、测试或质量步骤。零及其他非法值会进入既有准入检查，不会静默改用默认值。这些预算约束发布读取，不设置整个 Actions job 的期限。dispatch 与 checkout 都必须使用包含超时实现及工作流输入的获准发布提交；仅更新 main 不会更新旧 tag。

两个 npm 包完成核对与渠道更新后，发布工作流直接创建指向两包共享 changelog 的 GitHub release，链接使用 Git 解析的已 checkout 获准提交，而非 dispatch 事件 SHA。本地 release 预览明确说明，GitHub release 由这个手动触发的工作流负责创建。同一 tag 已存在的完整 release 可接受；draft 和查询错误时失败。SBOM 和许可证报告作为 workflow artifacts 保留，不再维护自制 GitHub release 附件流程。发布模块负责的导入标签名称守卫不依赖已删除的迁移 metadata；移动导入标签也不会使其名称可发布。

[文档部署](../../../.github/workflows/deploy-docs.yml)保持单独手动，由 LIMINA_DOCS_DEPLOY_ENABLED=1 和 Production 控制。要求新的获准 tag、HTTPS DOCS_ORIGIN 和独立 Vercel 凭据／project。工作流从既有私有 docs workspace 执行 Vercel CLI，同时将仓库根目录保留为项目 cwd。既有 CLI 版本由 dev catalog 和冻结 lockfile 负责，保留相同的部署安全 overrides；已移除的部署 workspace 继续保持删除。CLI 是 docs 开发依赖，不进入两个发布包。记录中的规范公开文档入口为 `https://senao.me/repos/limina/`。文档站保留固定 `/repos/limina/` base，提供 origin 时在该 base 下生成 sitemap。Senao 站点负责通往独立 Limina Vercel 部署的外部 gateway。两个工作流保留[迁移前置条件](./migration.md)，本地集成不执行外部操作。

PR 标题通过仅处理 metadata 的 workflow 检查，不 checkout PR。模板收集包／命令／cwd／checker／复现／实际检查。提供英文贡献／安全政策及仅涉及项目的编辑器设置，不自动格式化 fixtures。

跟踪的 [pre-commit 钩子](../../../.husky/pre-commit)在消息校验前调用[暂存区仓库门禁](./gates.md#提交与-ci-入口)。它独立于未暂存修复，检查预期暂存区，阻止许可证策略与配置不一致的提交。

本地提交通过跟踪的 [Husky commit-msg 钩子](../../../.husky/commit-msg)，以 `node packages/gates/src/commit/message.ts "$1"` 直接调用专用的[消息文件入口](../../../packages/gates/src/commit/message.ts)。该入口按共享配置调用 commitlint，执行[提交约定](../../../.github/commit-convention.md)。根 `prepare` 和 `hooks:install` 直接调用 Husky CLI，由其将本地 `core.hooksPath` 配置为 `.husky/_` 并提供 hook 执行层。在 Husky 可用时，安装与执行遵循原生的 `HUSKY=0` 禁用机制。生成的 Husky 文件不受 Git 跟踪。根 `commit:check` 别名通过 `pnpm run commit:check <message-file>` 调用同一入口，支持按 Git cleanup 语义直接检查消息文件。运行时消息文件名归该集成入口所有；仓库没有 `commit` pipeline 或通用流水线参数转发。机械检查保留独立的 50 字符 subject 上限、小写开头、连续正文项目、精确分隔空行、breaking footer、revert 正文及生成的同版本发布消息；禁用冲突的 conventional 行长默认值，以及 merge／fixup／squash 自动忽略。文案语义仍由审查负责，消息文件不会被改写。[工具测试](../../../scripts/git/hooks.spec.ts)覆盖共享 commitlint 配置、CLI 接受／拒绝、Git cleanup、真实提交拒绝时保留 HEAD／index、幂等安装、显式禁用及关联 worktree 中的提交校验，通过 `test:tooling` 进入既有 CI 矩阵；本地执行不证明远程平台验收。产品不变量 I01–I12 不受影响。

管理操作需单独启用 Renovate、受支持的 dependency review／code scanning、私有安全报告、labels、受保护 environments 和 required checks。建议检查：CI Status、Dependency Review、Dependency Audit、Secret Scan、CodeQL、PR Title。本地文件不启用设置，也不证明功能可用。

## 验证归属

基建参照 docs-islands 直接集成到 workflow，不另维护一层基建脚本。根 test:tooling 执行私有门禁包测试，并在[发布边界](../../../scripts/release/publication.spec.ts)保留 bundle license 与历史标签守卫，以及双包 npm integrity／重试覆盖。已移除的 TypeScript 审计解析器与逐包 SBOM 测试随其生产接口退役。安全命令与报告行为归 workflow 所有；本地 shell 实验必须执行实际步骤，不另写一套解析器。报告与外部服务仍在 .limina 权威之外，因此产品不变量 I01–I12 不受影响。Build／tooling／unit／integration／smoke／typecheck／check／package／lint／format／docs 门禁仍适用；本地结果不证明 Actions 上的 Syft／Gitleaks 执行、远程平台验收、发布或部署。

[Release CLI 回归](../../../scripts/release/cli.spec.ts)覆盖正式版与预发布计划在没有启用变量时进入正常预检，并保留本地 provenance 要求。Workflow 配置回归保留手动 dispatch、仓库范围和 Release environment。这些属于外部发布契约，产品不变量 I01–I12 不变。

[Tag CLI 回归](../../../scripts/release/check-tag-cli.spec.ts)在缺少迁移 metadata 时使用真实 Git 标签，覆盖完整公开源码发布组、checkout 身份与 main 祖先关系。[发布 workflow 回归](../../../scripts/release/workflow.spec.ts)在受控 GitHub CLI 响应下执行实际 Bash 步骤，检查共享 changelog 存在于链接提交；Windows 跳过该 Bash 路径，因为此 Ubuntu 发布任务不在 Windows 上运行。[Changelog 覆盖](../../../scripts/release/shared.spec.ts)保护非空内容渲染及历史链接保留。

发布回归还用成功、错误 SHA／branch／event、provenance 事件 SHA 不符、pending、失败／取消／skipped、缺失及查询失败响应执行实际精确 SHA Bash 门禁；获准 CLI 在包操作前拒绝不支持可信 dist-tag 的 npm 版本。本地 HTTP registry 覆盖部分上传／渠道推进后的恢复、tarball 证据保留、上传已被接受但客户端收到失败响应、收到成功响应但渠道缺失、不可变内容不一致，以及 beta 推进时保持 `latest`。这个夹具证明编排行为，不证明 npm 账户授权或真实 registry 发布。

[历史 Windows CI 运行](https://github.com/senaoxi/limina/actions/runs/37103605023/job/111147752777)完成了两个产品的单测，随后组合发布恢复用例在 60 秒后超时。现在每种 registry 故障分别使用新的夹具和独立用例，保持相同的每例 60 秒预算及既有单条命令 45 秒时限。全部失败／恢复断言保留；不跳过 Windows 路径，也不增加 timeout。
