# limina-migrate

将既有 TypeScript 配置迁移为 Limina 可以消费的输入。

```sh
pnpm exec limina-migrate
# 或运行与所用 Limina 相同的版本：
pnpm dlx limina-migrate@<version>
```

先用 `pnpm exec limina init` 初始化 Limina 配置。命令支持 `--config`、`--config-loader native|tsx` 和 `--mode`；配置函数仍收到 `command: 'migration'`。

此 CLI 依赖完全相同版本的 `limina`，保留既有迁移交互、事务恢复和新进程输入校验。迁移成功不能代替 `limina check`，命令不会安装项目或框架依赖。

`limina migration` 保留为弃用转调命令，优先使用本地同版本迁移包，否则通过 npm 下载该精确版本。离线使用旧命令时，请先在本地安装 `limina-migrate`。

本包提供 CLI，不提供公开的 JavaScript 迁移 API。行为与限制见[迁移契约](../../docs/zh/cli.md#limina-migration)。
