# 快速开始

## 环境要求

Limina 面向 `pnpm` 工作区，并要求配置文件使用 `ESM`。

- `Node.js ^22.18.0 || >=24.11.0`
- 工作区根目录存在 `pnpm-workspace.yaml`
- 接入仓库已经安装 `TypeScript`
- `limina.config.mts` 位于工作区内部

## 安装

::: code-group

```bash [pnpm]
pnpm add -D limina typescript
```

```bash [npm]
npm install -D limina typescript
```

```bash [yarn]
yarn add -D limina typescript
```

:::

## 选择接入方式

如果工作区还没有 Limina 配置，优先使用 `limina init`。它会写入采用自动模式（`mode: 'auto'`）的 `limina.config.mts`，添加根脚本，确保 `.limina/` 被忽略，并可以为当前项目安装可选的 Limina `agent skill`。

如果仓库已经有清晰的 `tsconfig` 约定，直接写最小 `limina.config.mts` 会更快。多数工作区只需要自动发现检查器；只有需要显式控制检查器路由时，才需要继续查看[检查器入口](./config/checkers.md)。

## 初始化已有工作区

如果一个 `pnpm` 单体仓库还没有采用 Limina 的声明图结构，可以运行：

```sh
pnpm exec limina init
```

`limina init` 会向上查找最近的 `pnpm-workspace.yaml`，确认工作区根目录，并写出 Limina 配置文件。

在非交互环境中使用：

```sh
pnpm exec limina init --yes
```

`--yes` 只接受核心初始化确认，并会跳过可选的 `skill` 安装。之后如果要手动安装 `skill`，可以运行：

```sh
npx --yes skills add senaoxi/docs-islands --skill limina
```

初始化过程可能创建或更新：

- 根目录 `limina.config.mts`；
- 根目录 `.gitignore` 中的 `.limina/`；
- 根目录 `limina:build` 脚本；
- 根目录缺失的 `limina` 和 `typescript` 开发依赖。

::: warning
生成的检查器图会由 `limina graph prepare` 以及使用该图的命令写入 `.limina/`。
:::

如果图准备失败，通常说明检查器的 `include` 选中了保留配置或非源码 `tsconfig`。此时应收窄 `include`，或补充 `exclude`，直到只选中普通的源码配置。

初始化后执行：

```sh
pnpm i
pnpm limina:build
```

::: tip
只有 `limina init` 修改依赖或创建根 `package.json` 时，才需要先运行 `pnpm i`。
:::

## 最小手动配置

在工作区根目录创建 `limina.config.mts`：

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      mode: 'auto',
    },
  },
});
```

这里显式写出 `mode: 'auto'`，是为了让配置直接表达 Limina 的行为：自动寻找源码用的 `tsconfig.json`，再按文件内容交给 `tsc` 或 `vue-tsc`。如果某些 `tsconfig.json` 暂时不想交给 Limina，可以写到 `exclude` 中。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      mode: 'auto',
      exclude: ['**/__tests__/**', 'playground/**'], // [!code focus]
    },
  },
});
```

`limina init` 生成的配置会先放一个空数组，方便之后直接补充路径。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      mode: 'auto',
      exclude: [], // [!code focus]
    },
  },
});
```

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

构建入口会先准备 Limina 管理的检查器图，再运行支持构建模式的检查器。等构建路径稳定后，再运行 `pnpm exec limina check` 接入完整检查流程。默认检查包含以下任务；结果会按下面顺序展示和记录，实际调度会在并发额度和资源锁允许时并发执行：

1. `graph:check`（会先准备检查器图）
2. `source:check`
3. `proof:check`
4. `checker:build`（检查器构建）
5. `checker:typecheck`（检查器类型检查）

运行失败时，先看输出中的失败任务和问题摘要。同一次输出可能包含多个失败任务；任务名用于判断问题大类，问题代码、文件或配置路径、失败原因和修复建议用于定位具体原因。`--issues` 可以查看最近一次检查记录的问题，并按任务继续收窄范围。

```sh
pnpm exec limina check --issues
```

也可以只查看某一类任务的问题：

```sh
pnpm exec limina check --issues --task graph:check
pnpm exec limina check --issues --task source:check
pnpm exec limina check --issues --task proof:check
pnpm exec limina check --issues --task checker:build
pnpm exec limina check --issues --task checker:typecheck
```

常见判断方式如下：

- `graph:check` 失败，通常说明源码导入关系与 Limina 生成或校验的 `TypeScript` 项目图没有对齐。优先检查由静态导入推导出的项目引用是否缺失或多余，跨工作区包引用是否有对应依赖声明，图规则或标签是否禁止了当前依赖边，以及工作区导入是否能稳定解析并映射到源码图。
- `source:check` 失败，通常说明源码文件归属或源码导入授权没有通过。优先检查源码归属方、`tsconfig` 治理、相对导入是否越过最近的 `package.json` 包边界，`#...` 导入是否匹配当前源码归属方的 `package.json#imports`，裸包导入是否由依赖声明或 `source.importAuthority.allow` 授权，以及 `Knip` 发现的未使用源码或未使用依赖问题。
- `proof:check` 失败，通常说明 Limina 无法证明实际源码已经被类型检查覆盖。优先检查检查器入口是否生成了对应 `tsconfig`，声明构建配置与配套类型检查配置是否一致，`config.source` 中的文件是否被检查器、图或 `proof.allowlist` 覆盖，以及是否存在同一源码文件被多个图或类型检查归属方覆盖的问题。
- `checker:build`（检查器构建）失败，说明构建型检查器没有通过。常见原因包括 `tsc`、`tsgo`、`vue-tsc` 外部命令返回错误，缺少对应检查器依赖，或者 Limina 无法为当前目标选择有效的构建目标。先看 Limina 汇总中的检查器、配置路径和退出码，再进入对应检查器的原始日志。
- `checker:typecheck`（检查器类型检查）失败，说明类型检查型检查器没有通过。常见原因包括 `vue-tsgo`、`svelte-check` 外部命令返回错误，缺少对应检查器依赖，或生成的检查器入口无法正常执行。先根据 Limina 汇总定位执行器和配置路径，再查看对应问题或原始日志。

推荐排查顺序是：先处理 `graph:check`、`source:check`、`proof:check` 这类结构性问题，再处理 `checker:build`（检查器构建）和 `checker:typecheck`（检查器类型检查）的执行器错误。前者决定 Limina 如何理解项目图、源码归属、导入授权和类型检查覆盖范围；后者通常是具体检查器对源码或框架类型约束给出的结果。默认检查会按上述任务顺序展示和记录问题，但任务本身可能在资源允许时并发执行，因此这个顺序是阅读和处理问题的建议顺序，不代表后续任务一定被前置任务阻塞。

## 添加框架检查器

Limina 也可以运行框架感知检查器。当工作区某部分需要它时，可以增加一个检查器入口：

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

检查器入口始终是 `tsconfig.json`。如果包里还有 `tsconfig.lib.json` 或 `tsconfig.test.json`，应由这个包的 `tsconfig.json` 通过 `references` 配置声明项目引用；Limina 会继续跟随这些项目引用。

内置预设包括 `tsc`、`tsgo`、`vue-tsc`、`vue-tsgo`、`svelte-check`。启用某个检查器时，请安装对应包；`tsgo` 和 `vue-tsgo` 需要 `@typescript/native-preview`。Limina 默认用内置启发式规则解析 `Vue SFC` 的导入；只有显式启用 `config.imports.vue: 'compiler-sfc'` 时，才需要再安装 `@vue/compiler-sfc`。
