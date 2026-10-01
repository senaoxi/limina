# 独立仓库迁移

[English](../migration.md) | [简体中文](./migration.md)

本地路径使用脱敏别名：`$LIMINA_REPO` 表示 Limina checkout，`$SOURCE_REPO` 表示源 checkout，`$EVIDENCE_ROOT` 表示本地复现根目录。这不表示私有证据已随本仓库分发。

适配后的基建工作流已在本地实现，启用仍受下述发布／部署门禁约束。[基建记录](./infrastructure.md)负责配置与报告语义，[集成验证](../../../migration/INFRASTRUCTURE.md)记录本次改动的证据与限制。

状态：monorepo 布局的本地迁移已完成。2026-09-30，维护者要求将剩余产品与构建工具消费者切换到 registry Logaria 0.0.4；三个消费者现均使用 dev catalog。冷自举、完整本地检查、外部打包消费者、特殊路径／cwd 测试在 macOS arm64 / Node 24.21.0 / pnpm 11.9.0 上通过，独立的五组 Vue 版本矩阵也已在本机通过。完全独立迁移及远程平台验收仍未完成。继承记录中的历史结果不属于本次迁移验收。

初始提取固定在 docs-islands 提交 `c09e12c1ef12f89e927cce4c41e714ee0539ada6`。目标为 `$LIMINA_REPO`，分支为 `codex/limina-migration`。保留目标既有 `.git` 及 `git@github.com:senaoxi/limina.git` origin。初始提取仅从固定的干净基线取文件，并保留源仓库的无关工作。

2026-09-28，维护者另外要求同步源提交 `a6f79bcb4528098f7bbf8c9f309216f176ffa826`（`feat(limina): preserve input topology during migration`）。完整改动已迁入当前包布局，包括新增验证进程、测试、双语产品文档和 PCR。[来源映射](../../../migration/upstream-a6f79bcb.json)记录全部 91 个文件；[同步验证](../../../migration/SYNC-a6f79bcb.md)将新证据与初始提取结果分开记录。原历史基线和 Logaria 边界保持不变。

历史在专用 fresh clone 中使用 git-filter-repo 2.47.0（`a40bce548d2c`）过滤，先保留产品原路径，再机械移到根目录。维护者随后指定私有根目录与嵌套产品的 monorepo 布局，后续移动将产品放回 `packages/limina`，不重写导入的历史。仅导入基线可达的 `limina/v*` 标签。重写会改变提交／标签身份并移除签名，旧签名不能认证新对象。[提交映射](../../../migration/commit-map)、[标签映射](../../../migration/tag-map.json)及[共享资产来源](../../../migration/imports.json)保留归属。共享资产按快照导入，不声称重建了其独立历史。

初始迁移消费临时 Logaria link。根工具、产品和 build-tools 的这些 link 现已替换为 registry Logaria 0.0.4，复用既有 dev catalog 和获准的 release-age 例外。包生成器不再读取兄弟仓库的 Logaria 清单，CI 仍保留 link 拒绝守卫。当前基线、独立对抗测试及限制见 [Logaria 替换验证](../../../migration/LOGARIA-0.0.4.md)。

复现和命令日志位于 `$EVIDENCE_ROOT/limina-monorepo-migration/`。三轮对抗测试覆盖冷自举与缺失 Logaria 反例、外部打包消费者、路径／cwd／平台行为。未实际运行的平台和 Node 版本必须保持未验证状态。实际结果见[验收记录](../../../migration/VALIDATION.md)。

npm 发布仍受门禁约束。[基建记录](./infrastructure.md#外部门禁与协作)记载的公开文档入口不代表仓库中独立受门禁控制的部署工作流已启用。发布前需通过干净的独立安装及完整远程 CI 矩阵，选择未发布版本，核对 npm trusted publisher、workflow 与 `Release` environment，并在启用新发布前冻结旧发布权威。导入历史标签不得自动发布。发布脚本只面向获准的 `packages/limina/dist` 与 `packages/migrate/dist` 配对产物，要求包名、版本及共享的 `limina/v<version>` tag 一致。迁移包发布清单的 runtime、peer、optional 和 development 字段均不能依赖 Limina，也不能包含私有 workspace 或未解析的本地协议。非公开 `migration-build.json` 必须匹配两产品的 source/dist 版本与发布版本，CLI、新进程 verifier 及 renderer 资源必须存在。即使没有 runtime 依赖边，发布顺序仍显式保持核心先、migrate 后。源码桥会从核心发布 exports 移除。这是包表面的 breaking 改动：发布前须为两产品选择未发布的 breaking 版本；本地实现不提高源码版本，也不授权发布。发布先使用候选 npm tag 上传，核对两个产物的完整性后才更新渠道。重试只接受完整性相符的既有版本，不覆盖已发布版本。既有 changelog 保留原链接；新条目依据 commit map 区分两仓库历史。

当前公开入口、固定 base、Vercel gateway 及部署配置由[基建记录](./infrastructure.md#外部门禁与协作)负责。项目关联和部署权限仍受各自独立门禁约束。旧消费者迁移仍是独立受门禁控制的行动：将旧消费者迁到获准的 registry 版本，遵守 release-age／trust，移除旧源码及 Nx／发布归属，验收旧仓库，再对其余旧双语文档路由配置跳转，覆盖资源、查询参数和锚点。

发布前回滚是停止切换并保留旧仓库。发布后分别回滚消费者版本、文档入口和工作流；不覆盖已发布版本、不 unpublish、不强推历史。
