# 独立仓库迁移

[English](../migration.md) | [简体中文](./migration.md)

本地路径使用脱敏别名：`$LIMINA_REPO` 表示 Limina checkout，`$SOURCE_REPO` 表示源 checkout，`$EVIDENCE_ROOT` 表示本地复现根目录。这不表示私有证据已随本仓库分发。

适配后的基建工作流已在本地实现，启用仍受下述发布／部署门禁约束。[基建记录](./infrastructure.md)负责直接 workflow 集成、配置与报告语义及其限制。

状态：monorepo 布局的本地迁移已完成。剩余产品与构建工具的三个 Logaria 消费者均通过 dev catalog 使用 registry 0.0.4。冷自举、完整本地检查、外部打包消费者、特殊路径／cwd 测试在 macOS arm64 / Node 24.21.0 / pnpm 11.9.0 上通过，独立的五组 Vue 版本矩阵也已在本机通过。完全独立迁移及远程平台验收仍未完成。继承记录中的历史结果不属于本次迁移验收。

初始提取固定在 docs-islands 提交 `c09e12c1ef12f89e927cce4c41e714ee0539ada6`。目标为 `$LIMINA_REPO`，分支为 `codex/limina-migration`。保留目标既有 `.git` 及 `git@github.com:senaoxi/limina.git` origin。初始提取仅从固定的干净基线取文件，并保留源仓库的无关工作。

迁移还包含源提交 `a6f79bcb4528098f7bbf8c9f309216f176ffa826`（`feat(limina): preserve input topology during migration`）。完整改动已迁入当前包布局，包括新增验证进程、测试、双语产品文档和 PCR。归档的来源映射覆盖全部 91 个文件，同步报告将该证据与初始提取结果分开记录。这些文件仍可从[历史证据](#历史证据)获取。原历史基线和 Logaria 边界保持不变。

历史在专用 fresh clone 中使用 git-filter-repo 2.47.0（`a40bce548d2c`）过滤，先保留产品原路径，再机械移到根目录。最终采用私有根目录与嵌套产品的 monorepo 布局，后续移动将产品放回 `packages/limina`，不重写导入的历史。仅导入基线可达的 `limina/v*` 标签。重写会改变提交／标签身份并移除签名，旧签名不能认证新对象。归档的提交／标签映射和共享资产来源在 Git 历史中保留归属，不再是发布时的输入。共享资产按快照导入，不声称重建了其独立历史。

根工具、产品和 build-tools 通过 dev catalog 和获准的 release-age 例外消费 registry Logaria 0.0.4。包生成器使用已安装的包，不读取兄弟仓库的 Logaria 清单。归档的 Logaria 替换报告记录 2026-09-30 的基线、独立对抗测试及限制；它是历史证据，不是当前 checkout 的结果。

复现和命令日志位于 `$EVIDENCE_ROOT/limina-monorepo-migration/`。三轮对抗测试覆盖冷自举与缺失 Logaria 反例、外部打包消费者、路径／cwd／平台行为。未实际运行的平台和 Node 版本必须保持未验证状态。归档的初始验收报告记录这些结果，不属于当前验收结果。

npm 发布仍受产物、CI 和 publisher 检查约束，不再要求迁移启用开关；[基建记录](./infrastructure.md#外部门禁与协作)负责当前发布契约。[基建记录](./infrastructure.md#外部门禁与协作)记载的公开文档入口不代表仓库中独立受门禁控制的部署工作流已启用。发布前需通过干净的独立安装及完整远程 CI 矩阵，选择未发布版本，核对 npm trusted publisher、workflow 与 `Release` environment，并在启用新发布前冻结旧发布权威。导入历史标签不得自动发布。发布脚本只面向获准的 `packages/limina/dist` 与 `packages/migrate/dist` 配对产物，要求包名、版本及共享的 `limina/v<version>` tag 一致。迁移包发布清单的 runtime、peer、optional 和 development 字段均不能依赖 Limina，也不能包含私有 workspace 或未解析的本地协议。非公开 `migration-build.json` 必须匹配两产品的 source/dist 版本与发布版本，CLI、新进程 verifier 及 renderer 资源必须存在。即使没有 runtime 依赖边，发布顺序仍显式保持核心先、migrate 后。全部仅供 workspace 使用的 internal 源码模块映射都会从核心发布 exports 移除。这是包表面的 breaking 改动：发布前须为两产品选择未发布的 breaking 版本；本地实现不提高源码版本，也不授权发布。发布先使用候选 npm tag 上传，核对两个产物的完整性后才更新渠道。成功上传后，新版本的 E404 回读会按五秒间隔重试，使用五分钟的单调时钟期限；每个 npm 请求仍受其自身 CLI 超时控制。其他读取错误或已读到的完整性不匹配立即失败。期限内仍不可见的版本不会触发渠道提升。非 latest 渠道发布要求既有 `latest` 保持不变。此前不存在的包命名空间在预检时没有标签；npm 要求其首个版本初始化 `latest`，因此只有该情况接受 `latest` 等于刚发布的版本。其他 latest 变化仍会拒绝，latest 不匹配与目标渠道不匹配分别报告。重试只接受完整性相符的既有版本，不覆盖已发布版本。既有 changelog 保留原链接。新条目链接到当前 Limina 仓库提交，包含重写后的导入提交，不读取已移除的 commit map。不可变的导入标签名称由发布模块 `scripts/release/check-tag.ts` 保留，因此移除迁移报告不会放开历史标签的发布或部署。

当前公开入口、固定 base、Vercel gateway 及部署配置由[基建记录](./infrastructure.md#外部门禁与协作)负责。项目关联和部署权限仍受各自独立门禁约束。旧消费者迁移仍是独立受门禁控制的行动：将旧消费者迁到获准的 registry 版本，遵守 release-age／trust，移除旧源码及 Nx／发布归属，验收旧仓库，再对其余旧双语文档路由配置跳转，覆盖资源、查询参数和锚点。

发布前回滚是停止切换并保留旧仓库。发布后分别回滚消费者版本、文档入口和工作流；不覆盖已发布版本、不 unpublish、不强推历史。

## 历史证据

迁移报告与来源映射于 2026-10-02 从当前文件树移除，完整的删除前快照仍保存在 Git 提交 `b1f11505487361bf8f925c3ccef2d384f80cda4c` 中。可运行 `git show b1f11505487361bf8f925c3ccef2d384f80cda4c:migration/VALIDATION.md` 获取报告，将文件名替换为 `ESLINT-10.md`、`LOGARIA-0.0.4.md`、`SYNC-a6f79bcb.md`、`upstream-a6f79bcb.json`、`commit-map`、`tag-map.json` 或 `imports.json` 可获取对应归档。历史报告保留原环境、日期及覆盖限制；发布命令和当前 PCR 链接不能依赖这些文件存在于工作树。
