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

如果你的工作区还没有 Limina 配置，优先使用 `limina init`。它会写入使用 auto 模式的 `limina.config.mjs`，添加根脚本，确保 `.limina/` 被忽略，并可以为当前项目安装可选的 Limina agent skill。

如果你的仓库已经有清晰的 tsconfig 约定，直接写最小 `limina.config.mjs` 更快。很多工作区只需要自动发现 checker；需要显式控制 checker 路由时，再看[检查器入口](./config/checkers.md)。

## 初始化已有工作区

如果一个 pnpm 单体仓库还没有采用 Limina 的声明图结构，可以运行：

```sh
pnpm exec limina init
```

`limina init` 会向上查找最近的 `pnpm-workspace.yaml`，确认工作区根目录，并写出 Limina 配置文件。

非交互环境使用：

```sh
pnpm exec limina init --yes
```

`--yes` 只接受核心 init 确认，并会跳过可选的 skill 安装。之后如果要手动安装 skill，可以运行：

```sh
npx --yes skills add senaoxi/docs-islands --skill limina
```

初始化可能创建或更新：

- 根目录 `limina.config.mjs`；
- 根目录 `.gitignore` 中的 `.limina/`；
- 根目录 `limina:build` 脚本；
- 缺失的根目录 `limina` 和 `typescript` dev dependencies。

::: warning
生成的检查器图会由 `limina graph prepare` 以及消费图的命令写入 `.limina/`。
:::

如果图准备失败，通常说明 `checker.include` 选中了保留或非源码 tsconfig。收窄 `include` 或补充 `exclude`，直到只选中普通源码配置。

初始化后执行：

```sh
pnpm i
pnpm limina:build
```

::: tip
只有 init 修改依赖或创建根 `package.json` 时才需要先运行 `pnpm i`。
:::

## 最小手动配置

在工作区根目录创建 `limina.config.mjs`：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      mode: 'auto',
    },
  },
});
```

这里把 `mode: 'auto'` 明确写出来，是为了让配置一眼能看出 Limina 会做什么：自动寻找源码用的 `tsconfig.json`，再按文件内容交给 `tsc` 或 `vue-tsc`。如果某些 `tsconfig.json` 暂时不想交给 Limina，可以写到 `exclude` 里；`limina init` 生成的配置会先放一个空数组，方便你直接补路径。

添加根脚本：

```json
{
  "scripts": {
    "limina:build": "limina checker build"
  }
}
```

运行：

```sh
pnpm limina:build
```

这个 build-first 入口会先准备 Limina 管理的检查器图，再运行支持构建模式的检查器。等这条 build 路径稳定后，再运行 `pnpm exec limina check` 接入完整检查流程。默认检查包含这些任务；结果会按下面顺序展示和记录，实际调度会在并发额度和资源锁允许时并发执行：

1. `graph:check`（会先 prepare 生成图）
2. `source:check`
3. `proof:check`
4. `checker:build`
5. `checker:typecheck`

运行失败时，可以按失败任务判断下一步。同一次输出可能包含多个失败任务：

- `graph:check` 失败，多半是导入、生成项目引用、包依赖声明或标签规则没有对齐；
- `source:check` 失败，多半是文件归属、跨包相对导入、依赖声明或 `#imports` 有问题；
- `proof:check` 失败，多半是检查器 include、声明构建覆盖或允许清单没有覆盖到源码；
- `checker:build` 失败，说明 `tsc`、`tsgo` 或 `vue-tsc` 这类支持构建模式的检查器发现类型错误；
- `checker:typecheck` 失败，说明 `vue-tsgo`、`svelte-check` 这类只做类型检查的执行器发现类型错误。

例如 `@acme/app` 新增了 `@acme/core` 导入，`pnpm exec limina check` 报出 `graph:check` 问题时，优先看提示里的导入文件和源码 tsconfig。修完后再跑同一个命令，确认图、源码归属、覆盖证明和检查器执行一起通过。

## 添加框架检查器

Limina 也可以运行框架感知检查器。当工作区某部分需要它时，增加一个检查器入口：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        include: ['packages/**/tsconfig.json'],
        exclude: ['packages/web/tsconfig.json'],
      },
      vue: {
        preset: 'vue-tsc',
        include: ['packages/web/tsconfig.json'],
      },
    },
  },
});
```

检查器入口始终是 `tsconfig.json`。如果包里还有 `tsconfig.lib.json` 或 `tsconfig.test.json`，让这个包的 `tsconfig.json` reference 它们；Limina 会继续跟随这些 references。

内置预设包括 `tsc`、`tsgo`、`vue-tsc`、`vue-tsgo`、`svelte-check`。启用某个检查器时，请安装对应包；`tsgo` 和 `vue-tsgo` 需要 `@typescript/native-preview`。Limina 默认用内置 heuristic 解析 Vue SFC import；只有显式启用 `config.imports.vue: 'compiler-sfc'` 时，才需要再安装 `@vue/compiler-sfc`。
