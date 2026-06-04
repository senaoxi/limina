# CLI 参考

本页列出 Limina 的每条命令及其参数。命令对应文档其他位置介绍的内置任务和配置项；这里是命令入口，不是行为说明。

```sh
limina [--config limina.config.mjs] [--mode mode] <command>
```

::: tip
每条任务具体检测什么、配什么例子，见 [内置任务](./built-in-tasks.md)。每条命令从 `limina.config.mjs` 读取哪些字段，见 [配置参考](./config/index.md)。
:::

## 初始化与默认流水线

| 命令                      | 说明                                                                             |
| ------------------------- | -------------------------------------------------------------------------------- |
| `limina init [--yes]`     | 为未初始化的 pnpm 工作区生成声明叶子、构建聚合器、根配置和 `limina:check` 脚本。 |
| `limina check`            | 运行默认流水线：图、源码、Nx 项目同步、覆盖证明、检查器构建和检查器类型检查。    |
| `limina check <pipeline>` | 运行 `pipelines` 中的用户命名流水线。                                            |

## 图与源码

| 命令                       | 说明                                                         |
| -------------------------- | ------------------------------------------------------------ |
| `limina graph check`       | 校验项目引用、工作区导入、图规则和源码 / 产物依赖语义。      |
| `limina graph sync [path]` | 根据 TypeScript 解析到的源码导入重写声明叶子引用。           |
| `limina source check`      | 校验包归属、相对导入边界、裸包依赖声明和 `#imports`。        |
| `limina proof check`       | 校验声明叶子、本地配套配置、检查器覆盖、纯聚合器和源码覆盖。 |

## Nx 同步

| 命令                          | 说明                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `limina nx sync [target...]`  | 根据 `link:` 制品依赖和实际导入到产物的 `workspace:*` 导出同步 `project.json` 目标的 `dependsOn`。默认目标为 `build`。 |
| `limina nx check [target...]` | 检查 Nx 目标的 `dependsOn` 是否过期。默认目标为 `build`。                                                              |

## 检查器

| 命令                       | 说明                                                     |
| -------------------------- | -------------------------------------------------------- |
| `limina checker build`     | 运行支持构建模式的检查器入口。                           |
| `limina checker typecheck` | 运行 `vue-tsgo`、`svelte-check` 这类二等公民检查器入口。 |

## 包与发布

| 命令                                            | 说明                                                 |
| ----------------------------------------------- | ---------------------------------------------------- |
| `limina package check`                          | 运行配置好的包输出检查。                             |
| `limina package check --package <name>`         | 按配置名运行单个包条目。                             |
| `limina package check --tool <tool>`            | 只运行 `publint`、`attw`、`boundary` 或 `all`。      |
| `limina package check --attw-profile <profile>` | 覆盖 ATTW 配置档：`strict`、`node16` 或 `esm-only`。 |
| `limina release check`                          | 按当前目录的包条目校验发布卫生和发布依赖一致性。     |
| `limina release check --package <name>`         | 校验一个或多个包条目的发布卫生和发布依赖一致性。     |
