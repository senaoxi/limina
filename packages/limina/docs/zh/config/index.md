# 配置参考

Limina 的配置入口是工作区内部的 `limina.config.mts`。具体字段按主题拆开阅读：

- [配置文件](./config-file.md)：`defineConfig`、函数配置、`mode` 和 `command`。
- [检查器入口](./checkers.md)：`auto` 模式、`config.checkers.<name>`、`preset`、`include`、`exclude` 和固定扩展名。
- [检查器入口](./checkers.md#vue-import-解析)：`config.imports.vue`——`Vue SFC import` 解析模式。
- [源码边界](./source-boundary.md)：`config.source.include` / `exclude`——覆盖证明使用的受治理文件边界。
- [源码检查](./source-checks.md)：顶层 `source.knip`——依赖、模块和普通 `tsconfig` 归属检查。
- [图规则](./graph-rules.md)：`liminaOptions.graphRules`、`liminaOptions.implicitRefs`、`deny.refs`、`deny.deps` 和 `allow.refs`。
- [条件域](./condition-domains.md)：`graph.conditionDomains`——校验声明引用树使用的条件集合。
- [覆盖证明允许清单](./proof-allowlist.md)：源码覆盖例外（`file`、`reason`）。
- [包检查](./package-checks.md)：构建产物条目、`publint` / `attw` / `boundary`。
- [发布检查](./release-checks.md)：`release.contentHash`、`tarball` 和发布卫生。
- [流水线](./pipelines.md)：由内置任务和外部命令组成的命名工作流。
- [执行并发](./execution.md)：`execution.tasks`、检查器、包检查和发布检查的并发上限。

如果只是想跑第一次检查，先从[配置文件](./config-file.md)和[检查器入口](./checkers.md)开始；如果已经准备发布包，再补[包检查](./package-checks.md)。
