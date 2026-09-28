# 独立仓库迁移

[English](../migration.md) | [简体中文](./migration.md)

状态：在声明的 Logaria 依赖下，monorepo 布局的本地迁移已完成。冷自举、完整本地检查、外部打包消费者、特殊路径／cwd 测试在 macOS arm64 / Node 24.21.0 / pnpm 11.9.0 上通过，独立的五组 Vue 版本矩阵也已在本机通过。完全独立迁移及远程平台验收仍未完成。继承记录中的历史结果不属于本次迁移验收。

初始提取固定在 docs-islands 提交 `c09e12c1ef12f89e927cce4c41e714ee0539ada6`。目标为 `$LIMINA_REPO`，分支为 `codex/limina-migration`。保留目标既有 `.git` 及 `git@github.com:senaoxi/limina.git` origin。初始提取仅从固定的干净基线取文件，并保留源仓库的无关工作。

2026-09-28，维护者另外要求同步源提交 `a6f79bcb4528098f7bbf8c9f309216f176ffa826`（`feat(limina): preserve input topology during migration`）。完整改动已迁入当前包布局，包括新增验证进程、测试、双语产品文档和 PCR。[来源映射](../../../migration/upstream-a6f79bcb.json)记录全部 91 个文件；[同步验证](../../../migration/SYNC-a6f79bcb.md)将新证据与初始提取结果分开记录。原历史基线和 Logaria 边界保持不变。

历史在专用 fresh clone 中使用 git-filter-repo 2.47.0（`a40bce548d2c`）过滤，先保留产品原路径，再机械移到根目录。维护者随后指定私有根目录与嵌套产品的 monorepo 布局，后续移动将产品放回 `packages/limina`，不重写导入的历史。仅导入基线可达的 `limina/v*` 标签。重写会改变提交／标签身份并移除签名，旧签名不能认证新对象。[提交映射](../../../migration/commit-map)、[标签映射](../../../migration/tag-map.json)及[共享资产来源](../../../migration/imports.json)保留归属。共享资产按快照导入，不声称重建了其独立历史。

声明的临时 Logaria link 是唯一允许的旧仓库构建依赖。只消费现有 Logaria 产物，不修改、重建或发布。此门区分本地自举和完全独立。

复现和命令日志位于 `$EVIDENCE_ROOT/limina-monorepo-migration/`。三轮对抗测试覆盖冷自举与缺失 Logaria 反例、外部打包消费者、路径／cwd／平台行为。未实际运行的平台和 Node 版本必须保持未验证状态。实际结果见[验收记录](../../../migration/VALIDATION.md)。

发布与部署门保持关闭。发布前需批准独立 Logaria 来源，通过干净的独立安装及完整远程 CI 矩阵，选择未发布版本，核对 npm trusted publisher、workflow 与 `Release` environment，并在启用新发布前冻结旧发布权威。导入历史标签不得自动发布。发布脚本仅以 `packages/limina/dist` 为目标，并要求包名、版本、tag 一致。既有 changelog 保留原链接；新条目依据 commit map 区分两仓库历史。

Vercel 配置准备了 `/` base 与 `docs/.vitepress/dist` 输出；`DOCS_ORIGIN`、项目关联和部署权限尚未确定。批准并验收部署前保留当前公开文档 URL。之后将旧消费者迁到获准的 registry 版本，遵守 release-age／trust，移除旧源码及 Nx／发布归属，验收旧仓库，再对旧双语文档路由配置跳转，覆盖资源、查询参数和锚点。

发布前回滚是停止切换并保留旧仓库。发布后分别回滚消费者版本、文档入口和工作流；不覆盖已发布版本、不 unpublish、不强推历史。
