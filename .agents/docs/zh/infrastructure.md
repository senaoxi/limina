# 仓库基建

[English](../infrastructure.md) | [简体中文](./infrastructure.md)

本记录负责独立仓库依赖自动化、协作、安全、CI 报告及外部工作流集成。源码建立行为事实；本地结果不证明远程启用或平台验收。

## 依赖与安全

[Renovate](../../../.github/renovate.json)提出需审查的 catalog／lockfile 更新，不 automerge。排除 peer／engine 契约和独立 fixtures。Checker 家族、package-manager 变化及 major 更新需 dashboard approval；Vite 5 保持既有版本线。不引入第二套更新 bot 或旧 postinstall 自举。

提交校验使用 `@commitlint/cli` 与 `@commitlint/config-conventional` 21.2.3 提供共享解析器、规则引擎、配置和诊断，使用 Husky 9.1.7 安装与执行钩子。仓库特有的排版规则保留在 [commitlint 配置](../../../commitlint.config.mjs)中。这些根开发依赖归属 [catalogs](../../../pnpm-workspace.yaml)，不进入两个产品产物。2026-10-04 的[准入审查](./dependency-admission.md)发现 registry metadata、带标签源码与分发包中的 MIT 许可证一致，所选版本均未废弃，维护者与受维护的发布来源可识别，Node 下限兼容仓库要求（commitlint 为 `>=22.12.0`，Husky 为 `>=18`）。npm 在 9 月 27 日至 10 月 3 日的下载量为两个 commitlint 包各约 1290 万、Husky 约 4410 万，近期七天窗口总量呈上升趋势。来源为 [CLI registry](https://registry.npmjs.org/@commitlint/cli)、[conventional-config registry](https://registry.npmjs.org/@commitlint/config-conventional)、[Husky registry](https://registry.npmjs.org/husky)及其 npm 下载 API。未新增依赖准入、release-age、trust 或 audit 例外。

私有 [pnpm ESLint 适配器](../../../packages/eslint-config/src/plugins/pnpm-plugin/index.ts)识别限定父包／版本的 overrides 中的 catalog 引用。上游 eslint-plugin-pnpm 1.9.1 错误地将整个 selector 当作包名；适配器只消除这类 unused-item 误报，保留真正未使用的条目报告。根 duplicate-catalog 规则在既有 Vite 允许项之外增加 `path-to-regexp`，因为部署依赖图需要 major 6 和 8 两套 API。这是具名 lint 允许项，不是 audit、trust 或依赖准入例外。ESLint 归属边界的回归测试使用真实临时 workspaces，包含 scoped、限定版本的 selector，并同时展示上游失败及适配后的结果。

[依赖审查](../../../.github/workflows/dependency-review.yml)以 high 为门禁，覆盖 runtime／development／unknown scope。允许列表在[配置](../../../.github/dependency-review-config.yml)中维护，与 [bundled-license 策略](../../../packages/build-tools/src/license-policy.ts)配套；没有单独的配置同步脚本。Action 不穷尽拒绝未知 license metadata；构建插件另行拒绝缺失／冲突／禁止的 bundle 证据。未打包依赖仍需准入审查。

[安全 CI](../../../.github/workflows/security.yml)沿用 docs-islands 的 workflow 组织方式，在 PR／main／每周／手动事件集成依赖审计、许可证报告、目录级 SBOM 和可达历史 secret scan。Bash／jq 步骤直接解析 pnpm advisory JSON，进程／registry／schema 异常时失败；high／critical 按既有排除之后返回的 advisory 明细判断。报告作为 workflow artifacts 保留，Security Summary 拒绝失败／取消／skipped 状态。Gitleaks CLI 8.30.1 保留官方 Linux archive 校验值与脱敏报告。不增加自动 issue／PR 消息或 audit／trust 排除。

安全维护使用[workspace 配置](../../../pnpm-workspace.yaml)中的 `security-patches` catalog。保留 undici 和 minimatch 10 brace-expansion overrides 的既有范围，新增 fast-uri 和 moment overrides 分别限定于 Ajv 8 和 rollup-plugin-license。2026-09-30 的本地全类别审计在未变更的 18 项 GHSA 排除下未返回 advisory 明细。Release-age、trust 和 peer 策略继续生效；未新增 audit、trust、release-age 或 deprecation 例外。

2026-10-01，registry 审计针对 Astro 宿主依赖返回了六项 devalue advisory。`astro@^7.0.0>devalue` override 从该 catalog 选择 [5.9.3 安全补丁](https://github.com/sveltejs/devalue/releases/tag/v5.9.3)，满足两个已安装 Astro 版本声明的 `^5.8.1` 范围。Astro 7.0.0、7.3.2 和独立兼容性夹具工作区保留各自版本与边界。所选补丁使用 MIT 许可证，未被 deprecated，发布于 2026-09-18。冻结安装和本地全类别审计通过，在相同 18 个排除项下返回零项 advisory；未增加策略例外。

2026-10-03，对 main `772e3c1cb2c58de42a3ae0055580cba69dc6296b` 的本地与远程审计在未变更的排除项下返回两项新的 high advisory：经 Astro 引入的 [http-cache-semantics](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)和经清理／部署开发工具引入的 [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)。当时 registry 的最新版本分别为 4.2.0 和 3.0.3，两项 advisory 均未列出已修复发布版。两个实际 bundle inventory 中均未出现这些包。但全 workspace 的 Security 门禁仍失败；这项观察不授权新增排除或越过失败门禁发布。

docs 隐私审查从远程 main `c70906655486fded56178e95ec5120175532a9d3` 开始，该基线在此前 18 项之外已经排除这两项 advisory。它的 Security workflow 和采用相同政策的本地审计通过。仅移除这两项排除的独立 manifest／lockfile 控制审计再次返回两项 high advisory；截至 2026-10-03，上游公告仍未列出修复版本。继承的排除是现有门禁的限制，不证明有漏洞的依赖已得到修复。隐私守卫独立于安全排除项和依赖版本；通过该守卫不授权 npm 发布或手动部署。

[CodeQL](../../../.github/workflows/codeql.yml)显式加载[范围](../../../.github/codeql-config.yml)，无需产品构建即可分析 JavaScript／TypeScript，覆盖两个产品／私有工具／脚本，排除生成产物／fixtures／测试。静态扫描不代表穷尽运行时／文件系统证明。

## CI 与制品

每次 `docs:build` 都在构建前后运行 `docs:privacy`，覆盖 CI 的 Build Validation 和另行设有门禁的部署构建。[扫描器](../../../scripts/docs/privacy.ts)检查中英文源码、演示数据、public 资源和所有构建文件，包括 HTML、JavaScript、搜索数据及存在的 source map。它解码常见 JSON／URL／HTML 转义、内联文本／source-map 数据、压缩产物和 PNG 文本元数据，拒绝个人／机器路径、本地文件链接、私有主机、终端身份及凭证特征；错误只报告相对位置与类别。仅源码扫描排除依赖目录和不公开的构建／缓存目录；构建目标被独立要求并扫描。这是有边界的模式防护，由 Gitleaks 和人工图片／链接审查补充，不是穷尽的密钥检测或图片 OCR。 PCR 与保存的审计文字通过显式 `--context-records` 使用同一扫描器，增加窄范围的对话归因与私有运行标识检查。仓库相对源码路径、技术证据日期和产品用户概念仍然有效；模式检查仍需语义复核。

[终端录制](../../../scripts/docs/capture-command-transcripts.ts)移除绝对 cwd 元数据，并在终端渲染前替换工作区、CLI 和运行时路径，涵盖被 PTY 读取分块切开的路径。公开查询示例保留可运行的工作区相对命令与交互帧；输出 hash 描述该公开流。写入前再次检查录制输出。录制工作区必须在 docs 的物理目录之外，包括经父目录别名访问的情形，从而避免原始日志和本地链接成为文档输入。[隐私控制测试](../../../scripts/docs/privacy.spec.ts)覆盖录制进程边界、终端渲染、编码输入、嵌套公开文件、压缩图片元数据和不回显隐私的失败报告。2026-10-03 的源码基线因录制个人路径未通过新防护；重新生成的 Linux 录制通过。产品 authority 不变量和安全豁免均未变更。

发布集成 fixture 使用子进程内的时钟推进元数据轮询等待，不实际休眠，同时保留对本地测试 registry 的真实 npm 请求。这移除导致 main 在 2026-10-03 Windows 进程超时的四次五秒等待。既有断言仍要求两个版本的 integrity 可见后才提升渠道，并拒绝已过截止时间的情况；生产轮询、超时限制和手动 workflow dispatch 保持原状。

仓库检查通过 `limina check` 使用 Limina 的[内置默认工作流](../../../packages/limina/src/pipeline/steps.ts)，通过 `limina check <pipeline>` 执行 [limina.config.mts](../../../limina.config.mts)中的命名 pipelines。根脚本、commit-msg 钩子、文档构建和发布编排间接调用这些入口。根配置不再重复定义 `pipelines.check`，默认流程保留 graph、source、proof 与 checker 验证。自定义 pipeline 按检查用途命名：`typecheck`、`format`、`lint`、`packages`、`privacy`、`commit`、`release-tag` 与 `release`。`typecheck` 运行受管理的 `checker:build` 任务，由任务选择并落盘当前 TypeScript 与 Vue 图入口。外部命令别名把工具参数放在 `--` 后，保留消息文件名及 `--built`、`--context-records` 等隐私扫描选项。根配置读取这段参数；该仓库约定不新增公共 CLI 参数转发契约。未使用的 `graph`、`lib`、`vue`、`package` 与 `publish` 别名已移除：前三者手动选择生成的 checker 路径，`lib` 与 `graph` 使用同一 tsgo 入口，包／发布检查现在由实际入口调用。[根配置集成守卫](../../../packages/limina/integration/tests/root-config.spec.ts)在小型 workspace 中执行两个配置的编译器范围，分别拒绝 TypeScript 与 Vue 源码错误。产品不变量 I01–I12 不变。

共享 build action 调用根 `format:check` 与 `lint:check` 别名，分别通过 `limina check format` 和 `limina check lint` 执行只读 Prettier 和 ESLint 校验。[CI 守卫](../../../packages/limina/src/__tests__/ci-workflow.spec.ts)解析实际配置的命令步骤，保护只读参数。两命令覆盖整个仓库；修改仍显式通过 `format:write` 与 `lint:fix` 执行，复用当前 `format` 和 `lint` 脚本。

[CI](../../../.github/workflows/ci.yml)保留原生平台 build／test／smoke 和独立 Vue tuples。Linux quality 复用同提交／平台的 package artifacts，其他环境独立构建／检查。显式 build 后使用 test:smoke，不重复构建。不引入路径过滤、Nx cache 或缓存 .limina 状态。CI Status 依赖全部验证任务，失败／取消／skipped 都失败。

完整矩阵的 Unit Tests 步骤通过 `VITEST_MAX_WORKERS` 将 Vitest 限制为两个 worker，为 CLI 子进程和框架宿主留出资源。隔离 CLI 夹具实际复制运行时源码，排除 `__tests__` 目录；依赖链接、编译器 shim 和仓库边界仍由夹具自身持有。测试选择、安全断言和超时保持不变。

[License plugin](../../../packages/build-tools/src/license.ts)保留来自实际 bundler 输入的 bundled-dependencies.json，包含实际打包的开发依赖，拒绝缺失／冲突／禁止的 metadata。安全工作流为 `pnpm licenses list --prod --json` 显式选择 limina 和 limina-migrate；这份基于源码 manifest 的依赖报告不替代 bundle license 门禁。构建两个产品后，固定版本的 Anchore／Syft Action 扫描工作目录，在 .reports/sbom 生成 CycloneDX SBOM。扫描范围是目录，不是逐 tarball 依赖 inventory，也不保证消费者最终解析结果。原始审计数据与 Markdown 报告位于 .reports/security，许可证数据与报告位于 .reports/licenses。自制的包体积、SHA-512 和逐包 SBOM 报告已移除。

仓库报告与管理的 .limina namespace 分开。产品不变量 I01–I12 及 guards 不变，不将 I10／I11 推广到任意报告／外部服务。Audit／license／SBOM 报告失败会使 Security 工作流失败。发布和部署分别要求原生依赖审计通过。发布还直接核对 tagged SHA 的完整 CI、Security 和 CodeQL workflows；合并时的 required checks 仍由仓库管理负责。

## 外部门禁与协作

[发布](../../../.github/workflows/publish-npm.yml)保持手动，限制为 senaoxi/limina 和 Release environment。仓库通过 dev catalog 消费 registry Logaria，因此本地 release CLI 和 workflow 均不再要求迁移启用变量。[Release CLI](../../../scripts/release/release.ts)执行通常的 Git、版本、认证和包检查。本地 release 准备仍将 provenance 发布交给手动 dispatch 的工作流；移除启用变量不会触发工作流，也不授权 npm 上传。发布与部署 runner 均在 tag 检查前执行 `pnpm run build:tools`：检查入口的私有 logger 使用已编译的包导出，而全新依赖安装不会构建这些产物。[Tag 检查](../../../scripts/release/check-tag-cli.ts)拒绝导入标签，要求两个公开源码包的名称／版本完整且一致、checkout 精确对应 tag 且位于 origin/main 历史中。发布前，实际 Bash workflow 按 Git 解析的 checkout SHA 查询 CI、Security 和 CodeQL 最近一次 main push run，拒绝缺失／pending／失败／取消／skipped 或身份不符的响应，并保留响应与 SHA。其他分支或提交的绿色 run 不能满足此门禁。Checkout 还必须等于 npm provenance 使用的 dispatch 事件 `GITHUB_SHA`；应以 release tag dispatch，或在 main 仍指向同一提交时使用 main。仅改变 checkout 不会改变证明中的事件提交。发布 jobs 串行执行；Vitest 保留 CI 的两个 worker 限制。发布与部署使用原生 `pnpm audit --audit-level high` 在外部操作前执行审计。

[版本规划](../../../scripts/release/shared.ts)在未指定 preid 时沿用已有预发布标识，稳定版默认使用 alpha；显式标识参与 SemVer 递增，降级仍会拒绝。交互提示显示当前标识；完整版本号需使用 `--version`。默认 npm 渠道根据最终版本的首个预发布标识选择；数字或 SemVer range 形状的标识使用 `next`。显式 `--npm-tag` 可覆盖渠道，但空值、编码字符、选项形状及版本范围会在规划阶段拒绝。[双包边界](../../../scripts/release/publication.ts)再次检查渠道，确保非法标签在打包或上传前失败。

[整仓检查](../../../scripts/release/release.ts)按发布组执行一次 build、unit、tooling、integration 和所需 smoke，然后分别检查两包的版本、产物、发布一致性与 pack。直接运行 test:\* 脚本避免 test／smoke 包装器再次构建。`--skip-tests` 只跳过测试；`--skip-build` 复用既有产物并跳过构建及逐包检查，不再隐式重建；未跳过的测试仍执行，上传边界校验仍生效。这些是外部发布编排契约，不改变 I01–I12 的产品 authority／generation／namespace 规则。

发布 runner 安装 npm 11.21.0，获准入口拒绝 `^11.21.0 || >=12.2.0` 之外的版本，与 [npm 的可信 dist-tag 要求](https://docs.npmjs.com/trusted-publishers/#managing-dist-tags-with-trusted-publishing)一致。两个包均需已有获准的 publisher，并允许 publish 和 dist-tag 操作；dist-tag 能力默认单独关闭。新包必须先存在，才可配置 publisher。这些账户前置条件不会因 workflow 修改、公开包 metadata 或 `npm whoami` 成功而启用。

[双包发布](../../../scripts/release/publication.ts)先打包两个产品，在上传前比对 registry 的不可变 integrity，用 candidate tag 发布这些精确 tarball，然后才将两个包推进到请求的渠道。流程回读渠道，并遵守 [latest 保留及包命名空间自举规则](./migration.md)。npm 操作仍不具原子性：第二包上传失败时第一包的 candidate 已可用；第二包渠道推进失败时两个版本已存在，但渠道可能暂时不一致。获准 CI attempt 在 `.reports/release/npm` 保留实际 tarball、预期／观测 integrity、渠道快照与失败阶段；客户端失败后回读 registry integrity 核实实际上传情况。对未变更产物重试时跳过匹配的上传、修复渠道，并拒绝不同的不可变内容。失败 attempt 不会报告为双包成功。这些证据由 publisher 负责，不恢复已移除的通用包体积／逐包 SBOM 报告流程。

两个 npm 包完成核对与渠道更新后，发布工作流直接创建指向两包共享 changelog 的 GitHub release，链接使用 Git 解析的已 checkout 获准提交，而非 dispatch 事件 SHA。本地 release 预览明确说明，GitHub release 由这个手动触发的工作流负责创建。同一 tag 已存在的完整 release 可接受；draft 和查询错误时失败。SBOM 和许可证报告作为 workflow artifacts 保留，不再维护自制 GitHub release 附件流程。发布模块负责的导入标签名称守卫不依赖已删除的迁移 metadata；移动导入标签也不会使其名称可发布。

[文档部署](../../../.github/workflows/deploy-docs.yml)保持单独手动，由 LIMINA_DOCS_DEPLOY_ENABLED=1 和 Production 控制。要求新的获准 tag、HTTPS DOCS_ORIGIN 和独立 Vercel 凭据／project。工作流从既有私有 docs workspace 执行 Vercel CLI，同时将仓库根目录保留为项目 cwd。既有 CLI 版本由 dev catalog 和冻结 lockfile 负责，保留相同的部署安全 overrides；已移除的部署 workspace 继续保持删除。CLI 是 docs 开发依赖，不进入两个发布包。记录中的规范公开文档入口为 `https://senao.me/repos/limina/`。文档站保留固定 `/repos/limina/` base，提供 origin 时在该 base 下生成 sitemap。Senao 站点负责通往独立 Limina Vercel 部署的外部 gateway。两个工作流保留[迁移前置条件](./migration.md)，本地集成不执行外部操作。

PR 标题通过仅处理 metadata 的 workflow 检查，不 checkout PR。模板收集包／命令／cwd／checker／复现／实际检查。提供英文贡献／安全政策及仅涉及项目的编辑器设置，不自动格式化 fixtures。

本地提交通过跟踪的 [Husky commit-msg 钩子](../../../.husky/commit-msg)、Limina `commit` pipeline 与[消息文件入口](../../../scripts/git/commit-message.ts)，按共享配置调用 commitlint，执行[提交约定](../../../.github/commit-convention.md)。根 `prepare` 和 `hooks:install` 直接调用 Husky CLI，由其将本地 `core.hooksPath` 配置为 `.husky/_` 并提供 hook 执行层。在 Husky 可用时，安装与执行遵循原生的 `HUSKY=0` 禁用机制。生成的 Husky 文件不受 Git 跟踪。`commit` pipeline 使用当前 Node 的绝对可执行路径，使 Windows 将含空格的消息文件路径作为一个原生参数传递，覆盖关联 worktree。根 `commit:check` 别名运行 `limina check commit -- <message-file>`，支持按 Git cleanup 语义直接检查消息文件。机械检查保留独立的 50 字符 subject 上限、小写开头、连续正文项目、精确分隔空行、breaking footer、revert 正文及生成的同版本发布消息；禁用冲突的 conventional 行长默认值，以及 merge／fixup／squash 自动忽略。文案语义仍由审查负责，消息文件不会被改写。[工具测试](../../../scripts/git/hooks.spec.ts)覆盖共享 commitlint 配置、CLI 接受／拒绝、Git cleanup、真实提交拒绝时保留 HEAD／index、幂等安装、显式禁用及关联 worktree 中的提交校验，通过 `test:tooling` 进入既有 CI 矩阵；本地执行不证明远程平台验收。产品不变量 I01–I12 不受影响。

管理操作需单独启用 Renovate、受支持的 dependency review／code scanning、私有安全报告、labels、受保护 environments 和 required checks。建议检查：CI Status、Dependency Review、Dependency Audit、Secret Scan、CodeQL、PR Title。本地文件不启用设置，也不证明功能可用。

## 验证归属

基建参照 docs-islands 直接集成到 workflow，不另维护一层基建脚本。根 test:tooling 在[发布边界](../../../scripts/release/publication.spec.ts)保留 bundle license 与历史标签守卫，以及双包 npm integrity／重试覆盖。已移除的 TypeScript 审计解析器与逐包 SBOM 测试随其生产接口退役。安全命令与报告行为归 workflow 所有；本地 shell 实验必须执行实际步骤，不另写一套解析器。报告与外部服务仍在 .limina 权威之外，因此产品不变量 I01–I12 不受影响。Build／tooling／unit／integration／smoke／typecheck／check／package／lint／format／docs 门禁仍适用；本地结果不证明 Actions 上的 Syft／Gitleaks 执行、远程平台验收、发布或部署。

[Release CLI 回归](../../../scripts/release/cli.spec.ts)覆盖正式版与预发布计划在没有启用变量时进入正常预检，并保留本地 provenance 要求。Workflow 配置回归保留手动 dispatch、仓库范围和 Release environment。这些属于外部发布契约，产品不变量 I01–I12 不变。

[Tag CLI 回归](../../../scripts/release/check-tag-cli.spec.ts)在缺少迁移 metadata 时使用真实 Git 标签，覆盖完整公开源码发布组、checkout 身份与 main 祖先关系。[发布 workflow 回归](../../../scripts/release/workflow.spec.ts)在受控 GitHub CLI 响应下执行实际 Bash 步骤，检查共享 changelog 存在于链接提交；Windows 跳过该 Bash 路径，因为此 Ubuntu 发布任务不在 Windows 上运行。[Changelog 覆盖](../../../scripts/release/shared.spec.ts)保护非空内容渲染及历史链接保留。

发布回归还用成功、错误 SHA／branch／event、provenance 事件 SHA 不符、pending、失败／取消／skipped、缺失及查询失败响应执行实际精确 SHA Bash 门禁；获准 CLI 在包操作前拒绝不支持可信 dist-tag 的 npm 版本。本地 HTTP registry 覆盖部分上传／渠道推进后的恢复、tarball 证据保留、上传已被接受但客户端收到失败响应、收到成功响应但渠道缺失、不可变内容不一致，以及 beta 推进时保持 `latest`。这个夹具证明编排行为，不证明 npm 账户授权或真实 registry 发布。

`c33aea9497aca78fde77b02fb738348623ca0439` 的 Windows CI 完成了两个产品的单测，随后组合发布恢复用例在 60 秒后超时。现在每种 registry 故障分别使用新的夹具和独立用例，保持相同的每例 60 秒预算及既有单条命令 45 秒时限。全部失败／恢复断言保留；不跳过 Windows 路径，也不增加 timeout。
