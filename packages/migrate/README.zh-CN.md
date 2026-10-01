# limina-migrate

将既有 TypeScript 配置迁移为 Limina 可以消费的输入。

```sh
pnpm exec limina-migrate
# 或运行与所用 Limina 相同的版本：
pnpm dlx limina-migrate@<version>
```

使用一份 Limina 配置：可用 `pnpm exec limina init` 初始化常规配置，也可提供 `export default {}` 这样的中立配置。命令支持 `--config`、`--config-loader native|tsx` 和 `--mode`；配置函数仍收到 `command: 'migration'`。

此 CLI 内联同次发行所需的核心实现，没有 `limina` runtime 依赖。中立配置只需工具及 required TypeScript peer 即可迁移；配置导入公开 `limina` 时，项目仍须安装主包。启用的可选 loader/checker 需要受支持的 peers。它保留既有迁移交互、事务恢复和新进程输入校验。成功表示内嵌的正常 check/graph 输入 reader 消费了磁盘配置，不表示执行了项目安装版 Limina runtime 或完整检查。CLI 分别报告项目版本观察；工具 build/self 版本不一致会在写入前失败。持久 schema 路径仍在 `node_modules/limina/schemas`，editor 解析需要主包。迁移成功不能代替 `limina check`，命令不会安装项目或框架依赖。

`limina migration` 保留为弃用转调命令，优先使用本地同版本迁移包，否则通过 npm 下载该精确版本。离线使用旧命令时，请先在本地安装 `limina-migrate`。

本包提供 CLI，不提供公开的 JavaScript 迁移 API。行为与限制见[迁移契约](../../docs/zh/cli.md#limina-migration)。
