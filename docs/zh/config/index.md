# 配置参考

刚开始使用时，一份空配置就能运行默认检查。遇到具体需要时，再增加相应字段，不必先理解所有选项。默认检查会分析项目关系、源码导入和检查覆盖，并运行适用的检查器。包产物与发布检查需要另行运行。

`limina.config.mjs`：

```js
import { defineConfig } from 'limina';

export default defineConfig({});
```

## 先区分：包、文件、检查器

假设配置位于工作区根目录，仓库有 `packages/core` 和 `apps/web` 两个包，Web 项目包含 `apps/web/src/App.vue`：

```text
limina.config.mjs
packages/core/tsconfig.json
packages/core/src/index.ts
apps/web/tsconfig.json
apps/web/src/App.vue
```

下面几个字段处理不同的问题，可以分别调整：

| 我想决定什么                                            | 配置                                   | 对这个例子的影响                                                               |
| ------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| 哪些包及包内区域参与                                    | [`scope.regions`](./regions.md)        | 按工作区声明发现并激活包，也可以填写理由，排除指定区域。                       |
| 哪些文件需要纳入源码与覆盖检查                          | [`scope.source`](./source-boundary.md) | 默认匹配 TypeScript 文件。要纳入 `App.vue`，可在 `include` 中添加 `**/*.vue`。 |
| 从哪些 `tsconfig.json` 入口查找源码配置、使用哪个检查器 | [`scope.checkers`](./checkers.md)      | 默认自动发现。需要固定归属时，可为 Web 入口指定 `vue-tsc`。                    |
| 如何检查源码导入等规则                                  | [`source`](./source-checks.md)         | 配置导入授权或可选的未使用代码分析，不负责选择上面的文件集合。                 |

它们不是互相替代的开关。`scope.source` 的模式只过滤已激活区域中的文件，不能把未激活的包拉进来。选择 `vue-tsc` 也不会自动把 `.vue` 加入 `scope.source`。如果 `tsconfig` 已包含组件，而源码范围没有包含，覆盖检查可能报告范围不一致。相反，加入 `.vue` 后，仍需对应检查器及其源码配置覆盖这些文件。排除自动发现的入口也不会切断其他已选入口的项目引用。

例如，以下配置保留默认 TypeScript 范围，额外要求 Vue 文件获得检查覆盖。它不改变项目 `tsconfig` 本身的文件列表：

`limina.config.mjs`：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  scope: {
    source: {
      include: ['...', '**/*.vue'],
    },
  },
});
```

先按项目需要准备框架检查器，再运行 `pnpm exec limina check`，根据报告调整文件归属。完整步骤见[快速开始](../getting-started.md#使用-vue-astro-或-svelte)。

## 按配置目的阅读

| 你要决定什么                                   | 配置入口                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| 使用哪份配置、以哪个包为根、按环境返回什么配置 | [配置文件](./config-file.md)：`defineConfig`、加载器、`mode`、`command` |
| 是否持久化分析、哪些额外文件影响缓存有效性     | [分析缓存](./config-file.md#cache)：`cache` 与 `cache.dependencies`     |
| 哪些包与嵌套包作用域纳入本次运行               | [治理区域](./regions.md)：`scope.regions`                               |
| 哪些源码必须获得检查覆盖                       | [源码边界](./source-boundary.md)：`scope.source`                        |
| 每份源码配置由哪个检查器负责                   | [检查器配置](./checkers.md)：`scope.checkers`                           |
| 源码导入由谁授权，如何检查未使用代码           | [源码检查](./source-checks.md)：`source`                                |
| 哪些项目引用、包或内置模块依赖不允许出现       | [图规则](./graph-rules.md)：`graph.rules` 与源码配置中的标签            |
| 哪些具体文件暂时不要求普通检查覆盖             | [覆盖证明允许清单](./proof-allowlist.md)：`proof.allowlist`             |
| 哪些已构建输出需要检查                         | [包检查](./package-checks.md)：`package.entries`                        |
| 如何检查打包文件与工作区发布依赖               | [发布检查](./release-checks.md)：`release`                              |
| 如何组合任务、控制执行资源                     | [流水线](./pipelines.md)与[执行并发](./execution.md)                    |

## 建议的配置顺序

先选择配置所在的项目根并运行默认检查，再按报告核对包范围、需要检查的源码和检查器。需要约束依赖方向时添加图规则。需要发布包时，再配置输出条目和产物检查。省略顶层 `graph`、`source`、`proof` 不会关闭默认对应任务。

源码 `tsconfig` 中的 `liminaOptions` 则用于标签、静态分析不可见的声明关系和用户产物输出。需要拆分多份 TypeScript 配置时，可先阅读[核心概念](../concepts.md)。
