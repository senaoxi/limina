# 配置参考

Limina 的配置入口是工作区内部的 `limina.config.mjs`。具体字段按主题拆开阅读：

- [配置文件](./config-file.md)：`defineConfig`、函数配置、`mode`、`command` 和 `strict`。
- [检查器入口](./checkers.md)：`config.checkers.<name>`、`preset`、`entry` 和固定扩展名。
- [源码边界](./source-boundary.md)：`config.source.include` / `exclude`——覆盖证明使用的受治理文件边界。
- [源码检查](./source-checks.md)：顶层 `source.unusedDependencies` / `additionalEntries` / `unusedModules`——由 Knip 驱动的依赖和模块检查。
- [图规则](./graph-rules.md)：`graph.rules.<label>`、`deny.refs`、`deny.deps` 和 `allow.refs`。
- [覆盖证明允许清单](./proof-allowlist.md)：源码覆盖例外（`file`、`reason`）。
- [包检查](./package-checks.md)：构建产物条目、`publint` / `attw` / `boundary`。
- [发布检查](./release-checks.md)：`release.contentHash`、tarball 和发布卫生。
- [流水线](./pipelines.md)：由内置任务和外部命令组成的命名工作流。

如果只是想跑第一次检查，先从[配置文件](./config-file.md)和[检查器入口](./checkers.md)开始；如果已经准备发布包，再补[包检查](./package-checks.md)。
