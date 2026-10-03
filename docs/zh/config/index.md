# 配置参考

Limina 读取所选配置模块，通常是治理根 `package.json` 旁的 `limina.config.mts`。默认发现也支持 `.mjs`、`.ts` 和 `.js`，详见[配置文件](./config-file.md)。具体字段按主题阅读：

- [配置文件](./config-file.md)：`defineConfig`、函数配置、`mode` 和 `command`。
- [检查器配置](./checkers.md)：扁平的自动或具名作用域、语义判定依据与最终负责该配置的检查器、聚合约束、依赖证据与执行目标。
- [源码边界](./source-boundary.md)：`config.source.include` / `exclude`——覆盖证明使用的受治理文件边界。
- [治理区域](./regions.md)：工作区包治理、嵌套包作用域扩展和区域裁剪。
- [源码检查](./source-checks.md)：顶层 `source.knip`——依赖、模块和普通 `tsconfig` 归属检查。
- [图规则](./graph-rules.md)：`liminaOptions.graphRules`、`liminaOptions.implicitRefs`、`deny.refs`、`deny.deps` 和 `allow.refs`。
- [条件域](./condition-domains.md)：`graph.conditionDomains`——校验声明引用树使用的条件集合。
- [覆盖证明允许清单](./proof-allowlist.md)：源码覆盖例外（`file`、`reason`）。
- [包检查](./package-checks.md)：构建产物条目、`publint` / `attw` / `boundary`。
- [发布检查](./release-checks.md)：`release.npmPackageJsonLint`、`release.contentHash`、打包文件和发布文件检查。
- [流水线](./pipelines.md)：由内置任务和外部命令组成的命名工作流。
- [执行并发](./execution.md)：`execution.tasks`、检查器、包检查和发布检查的并发上限。

首次检查先创建[配置文件](./config-file.md)，再设置[检查器入口](./checkers.md)；发布包前配置[包检查](./package-checks.md)。
