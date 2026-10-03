# 仓库基建

[English](../infrastructure.md) | [简体中文](./infrastructure.md)

本记录负责独立仓库依赖自动化、协作、安全、CI 报告及外部工作流集成。源码建立行为事实；本地结果不证明远程启用或平台验收。

## 依赖与安全

[Renovate](../../../.github/renovate.json)提出需审查的 catalog／lockfile 更新，不 automerge。排除 peer／engine 契约和独立 fixtures。Checker 家族、package-manager 变化及 major 更新需 dashboard approval；Vite 5 保持既有版本线。不引入第二套更新 bot 或旧 postinstall 自举。

私有 [pnpm ESLint 适配器](../../../packages/eslint-config/src/plugins/pnpm-plugin/index.ts)识别限定父包／版本的 overrides 中的 catalog 引用。上游 eslint-plugin-pnpm 1.9.1 错误地将整个 selector 当作包名；适配器只消除这类 unused-item 误报，保留真正未使用的条目报告。根 duplicate-catalog 规则在既有 Vite 允许项之外增加 `path-to-regexp`，因为部署依赖图需要 major 6 和 8 两套 API。这是具名 lint 允许项，不是 audit、trust 或依赖准入例外。ESLint 归属边界的回归测试使用真实临时 workspaces，包含 scoped、限定版本的 selector，并同时展示上游失败及适配后的结果。

[依赖审查](../../../.github/workflows/dependency-review.yml)以 high 为门禁，覆盖 runtime／development／unknown scope。允许列表在[配置](../../../.github/dependency-review-config.yml)中维护，与 [bundled-license 策略](../../../packages/build-tools/src/license-policy.ts)配套；没有单独的配置同步脚本。Action 不穷尽拒绝未知 license metadata；构建插件另行拒绝缺失／冲突／禁止的 bundle 证据。未打包依赖仍需准入审查。

[安全 CI](../../../.github/workflows/security.yml)沿用 docs-islands 的 workflow 组织方式，在 PR／main／每周／手动事件集成依赖审计、许可证报告、目录级 SBOM 和可达历史 secret scan。Bash／jq 步骤直接解析 pnpm advisory JSON，进程／registry／schema 异常时失败；high／critical 按既有排除之后返回的 advisory 明细判断。报告作为 workflow artifacts 保留，Security Summary 拒绝失败／取消／skipped 状态。Gitleaks CLI 8.30.1 保留官方 Linux archive 校验值与脱敏报告。不增加自动 issue／PR 消息或 audit／trust 排除。

安全维护使用[workspace 配置](../../../pnpm-workspace.yaml)中的 `security-patches` catalog。保留 undici 和 minimatch 10 brace-expansion overrides 的既有范围，新增 fast-uri 和 moment overrides 分别限定于 Ajv 8 和 rollup-plugin-license。2026-09-30 的本地全类别审计在未变更的 18 项 GHSA 排除下未返回 advisory 明细。Release-age、trust 和 peer 策略继续生效；未新增 audit、trust、release-age 或 deprecation 例外。

