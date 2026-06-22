# CLI 参考

本页列出 Limina 的每条命令及其参数。命令对应文档其他位置介绍的内置任务和配置项；这里是命令入口，不是行为说明。

```sh
limina [--config limina.config.mjs] [--mode mode] <command>
```

::: tip
每条任务具体检测什么、配什么例子，见 [内置任务](./built-in-tasks.md)。每条命令从 `limina.config.mjs` 读取哪些字段，见 [配置参考](./config/index.md)。
:::

## 初始化与默认检查

| 命令                      | 说明                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `limina init [--yes]`     | 生成 `limina.config.mjs`、确保忽略 `.limina/`，并为 pnpm 工作区添加 `limina:build` 脚本。 |
| `limina check`            | 运行默认检查：调度图、源码、覆盖证明、检查器构建和检查器类型检查。                        |
| `limina check --issues`   | 输出上一次已记录检查问题中可用的筛选值。                                                  |
| `limina check <pipeline>` | 运行 `pipelines` 中的有序命名流水线。                                                     |

`limina check --issues` 会读取上一次记录下来的检查结果，并按 task、package、rule、scope、checker
列出可用筛选值。可以组合 `--task <name>`、`--package <name>`、`--rule <code>`、
`--file <path>`、`--scope <path>` 或 `--checker <name>`，先缩小清单，再选择更聚焦的重跑方式。

检查任务失败时，默认先输出摘要，再按 rule code 和 owner 分组展示详情。同一组只展示一次 reason
和 fix，并使用稳定 code，例如 `LIMINA_GRAPH_REFERENCE_MISSING` 或 `LIMINA_PACKAGE_PUBLINT`；
这些 code 也可以直接配合 `limina check --issues --rule <code>` 使用。默认输出每组只展示前几条
file 或 target；如果需要完整列表，可以给 `limina check` 或单独的检查命令加 `--verbose`。

## 图与源码

| 命令                   | 说明                                                                           |
| ---------------------- | ------------------------------------------------------------------------------ |
| `limina graph prepare` | 生成 `.limina/manifest.json` 和检查器作用域内的声明 / 构建 tsconfig 图。       |
| `limina graph check`   | 先 prepare，再校验生成的项目引用、工作区导入、图规则和源码 / 产物依赖语义。    |
| `limina graph export`  | 导出中立的包依赖图 JSON；支持 `--view source\|artifact\|all` 和 `--output`。   |
| `limina source check`  | 校验 source ownership、package-scope 相对导入边界、裸包依赖声明和 `#imports`。 |
| `limina proof check`   | 校验声明配置、本地配套配置、检查器覆盖、纯聚合器和源码覆盖。                   |

`limina graph check`、`limina source check` 和 `limina proof check` 都支持 `--verbose`，
用于展开完整的分组问题详情。

## 检查器

| 命令                                         | 说明                                                     |
| -------------------------------------------- | -------------------------------------------------------- |
| `limina checker build`                       | 运行支持构建模式的检查器入口。                           |
| `limina checker build <config>`              | 为一个源码或 raw tsconfig 运行 checker build。           |
| `limina checker build <config> --preset <p>` | 选择构建预设：`tsc`、`vue-tsc` 或 `tsgo`。               |
| `limina checker build <config> --watch`      | 监听输入文件，并重建选中的一个 config。                  |
| `limina checker typecheck`                   | 运行 `vue-tsgo`、`svelte-check` 这类只做类型检查的入口。 |

`limina checker build` 和 `limina checker typecheck` 在报告 checker 失败时支持 `--verbose`。

## 包与发布

| 命令                                            | 说明                                                 |
| ----------------------------------------------- | ---------------------------------------------------- |
| `limina package check`                          | 运行配置好的包输出检查。                             |
| `limina package check --package <name>`         | 按配置名运行单个包条目。                             |
| `limina package check --tool <tool>`            | 只运行 `publint`、`attw`、`boundary` 或 `all`。      |
| `limina package check --attw-profile <profile>` | 覆盖 ATTW 配置档：`strict`、`node16` 或 `esm-only`。 |
| `limina release check`                          | 按当前目录的包条目校验发布卫生和发布依赖一致性。     |
| `limina release check --package <name>`         | 校验一个或多个包条目的发布卫生和发布依赖一致性。     |

`limina package check` 和 `limina release check` 支持 `--verbose`，用于展开完整的分组问题详情。
