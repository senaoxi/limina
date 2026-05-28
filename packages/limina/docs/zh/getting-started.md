# 快速开始

## 环境要求

Limina 面向 pnpm workspace，并要求配置文件使用 ESM。

- Node.js `^20.19.0 || >=22.12.0`
- workspace 根目录有 `pnpm-workspace.yaml`
- 接入仓库中安装了 TypeScript
- `limina.config.mjs` 位于 workspace 内部

## 安装

::: code-group

```sh [pnpm]
pnpm add -D limina typescript
```

:::

## 选择接入方式

如果你的 workspace 还没有清晰的 `tsconfig*.dts.json`、`tsconfig.build.json` 和 project references，优先使用 `limina init`。它会从已有 `tsconfig*.json` 推导能安全生成的声明图，并在遇到含糊结构时停下来，让你手动确认。

如果你的仓库已经有稳定的 declaration build graph，直接写最小 `limina.config.mjs` 更快。此时 Limina 不会重新设计你的 graph，只会从你指定的 checker entry 开始检查现有结构。

## 初始化已有 workspace

如果一个 pnpm monorepo 还没有采用 Limina 的声明图结构，可以运行：

```sh
pnpm exec limina init
```

`limina init` 会向上查找最近的 `pnpm-workspace.yaml`，确认 workspace root，扫描普通 `tsconfig*.json`，并写出它能安全推导的 Limina 文件。

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

遇到含糊输入时，init 会拒绝而不是猜测。例如已经存在 `tsconfig*.build.json` 或 `tsconfig*.dts.json`，或者 `tsconfig.json` 同时混合源码文件和 project references。

这类失败通常说明仓库已经有自己的 tsconfig 约定。先读报错中列出的文件，再决定是保留现状并手写配置，还是把该目录拆成 aggregator、declaration leaf 和 local companion。

初始化后执行：

```sh
pnpm i
pnpm limina:check
```

只有 init 修改依赖或创建根 `package.json` 时才需要先运行 `pnpm i`。

## 最小手动配置

如果你已经有声明构建图，可以在 workspace 根目录创建 `limina.config.mjs`：

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

默认检查 pipeline 会依次运行：

1. `graph:check`
2. `source:check`
3. `proof:check`
4. `checker:build`
5. `checker:typecheck`

第一次运行失败时，可以按类别判断下一步：

- `graph:check` 失败，多半是 import、project reference、`workspace:*` 或 label rule 没有对齐；
- `source:check` 失败，多半是文件归属、跨 package 相对 import、依赖声明或 `#imports` 有问题；
- `proof:check` 失败，多半是 checker entry、declaration leaf、local companion 或 allowlist 没有覆盖到源码；
- `checker:build` 失败，说明 `tsc`、`tsgo` 或 `vue-tsc` 这类一等公民 checker 在 build 模式发现类型错误；
- `checker:typecheck` 失败，说明 `vue-tsgo`、`svelte-check` 这类 source-only checker 发现类型错误。

例如 `@acme/app` 新增了 `@acme/core` import，第一次跑 `pnpm typecheck` 报 graph 问题时，优先看提示里的 importing file 和 expected reference。修完后再跑同一个命令，确认 graph、source ownership、coverage proof 和 checker execution 一起通过。

## 添加框架 checker

Limina 也可以运行框架感知 checker。当 workspace 某部分需要它时，增加一个 checker entry：

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

内置 preset 包括 `tsc`、`tsgo`、`vue-tsc`、`vue-tsgo`、`svelte-check`。启用某个 checker 时，请安装对应 package；`tsgo` 和 `vue-tsgo` 需要 `@typescript/native-preview`，`vue-tsc` entry 还需要 `@vue/compiler-sfc`，这样 Limina 才能解析 SFC imports。