2026-10-01，registry 审计针对 Astro 宿主依赖返回了六项 devalue advisory。`astro@^7.0.0>devalue` override 从该 catalog 选择 [5.9.3 安全补丁](https://github.com/sveltejs/devalue/releases/tag/v5.9.3)，满足两个已安装 Astro 版本声明的 `^5.8.1` 范围。Astro 7.0.0、7.3.2 和独立兼容性夹具工作区保留各自版本与边界。所选补丁使用 MIT 许可证，未被 deprecated，发布于 2026-09-18。冻结安装和本地全类别审计通过，在相同 18 个排除项下返回零项 advisory；未增加策略例外。

[CodeQL](../../../.github/workflows/codeql.yml)显式加载[范围](../../../.github/codeql-config.yml)，无需产品构建即可分析 JavaScript／TypeScript，覆盖两个产品／私有工具／脚本，排除生成产物／fixtures／测试。静态扫描不代表穷尽运行时／文件系统证明。

## CI 与制品

共享 build action 调用根 `format:check` 与 `lint:check` 脚本执行只读 Prettier 和 ESLint 校验，两命令覆盖整个仓库；修改仍显式通过 `format:write` 与 `lint:fix` 执行，复用当前 `format` 和 `lint` 命令。

[CI](../../../.github/workflows/ci.yml)保留原生平台 build／test／smoke 和独立 Vue tuples。Linux quality 复用同提交／平台的 package artifacts，其他环境独立构建／检查。显式 build 后使用 test:smoke，不重复构建。不引入路径过滤、Nx cache 或缓存 .limina 状态。CI Status 依赖全部验证任务，失败／取消／skipped 都失败。

完整矩阵的 Unit Tests 步骤通过 `VITEST_MAX_WORKERS` 将 Vitest 限制为两个 worker，为 CLI 子进程和框架宿主留出资源。隔离 CLI 夹具实际复制运行时源码，排除 `__tests__` 目录；依赖链接、编译器 shim 和仓库边界仍由夹具自身持有。测试选择、安全断言和超时保持不变。

[License plugin](../../../packages/build-tools/src/license.ts)保留来自实际 bundler 输入的 bundled-dependencies.json，包含实际打包的开发依赖，拒绝缺失／冲突／禁止的 metadata。安全工作流为 `pnpm licenses list --prod --json` 显式选择 limina 和 limina-migrate；这份基于源码 manifest 的依赖报告不替代 bundle license 门禁。构建两个产品后，固定版本的 Anchore／Syft Action 扫描工作目录，在 .reports/sbom 生成 CycloneDX SBOM。扫描范围是目录，不是逐 tarball 依赖 inventory，也不保证消费者最终解析结果。原始审计数据与 Markdown 报告位于 .reports/security，许可证数据与报告位于 .reports/licenses。自制的包体积、SHA-512 和逐包 SBOM 报告已移除。

仓库报告与管理的 .limina namespace 分开。产品不变量 I01–I12 及 guards 不变，不将 I10／I11 推广到任意报告／外部服务。Audit／license／SBOM 报告失败会使 Security 工作流失败。发布和部署分别要求原生依赖审计通过；合并或发布前强制通过 Security 工作流依赖仓库管理设置。

## 外部门禁与协作

[发布](../../../.github/workflows/publish-npm.yml)保持手动，限制为 senaoxi/limina、LIMINA_RELEASE_ENABLED=1 和 Release。[Tag 检查](../../../scripts/release/check-tag-cli.ts)拒绝导入标签，要求两个公开源码包的名称／版本完整且一致、checkout 精确对应 tag 且位于 origin/main 历史中。既有双包 npm integrity／重试语义仍是权威。发布与部署使用原生 `pnpm audit --audit-level high` 在外部操作前执行审计。两个 npm 包完成核对与渠道更新后，发布工作流直接创建指向两包共享 changelog 的 GitHub release，链接使用 Git 解析的已 checkout 获准提交，而非 dispatch 事件 SHA。同一 tag 已存在的完整 release 可接受；draft 和查询错误时失败。SBOM 和许可证报告作为 workflow artifacts 保留，不再维护自制 tarball／报告附件流程。发布模块负责的导入标签名称守卫不依赖已删除的迁移 metadata；移动导入标签也不会使其名称可发布。

[文档部署](../../../.github/workflows/deploy-docs.yml)保持单独手动，由 LIMINA_DOCS_DEPLOY_ENABLED=1 和 Production 控制。要求新的获准 tag、HTTPS DOCS_ORIGIN 和独立 Vercel 凭据／project。工作流从既有私有 docs workspace 执行 Vercel CLI，同时将仓库根目录保留为项目 cwd。既有 CLI 版本由 dev catalog 和冻结 lockfile 负责，保留相同的部署安全 overrides；已移除的部署 workspace 继续保持删除。CLI 是 docs 开发依赖，不进入两个发布包。维护者于 2026-10-01 告知的规范公开文档入口为 `https://senao.me/repos/limina/`。文档站保留固定 `/repos/limina/` base，提供 origin 时在该 base 下生成 sitemap。Senao 站点负责通往独立 Limina Vercel 部署的外部 gateway。两个工作流保留[迁移前置条件](./migration.md)，本地集成不执行外部操作。

PR 标题通过仅处理 metadata 的 workflow 检查，不 checkout PR。模板收集包／命令／cwd／checker／复现／实际检查。提供英文贡献／安全政策及仅涉及项目的编辑器设置，不自动格式化 fixtures。

管理操作需单独启用 Renovate、受支持的 dependency review／code scanning、私有安全报告、labels、受保护 environments 和 required checks。建议检查：CI Status、Dependency Review、Dependency Audit、Secret Scan、CodeQL、PR Title。本地文件不启用设置，也不证明功能可用。

## 验证归属

2026-10-02，维护者要求直接按 docs-islands 集成，不再维护基建脚本。根 test:tooling 在[发布边界](../../../scripts/release/publication.spec.ts)保留 bundle license 与历史标签守卫，以及双包 npm integrity／重试覆盖。已移除的 TypeScript 审计解析器与逐包 SBOM 测试随其生产接口退役。安全命令与报告行为归 workflow 所有；本地 shell 实验必须执行实际步骤，不另写一套解析器。报告与外部服务仍在 .limina 权威之外，因此产品不变量 I01–I12 不受影响。Build／tooling／unit／integration／smoke／typecheck／check／package／lint／format／docs 门禁仍适用；本地结果不证明 Actions 上的 Syft／Gitleaks 执行、远程平台验收、发布或部署。

[Tag CLI 回归](../../../scripts/release/check-tag-cli.spec.ts)在缺少迁移 metadata 时使用真实 Git 标签，覆盖完整公开源码发布组、checkout 身份与 main 祖先关系。[发布 workflow 回归](../../../scripts/release/workflow.spec.ts)在受控 GitHub CLI 响应下执行实际 Bash 步骤，检查共享 changelog 存在于链接提交；Windows 跳过该 Bash 路径，因为此 Ubuntu 发布任务不在 Windows 上运行。[Changelog 覆盖](../../../scripts/release/shared.spec.ts)保护非空内容渲染及历史链接保留。
