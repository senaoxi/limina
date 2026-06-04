# 快速开始

## 环境要求

Limina 面向 pnpm 工作区，并要求配置文件使用 ESM。

- Node.js `^20.19.0 || >=22.12.0`
- 工作区根目录有 `pnpm-workspace.yaml`
- 接入仓库中安装了 TypeScript
- `limina.config.mjs` 位于工作区内部

## 安装

::: code-group

```sh [pnpm]
pnpm add -D limina typescript
```

:::

## 选择接入方式

如果你的工作区还没有清晰的 `tsconfig*.dts.json`、`tsconfig.build.json` 和项目引用，优先使用 `limina init`。它会从已有 `tsconfig*.json` 推导能安全生成的声明图，并在遇到含糊结构时停下来，让你手动确认。

如果你的仓库已经有稳定的声明构建图，直接写最小 `limina.config.mjs` 更快。此时 Limina 不会重新设计你的图，只会从你指定的检查器入口开始检查现有结构。这些配置的完整结构见[检查器入口](./config/checkers.md)和[配置文件](./config/config-file.md)。

## 初始化已有工作区

如果一个 pnpm 单体仓库还没有采用 Limina 的声明图结构，可以运行：

```sh
pnpm exec limina init
```

`limina init` 会向上查找最近的 `pnpm-workspace.yaml`，确认工作区根目录，扫描普通 `tsconfig*.json`，并写出它能安全推导的 Limina 文件。

非交互环境使用：

```sh
pnpm exec limina init --yes
```

初始化可能创建：

- 配对的 `tsconfig*.dts.json` 声明配置；
- `tsconfig.build.json` 聚合器；
- 根目录 `limina.config.mjs`；
- 根目录 `limina:check` 脚本；
- 缺失的根目录 `limina` dev dependency。

::: warning
遇到含糊输入时，init 会拒绝而不是猜测。例如已经存在 `tsconfig*.build.json` 或 `tsconfig*.dts.json`，或者 `tsconfig.json` 同时混合源码文件和项目引用。
:::

这类失败通常说明仓库已经有自己的 tsconfig 约定。先读报错中列出的文件，再决定是保留现状并手写配置，还是把该目录拆成聚合器、声明叶子和本地配套配置。

初始化后执行：

```sh
pnpm i
pnpm limina:check
```

::: tip
只有 init 修改依赖或创建根 `package.json` 时才需要先运行 `pnpm i`。
:::

## 最小手动配置

如果你已经有声明构建图，可以在工作区根目录创建 `limina.config.mjs`：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: 'tsconfig.build.json',
      },
    },
  },
});
```

添加根脚本：

```json
{
  "scripts": {
    "typecheck": "limina check"
  }
}
```

运行：

```sh
pnpm typecheck
```

默认检查流水线会依次运行：

1. `graph:check`
2. `source:check`
3. `nx:check`
4. `proof:check`
5. `checker:build`
6. `checker:typecheck`

第一次运行失败时，可以按类别判断下一步：

- `graph:check` 失败，多半是导入、项目引用、`workspace:*` 或标签规则没有对齐；
- `source:check` 失败，多半是文件归属、跨包相对导入、依赖声明或 `#imports` 有问题；
- `nx:check` 失败，多半是 `project.json` 缺失或过期；它的 `dependsOn` 构建边由 `link:` 制品依赖，以及实际导入到产物的 `workspace:*` 导出推导得出，所以全新工作区需要先运行 `limina nx sync`；
- `proof:check` 失败，多半是检查器入口、声明叶子、本地配套配置或允许清单没有覆盖到源码；
- `checker:build` 失败，说明 `tsc`、`tsgo` 或 `vue-tsc` 这类一等公民检查器在构建模式发现类型错误；
- `checker:typecheck` 失败，说明 `vue-tsgo`、`svelte-check` 这类二等公民类型检查执行器发现类型错误。

例如 `@acme/app` 新增了 `@acme/core` 导入，第一次跑 `pnpm typecheck` 报图问题时，优先看提示里的导入文件和期望引用。修完后再跑同一个命令，确认图、源码归属、覆盖证明和检查器执行一起通过。

## 添加框架检查器

Limina 也可以运行框架感知检查器。当工作区某部分需要它时，增加一个检查器入口：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: 'tsconfig.build.json',
      },
      vue: {
        preset: 'vue-tsc',
        entry: 'tsconfig.vue.build.json',
      },
    },
  },
});
```

内置预设包括 `tsc`、`tsgo`、`vue-tsc`、`vue-tsgo`、`svelte-check`。启用某个检查器时，请安装对应包；`tsgo` 和 `vue-tsgo` 需要 `@typescript/native-preview`，`vue-tsc` 入口还需要 `@vue/compiler-sfc`，这样 Limina 才能解析 SFC 导入。
