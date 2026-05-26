# 参考

本页汇总 CLI、常见工作流和 FAQ。配置项已经拆成独立页面，第一次接触 Limina 时，建议先看 [快速开始](./getting-started.md)。

## 配置项

Limina 的配置入口是 workspace 内部的 `limina.config.mjs`。具体字段按主题拆开阅读：

- [配置文件](./options/config.md)：`defineConfig`、函数配置、`mode` 和 `command`。
- [Checker entries](./options/checkers.md)：`config.checkers.<name>`、内置 `preset`、固定 extensions 和 `entry`。
- [Source coverage](./options/source.md)：`config.source.include` 和 `config.source.exclude`。
- [Graph rules](./options/graph-rules.md)：`graph.rules.<label>`、`deny.refs` 和 `deny.deps`。
- [Paths](./options/paths.md)：compatibility paths 的生成配置。
- [Proof allowlist](./options/proof-allowlist.md)：源码覆盖例外的 `file` 和 `reason`。
- [Package checks](./options/package-checks.md)：构建产物检查目标、工具和 runtime boundary。
- [Pipelines](./options/pipelines.md)：命名工作流、内置 task 和外部 command step。

如果只是想跑第一次检查，先从 [配置文件](./options/config.md) 和 [Checker entries](./options/checkers.md) 开始；如果已经准备发布 package，再补 [Package checks](./options/package-checks.md)。

## CLI

```sh
limina [--config limina.config.mjs] [--mode mode] <command>
```

| Command                                         | 说明                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `limina init [--yes]`                           | 为未初始化的 pnpm workspace 生成 declaration leaves、build aggregators、根配置和 `limina:check` 脚本。 |
| `limina check`                                  | 运行默认 pipeline：graph、source、proof、checker build 和 checker typecheck。                          |
| `limina check <pipeline>`                       | 运行 `pipelines` 中的用户命名 pipeline。                                                               |
| `limina graph check`                            | 校验 project references、workspace imports、graph rules 和 source/artifact dependency 语义。           |
| `limina source check`                           | 校验 package 归属、相对 import 边界、bare dependency 声明和 `#imports`。                               |
| `limina proof check`                            | 校验 declaration leaves、local companions、checker coverage、纯 aggregators 和 source coverage。       |
| `limina paths generate`                         | 生成兼容 TypeScript `paths` config。                                                                   |
| `limina paths apply`                            | `paths generate` 的兼容别名。                                                                          |
| `limina paths check`                            | generated path configs 过期时失败。                                                                    |
| `limina checker build`                          | 运行支持 build mode 的 checker entries。                                                               |
| `limina checker typecheck`                      | 运行 `svelte-check` 这类 source-only checker entry。                                                   |
| `limina package check`                          | 运行配置好的 package output checks。                                                                   |
| `limina package check --package <name>`         | 按配置名运行单个 package entry。                                                                       |
| `limina package check --tool <tool>`            | 只运行 `publint`、`attw`、`boundary` 或 `all`。                                                        |
| `limina package check --attw-profile <profile>` | 覆盖 ATTW profile：`strict`、`node16` 或 `esm-only`。                                                  |
| `limina release check`                          | 按 cwd package entry 校验发布卫生和发布依赖一致性。                                                    |
| `limina release check --package <name>`         | 校验一个或多个 package entry 的发布卫生和发布依赖一致性。                                              |

## 推荐工作流

### 本地开发

```sh
pnpm exec limina checker build
pnpm exec limina checker typecheck
pnpm exec limina graph check
```

修改 TypeScript config 或 package boundary 时，可以先跑这两个。

### Pull Request

```sh
pnpm exec limina check
```

它会一起证明 graph、source ownership、coverage、一等公民 checker build 和 source-only checker execution。

### 发布前

```sh
pnpm build
pnpm exec limina package check
pnpm exec limina release check --package <name>
pnpm exec limina check publish
```

先 build，确保 `package.entries[].outDir` 中已经有消费者会安装到的文件。

## CI 示例

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec limina check
```

## 最佳实践

- 保持 `tsconfig.build.json` 为只包含 `files: []` 和 `references` 的纯 aggregator。
- Declaration leaf 应靠近 local companion，并只额外添加声明输出设置。
- 优先修 source-facing package exports，不要长期依赖 generated paths。
- Source checks、package checks 和 release checks 都要跑，它们保护的是不同层。
- Allowlist 保持少而清楚，并解释每个例外为什么安全。

## 常见问题

### `limina checker build` 和 `checker typecheck` 如何选择目标？

`checker build` 会从已配置 entry 运行一等公民 build preset（`tsc -b` 和 `vue-tsc -b`）。`checker typecheck` 会直接运行 source-only preset，目前是 `svelte-check --tsconfig <entry>`。

### 为什么 package checks 需要先 build？

它检查的是 `package.entries[].outDir` 下的 package output。这个 output 里必须已经有构建后的 `package.json`、exports、JavaScript 和 declarations。`release:check` 还会要求打包后的 output 包含 README/license，且不包含 source map。

### 为什么 workspace exports 指向 dist 会导致 graph 问题？

`workspace:*` 表示 source dependency，但 TypeScript 会按 package exports 解析 package import。如果 exports 指向 `dist`，graph 消费的就不再是源码。Limina 会要求你修 exports、调整依赖模型，或生成显式 compatibility paths。

### Vue 或 Svelte 文件应该放进 TypeScript graph 吗？

框架文件应该由对应框架 checker entry 覆盖。Limina 可以通过 `vue-tsc` 或 `svelte-check` 证明覆盖，不需要把这些文件假装成普通 `tsc -b` declaration leaf。

### `--mode` 适合哪些配置？

当 `limina.config.mjs` 导出函数，并且本地、CI 或发布流程需要返回不同配置时使用。

## 维护者发布检查清单

发布 Limina 自身或由 Limina 管理的 package 前，建议确认：

- 常规测试通过；
- `pnpm exec limina check` 通过；
- package build 已经运行；
- `pnpm exec limina package check --package <name>` 通过；
- `pnpm exec limina release check --package <name>` 通过；
- 使用 paths 时，`pnpm exec limina paths check` 确认 generated paths 未过期。
