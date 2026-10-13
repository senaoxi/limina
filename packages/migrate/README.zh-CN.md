# limina-migrate

将既有 TypeScript 配置迁移为 Limina 可以消费的输入。

```sh
pnpm exec limina-migrate
# 或运行与所用 Limina 相同的版本：
pnpm dlx limina-migrate@<version>
```

不再要求预先存在 Limina 配置。发现顺序为显式 `--config`、从 cwd 完整向上查找的默认命名配置、仅在没有任何配置时采用最近的 `package.json`。选中配置由其最近 manifest 绑定治理根；子包较近的 manifest 不截断配置发现。显式路径无效或最近 manifest 无效时停止。

Flow 在用户配置求值前展示 cwd、治理根、manifest、根类型及配置来源。范围确认默认 Yes。非 TTY 必须传 `--yes`；它只接受范围，不批准 dirty-worktree 或 hardlink 写入。确认期间输入发生漂移时停止。

```sh
pnpm exec limina-migrate --dry-run --yes
pnpm exec limina-migrate --yes
```

两种模式都展示从冻结补丁派生的完整文件操作清单，包括 schema、references、implicitRefs、outputs 与精确 exclusions。正常执行只写获准的计划子集。默认上下文保留在内存中；只有隔离要求持久化 `scope.regions.exclude` 时，计划才在根 manifest 旁创建最小静态 `limina.config.mjs`。不会生成空配置、执行 init 或修改依赖／脚本。

`--dry-run` 输出 Preview，不执行迁移器控制的 create/update、事务文件、graph/cache 发布、审计发布（包括失败报告）或迁移后验证。预览不要求 Git 工作树或写入授权。完整且含受治理源码的计划返回零；不完整或失败计划返回非零。用户配置模块和现有第三方入口仍可执行代码：预览不是 JavaScript 副作用沙箱。之后的每次调用都会独立重新规划。

命令也支持 `--config`、`--config-loader native|tsx` 和 `--mode`；配置函数仍收到 `command: 'migration'`。

此 CLI 内联同次发行所需的核心实现，没有 `limina` runtime 依赖。默认上下文和中立配置只需工具及 required TypeScript peer 即可迁移；配置导入公开 `limina` 时，项目仍须安装主包。启用的可选 loader/checker 需要受支持的 peers。它保留既有迁移交互、事务恢复和新进程输入校验。Applied 成功表示内嵌的正常 check/graph 输入 reader 消费了磁盘配置，不表示执行了项目安装版 Limina runtime 或完整检查。CLI 分别报告项目版本观察；工具 build/self 版本不一致会在写入前失败。持久 schema 路径仍在 `node_modules/limina/schemas`，editor 解析需要主包。defaults 未创建配置时，新 worker 通过默认输入 factory 重新读取 manifest/workspace/tsconfig；创建配置后则加载真实文件。这是默认上下文下的输入验证，不表示普通 `limina check` 可以无配置启动。迁移成功不能代替 `limina check`，命令不会安装项目或框架依赖。

`limina migration` 保留为弃用转调命令，优先使用本地同版本迁移包，否则通过 npm 下载该精确版本。离线使用旧命令时，请先在本地安装 `limina-migrate`。

本包提供 CLI，不提供公开的 JavaScript 迁移 API。行为与限制见[迁移契约](../../docs/zh/cli.md#limina-migration)。
