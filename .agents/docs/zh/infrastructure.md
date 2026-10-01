# 仓库基建

[English](../infrastructure.md) | [简体中文](./infrastructure.md)

本记录负责独立仓库依赖自动化、协作、安全、CI 报告及外部工作流集成。源码建立行为事实；本地结果不证明远程启用或平台验收。

## 依赖与安全

[Renovate](../../../.github/renovate.json)提出需审查的 catalog／lockfile 更新，不 automerge。排除 peer／engine 契约和独立 fixtures。Checker 家族、package-manager 变化及 major 更新需 dashboard approval；Vite 5 保持既有版本线。不引入第二套更新 bot 或旧 postinstall 自举。

私有 [pnpm ESLint 适配器](../../../packages/eslint-config/src/plugins/pnpm-plugin/index.ts)识别限定父包／版本的 overrides 中的 catalog 引用。上游 eslint-plugin-pnpm 1.9.1 错误地将整个 selector 当作包名；适配器只消除这类 unused-item 误报，保留真正未使用的条目报告。根 duplicate-catalog 规则在既有 Vite 允许项之外增加 `path-to-regexp`，因为部署依赖图需要 major 6 和 8 两套 API。这是具名 lint 允许项，不是 audit、trust 或依赖准入例外。ESLint 归属边界的回归测试使用真实临时 workspaces，包含 scoped、限定版本的 selector，并同时展示上游失败及适配后的结果。

[依赖审查](../../../.github/workflows/dependency-review.yml)以 high 为门禁，覆盖 runtime／development／unknown scope。列表对应既有 [bundled-license 策略](../../../packages/build-tools/src/license-policy.ts)，由 [infrastructure:check](../../../scripts/infrastructure/check.ts)守卫，不导入旧许可证例外。Action 不穷尽拒绝未知 license metadata；bundle 门禁另行拒绝缺失／冲突／禁止的证据。未打包依赖仍需准入审查。

[安全 CI](../../../.github/workflows/security.yml)在 PR／main／每周／手动事件执行全类别审计及可达历史 secret scan。Gitleaks CLI 8.30.1 使用 MIT 许可证及官方 Linux archive 固定 SHA-256，避开旧的单独许可 action。不增加 fixture 全局或 VitePress-report 排除。报告脱敏，不自动发 issue／PR 消息。[审计解析](../../../scripts/infrastructure/audit.ts)接受 pnpm 11 advisory JSON，进程／registry／schema 异常失败。High／critical 按既有排除之后的明细判断，因为 metadata 可能仍统计排除项。既有 workspace GHSA／trust 例外保持可见，需单独审查；本次不增加例外。

安全维护使用[workspace 配置](../../../pnpm-workspace.yaml)中的 `security-patches` catalog。保留 undici 和 minimatch 10 brace-expansion overrides 的既有范围，新增 fast-uri 和 moment overrides 分别限定于 Ajv 8 和 rollup-plugin-license。2026-09-30 的本地全类别审计在未变更的 18 项 GHSA 排除下未返回 advisory 明细。Release-age、trust 和 peer 策略继续生效；未新增 audit、trust、release-age 或 deprecation 例外。

[CodeQL](../../../.github/workflows/codeql.yml)显式加载[范围](../../../.github/codeql-config.yml)，无需产品构建即可分析 JavaScript／TypeScript，覆盖两个产品／私有工具／脚本，排除生成产物／fixtures／测试。静态扫描不代表穷尽运行时／文件系统证明。

## CI 与制品

共享 build action 调用根 `format:check` 脚本执行只读 Prettier 校验，根 manifest 必须提供该脚本；格式写入仍通过显式 `format:write` 执行。

[CI](../../../.github/workflows/ci.yml)保留原生平台 build／test／smoke 和独立 Vue tuples。Linux quality 复用同提交／平台的 package artifacts，其他环境独立构建／检查。显式 build 后使用 test:smoke，不重复构建。不引入路径过滤、Nx cache 或缓存 .limina 状态。CI Status 依赖全部验证任务，失败／取消／skipped 都失败。

