# 仓库架构

[English](../architecture.md) | [简体中文](./architecture.md)

## Limina 边界

私有根包 `@limina/monorepo` 编排命令与共享工具。在这个 monorepo 中，`packages/limina` 承载唯一公开包 `limina`，其中 `src`、`bin`、`schemas`、`fixtures` 和 `integration` 保留内部组织。仅发布生成的 `packages/limina/dist`。开发依赖可以被打包，其清单分类不等于运行时依赖声明。

其他私有 workspace 为 `docs`、`smoke`、`packages/build-tools` 和 `packages/eslint-config`。根级 `scripts` 负责发布工具。Fixture 仓库保留独立 workspace 清单和 lockfile，不纳入主 workspace。构建工具和 ESLint 规则通过 TypeScript 自举，不调用 Limina。随后 Rolldown 构建产品，再执行治理与消费者检查。本次迁移保留既有工具链和依赖版本。

Logaria 暂时来自明确授权的兄弟目录 `docs-islands/packages/logaria/dist`。根级发布脚本使用 `link:../docs-islands/packages/logaria/dist`；产品和 build-tools 使用 `link:../../../docs-islands/packages/logaria/dist`。仅消费现有产物，不重建。包生成器只将产品中这一精确的临时 Logaria link 规范化为被链接清单的版本；其他不支持的本地协议继续报错。

此布局不改变 Limina 的治理语义或 `migration` 命令。证据和独立性门见[迁移状态](./migration.md)，产品不变量见[Limina 架构](./limina.md)。
