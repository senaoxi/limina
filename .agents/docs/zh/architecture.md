# 仓库架构

[English](../architecture.md) | [简体中文](./architecture.md)

## Limina 边界

仓库安全／报告与外部工作流边界由[基建记录](./infrastructure.md)负责。Build plugin 的 bundled inventory 是发布资产，与 Limina 管理的 artifact namespace 分开。

私有根包 `@limina/monorepo` 编排命令与共享工具。在这个 monorepo 中，`packages/limina` 承载公开核心包 `limina`，其中 `src`、`bin`、`schemas`、`fixtures` 和 `integration` 保留内部组织。第二个公开包 `limina-migrate` 位于 `packages/migrate`。发布目标仅为两个包生成的 `dist` 目录。迁移包在运行时精确依赖同版本 `limina`，核心包不反向依赖迁移包。仅提供 CLI 的迁移包运行 publint 和运行时边界检查，安装后的 CLI 由 tarball smoke 测试覆盖；主包保留针对 TypeScript API 的 ATTW 检查。开发依赖可以被打包，其清单分类不等于运行时依赖声明。

其他私有 workspace 为 `docs`、`smoke`、`packages/build-tools` 和 `packages/eslint-config`。根级 `scripts` 负责发布工具。Fixture 仓库保留独立 workspace 清单和 lockfile，不纳入主 workspace。构建工具和 ESLint 规则通过 TypeScript 自举，不调用 Limina。随后 Rolldown 构建产品，再执行治理与消费者检查。工具链与依赖版本由 [technology-stack](./technology-stack.md) 记录。

根级发布脚本、产品和 build-tools 均通过 dev catalog（`^0.0.4`）消费 registry Logaria，锁定为 0.0.4，不再需要兄弟仓库的 Logaria 构建。包生成器通过 pnpm 解析 catalog，并拒绝不支持的本地协议；临时 Logaria link 例外已移除。

独立迁移包保留既有迁移事务和治理语义。旧 `limina migration` 命令优先转调本地同版本包，否则通过 npm 下载该精确版本。两个包共享版本、发布组和 `limina/v<version>` 标签。证据和独立性门见[迁移状态](./migration.md)，产品不变量见[Limina 架构](./limina.md)。

仅用于部署的 CLI 依赖由私有 `packages/deploy-tools` workspace 与 dev catalog 负责，不加入双包发布组；见[基建归属记录](./infrastructure.md)。