License plugin 从实际 bundler 输入生成 bundled-dependencies.json，包含实际打包的开发依赖，在保留既有许可证列表的同时拒绝缺失 metadata。artifacts:report 打包两个获准 dist 目录，要求迁移包精确依赖核心版本，检查包内 inventory，独立重算 SHA-512，记录实际 gzip／解包字节数。.reports/release 包含 tarball、许可证报告、CycloneDX 1.6 SBOM 及组 metadata。Components 描述 bundled code；外部 runtime／peer／optional ranges 单列为 properties。消费者最终版本与外部传递依赖不在范围内。

仓库报告与管理的 .limina namespace 分开。产品不变量 I01–I12 及 guards 不变，不将 I10／I11 推广到任意报告／外部服务。报告失败停止 CI／release 继续。

## 外部门禁与协作

[发布](../../../.github/workflows/publish-npm.yml)保持手动，限制为 senaoxi/limina、LIMINA_RELEASE_ENABLED=1 和 Release。[Tag 检查](../../../scripts/release/check-tag-cli.ts)拒绝导入标签，要求两个源码版本一致、checkout 精确对应 tag 且位于 origin/main 历史中。既有双包 npm integrity／重试语义仍是权威。[GitHub release 工具](../../../scripts/release/github-release.ts)比对两个 registry／tarball integrity，先创建 draft，仅上传当前指定资产，全部成功后公开。重试比较既有字节，不替换不同资产；失败保留 draft。

[文档部署](../../../.github/workflows/deploy-docs.yml)单独手动，由 LIMINA_DOCS_DEPLOY_ENABLED=1 和 Production 控制。要求新的获准 tag、HTTPS DOCS_ORIGIN 和独立 Vercel 凭据／project。私有 workspace `packages/deploy-tools` 通过 dev catalog 和冻结锁文件消费 Apache-2.0 Vercel CLI 56.3.1，仅用于部署。pnpm 11 去重会为宿主 Vitest／Astro context 增加可选 `@edge-runtime/vm`、`@vercel/blob` peers；其包版本及独立兼容性 fixture workspaces 保持不变，并重新执行完整宿主测试门禁。尝试升级至 61.0.0 时，pnpm 返回 `ERR_PNPM_TRUST_DOWNGRADE`；未添加例外。所选版本的 registry、源码 tag 与 archive 许可证证据一致。部署也在外部操作之前执行依赖审计。限定父包的 catalog overrides 在新增部署依赖图中更新 tar、两个 path-to-regexp API major、Ajv 与 once，消除新增审计条目，不增加排除项，也不修改既有全局 peer／trust 策略。所选 CLI 未被 deprecated；其上游 stream-to-promise 传递依赖仍被 deprecated，作为明确的维护限制记录，不添加 allowedDeprecatedVersions 例外。文档站在开发与生产环境都固定使用 `/repos/limina/` base；提供 origin 时，sitemap 也在该 base 下生成。Senao 站点负责将外部 `/repos/limina/*` gateway 映射到独立的 Limina Vercel 部署；Limina project 本身不重复维护这套路由契约。这里不额外推测 origin、旧 project 身份、redirect 或更广泛的切换权威。两个工作流保留[迁移前置条件](./migration.md)，本地集成不执行外部操作。

PR 标题通过仅处理 metadata 的 workflow 检查，不 checkout PR。模板收集包／命令／cwd／checker／复现／实际检查。提供英文贡献／安全政策及仅涉及项目的编辑器设置，不自动格式化 fixtures。

管理操作需单独启用 Renovate、受支持的 dependency review／code scanning、私有安全报告、labels、受保护 environments 和 required checks。建议检查：CI Status、Dependency Review、Dependency Audit、Secret Scan、CodeQL、PR Title。本地文件不启用设置，也不证明功能可用。

## 验证归属

根 test:tooling 负责异常审计证据、误导性计数、缺失／冲突 bundle licenses、SBOM 范围及历史标签。既有测试未负责这些新边界；受测 exports 均有生产消费者，不增加 test-only seam。根 YAML 是既有 catalog 依赖，用于真实配置验证。部署 CLI 位于私有 workspace；两项新增引用均不进入产品代码。适用正常 build／tooling／unit／integration／smoke／typecheck／check／package／lint／format／docs 门禁；security:audit 与既有漏洞分开。实际结果及复现限制见[集成验证](../../../migration/INFRASTRUCTURE.md)。
