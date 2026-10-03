# 快速开始

## 环境要求

Limina 支持单包项目，以及 pnpm、npm、Yarn 和 Bun 工作区，配置文件使用 ESM。

- `Node.js ^22.18.0 || >=24.11.0`
- 可读取且顶层为对象的 `package.json`
- 接入项目已安装 `TypeScript`，且版本处于所安装 Limina 的对等依赖版本范围内（当前为 `>=5.4.0 <5.10.0 || >=6.0.0 <6.1.0`）
- Limina 配置模块，通常为 `limina.config.mts`

## 治理根

Limina 先选择配置模块。未指定 `--config` 时，从当前工作目录向上逐目录查找，每个目录依次检查 `limina.config.mts`、`limina.config.mjs`、`limina.config.ts`、`limina.config.js`。随后从所选配置的目录寻找最近的 `package.json`，由它固定治理根。最近清单不可读、不是普通文件、JSON 格式错误或顶层不是对象时，在该位置失败，不跳过它。

只有该根自身的工作区声明决定成员集合。没有声明时，区域排除之前的唯一包就是根包。`{}` 已经足够：名称、版本、包管理器和锁文件都可缺省。包管理器元信息缺失、存在歧义或声明无效，不阻断无需包管理器语义的治理。

在选定根目录内，`pnpm-workspace.yaml` 优先；它可以确定 pnpm，除非显式 `packageManager` 与它冲突。`package.json#workspaces` 则需要明确的 npm、Yarn 或 Bun 包管理器：自身的 `packageManager` 优先，否则使用同目录锁文件。无法确定包管理器依据、存在歧义或声明无效时均失败；即使最终只有根包，有效工作区仍按工作区处理。

Limina 可读取的工作区声明形式包括 pnpm 的 `packages: string[]`（缺省表示没有子包）、npm 的 `workspaces: string[]`，以及 Yarn 或 Bun 的该数组或 `{ packages: string[] }`。包管理器适配器保留各自的成员选择和忽略规则。依赖版本目录（`catalog`）是否合法、依赖能否安装、版本是否可用，以及锁文件是否一致，仍由包管理器负责。

### 在多包仓库内选择配置 {#在-monorepo-内选择配置}

即使从子目录调用，选择仓库根配置仍会治理该配置对应的工作区。选择子包自身配置，则由它最近的包清单决定治理根；没有同根工作区声明时就是单包。祖先工作区声明不能扩大本次范围。

这改变了原来优先选择祖先工作区的根选择契约。同一候选根下的成员选择语义保持不变。请检查那些选择子包配置、但以前依赖祖先工作区范围的脚本。详见[配置文件](./config/config-file.md)。

## 安装

::: code-group

```bash [pnpm]
pnpm add -D limina@latest typescript@~6.0.3
```

```bash [npm]
npm install -D limina@latest typescript@~6.0.3
```

```bash [yarn]
yarn add -D limina@latest typescript@~6.0.3
```

```bash [bun]
bun add -d limina@latest typescript@~6.0.3
```

:::

这些示例选择当前源码版本使用的 TypeScript 6.0 范围。安装其他 Limina 发行版本时，应先核对它声明的对等依赖版本范围，再选择 TypeScript。

原生 `tsc` 检查器的版本校验和执行使用 Limina 自身解析到的同一套 TypeScript 安装。`PATH` 中更靠前的 `tsc` 或包目录中的 `.bin` 不会覆盖该编译器。

## 选择接入方式

如果项目还没有 Limina 配置，优先使用 `limina init`。它会写入采用扁平 `checkers.auto` 结构的 `limina.config.mts`，添加根脚本，确保 `.limina/` 被忽略，并可以为当前项目安装可选的 Limina 智能体技能。

也可以直接编写最小 `limina.config.mts`。需要在自动发现之外显式分配检查器时，参见[检查器入口](./config/checkers.md)。

## 初始化已有项目

如果一个项目还没有采用 Limina 的声明图结构，可以运行：

```sh
pnpm exec limina init
```

`limina init` 从当前工作目录寻找最近的 `package.json`，验证后在其旁边写入 `limina.config.mts`。最近清单无效时停止初始化。只有整条祖先链完全没有包清单时，才在当前工作目录提供创建流程。初始化不添加工作区声明。无包管理器元信息时 `--yes` 仍可完成，并给出中立的后续操作提示。

初始化不改写源码 `tsconfig`。普通源码叶子配置如果仍声明原生 `references`，或需要转换配置，应在初始化后使用匹配版本的 `limina-migrate`，查看其输入消费结果，再运行 `limina check`。参见[工作流](./workflows.md)和[迁移契约](./cli.md#limina-migration)。

在非交互环境中使用：

```sh
pnpm exec limina init --yes
```

`--yes` 接受核心初始化确认，包括覆盖已有配置或冲突的 `limina:build` 脚本，并会跳过可选的智能体技能安装。之后如果要手动安装技能，可以运行：

```sh
npx --yes skills add senaoxi/docs-islands --skill limina
```

初始化过程可能创建或更新：

- 根目录 `limina.config.mts`；
- 根目录 `.gitignore` 中的 `.limina/`；
- 根目录 `limina:build` 脚本；
- 根目录缺失的 `limina` 和 `typescript` 开发依赖。

::: warning 注意
初始化会在写入配置前删除已有的根 `.limina/` 目录，其中包括生成文件和持久化的检查、迁移记录。再次运行初始化前应查看现有配置，尤其是在使用 `--yes` 时。

`limina graph prepare` 会显式把生成的检查器文件物化到 `.limina/`。受管 `build` 命令、检查器执行，以及包含检查器任务或 `graph:prepare` 的 `check` 流水线也会按需物化；只做图、源码或覆盖验证的命令会在内存中计算图，不写出这些文件。
:::

图准备失败时，应查看其配置路径和原因。无效的检查器入口选择器、不支持的非默认文件名聚合配置、带原生 `references` 的普通源码叶子配置、治理区域或输入越界，以及检查器归属或声明提供者冲突，都可能阻止准备。检查器的 `include` 只选择默认 `tsconfig.json` 入口；选择器的排除规则不会截断已选入口的项目引用闭包。

初始化会报告所选包管理器对应的命令：

| 包管理器 | 依赖改变后安装 | 构建                   |
| -------- | -------------- | ---------------------- |
| pnpm     | `pnpm install` | `pnpm limina:build`    |
| npm      | `npm install`  | `npm run limina:build` |
| Yarn     | `yarn install` | `yarn limina:build`    |
| Bun      | `bun install`  | `bun run limina:build` |

以下命令以 pnpm 为例：

```sh
pnpm i
pnpm limina:build
```

::: tip 提示
只有 `limina init` 修改依赖或创建根 `package.json` 时，才需要先运行 `pnpm i`。
:::

## 最小手动配置

在工作区根目录创建 `limina.config.mts`：

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      auto: {},
    },
  },
});
```

自动发现始终启用。Limina 会在已激活的工作区包治理区域内寻找默认源码 `tsconfig.json` 入口，先解析框架检查器归属，再回退到普通 TypeScript 检查器，并递归跟随受管项目引用。如果个别自动入口暂时不应进入根入口发现范围，可以写入 `auto.exclude`；它不会切断已经进入治理范围的入口的引用闭包。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      auto: {
        exclude: ['**/__tests__/**', 'playground/**'], // [!code focus]
      },
    },
  },
});
```

`limina init` 生成配置中的 `auto.exclude` 初始值为 `[]`。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      auto: {
        exclude: [], // [!code focus]
      },
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

构建入口先准备 Limina 管理的检查器图，再运行支持构建模式的检查器。运行 `pnpm exec limina check` 可执行以下默认流水线。结果按此顺序展示和记录，任务会在并发额度和资源锁允许时并发执行：

1. `graph:check`（会先准备检查器图）
2. `source:check`
3. `proof:check`
4. `checker:build`（检查器构建）
5. `checker:typecheck`（检查器类型检查）

这会准备声明构建并运行选中的类型检查器，不会构建所有包的发布产物。Astro 和 Svelte 应用构建以及其他产物构建，仍由项目自身的构建流程负责。未发现类型检查目标时，`checker:typecheck` 为禁用状态（`disabled`）；包检查和发布检查不属于默认流水线。应将禁用（`disabled`）、受阻（`blocked`）和跳过（`skipped`）结果与通过检查分别查看。

运行失败时，先看输出中的失败任务和问题摘要。同一次输出可能包含多个失败任务；任务名用于判断问题大类，问题代码、文件或配置路径、失败原因和修复建议用于定位具体原因。`--issues` 读取持久化的检查状态，不运行检查或导入配置。存在当前检查尝试的元数据时，只有最近一次尝试已完成且完成记录一致，才返回其问题清单；最近一次尝试仍在运行、被中断、被终止、损坏或持久化失败时，不会退回旧问题。清单可用时，可以按任务继续收窄范围。

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

- `graph:check` 失败，可能表示源码关系无法形成合法的声明提供者引用、跨工作区包引用缺少依赖声明、图规则或标签禁止了边，或被消费的工作区导入无法由其检查器解析。普通源码叶子配置不能手写原生 `references`；修改选择器或添加 `implicitRefs` 前，先检查报告中的声明提供者、源码归属或边界原因。
- `source:check` 失败，通常说明源码文件归属或源码导入授权没有通过。优先检查源码归属方、`tsconfig` 治理、相对导入是否越过最近的 `package.json` 包边界，`#...` 导入是否匹配导入文件最近包作用域的 `package.json#imports`，裸包导入是否由源码所属工作区包的依赖声明或 `source.importAuthority.allow` 授权，以及已启用的 `Knip` 分析发现的未使用源码或未使用依赖问题。
- `proof:check` 失败，通常说明 Limina 无法证明实际源码已经被类型检查覆盖。优先检查源码归属是否唯一、聚合配置的叶子配置是否由同一个检查器最终负责、声明构建配置与配套类型检查配置是否一致、由 Astro 或 Svelte 检查器负责的配置是否拥有可执行的叶子目标，以及 `config.source` 中的文件是否被检查器、图或 `proof.allowlist` 覆盖。
- `checker:build`（检查器构建）失败，说明构建型检查器没有通过。常见原因包括 `tsc`、`tsgo`、`vue-tsc` 外部命令返回错误，缺少对应检查器依赖，或者 Limina 无法为当前目标选择有效的构建目标。先看 Limina 汇总中的检查器、配置路径和退出码，再进入对应检查器的原始日志。
- `checker:typecheck`（检查器类型检查）失败，说明由框架检查器负责的叶子配置没有通过。常见原因包括 `astro check` 或 `svelte-check` 返回错误、缺少叶子包内的检查器或解析器依赖，或缺少 Astro 生成类型。先根据 Limina 汇总定位负责该配置的检查器和配置路径，再查看对应问题或原始日志。

可以先处理 `graph:check`、`source:check`、`proof:check` 的结构问题，再查看 `checker:build`（检查器构建）和 `checker:typecheck`（检查器类型检查）的执行错误。结构检查涉及声明关系、源码归属、导入授权和覆盖范围；检查器错误可能来自源码或框架类型问题。这是阅读和修复问题的建议顺序，任务可能并发执行，不代表前面的失败一定阻塞后续任务。

## 配置检查器归属

工作区不同部分需要不同构建归属时，使用固定的检查器键名：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      tsc: {
        include: ['packages/**/tsconfig.json'],
        exclude: ['packages/web/tsconfig.json'],
      },
      'vue-tsc': {
        include: ['packages/web/tsconfig.json'],
      },
    },
  },
});
```

检查器入口始终是 `tsconfig.json`。如果包里还有 `tsconfig.lib.json` 或 `tsconfig.test.json`，应由这个包的 `tsconfig.json` 通过 `references` 配置声明项目引用；即使引用路径匹配检查器的 `exclude`，Limina 仍会继续跟随这些项目引用。所有被引用的普通源码配置都应位于已激活区域内。

检查器标识是 `tsc`、`tsgo`、`vue-tsc`、`astro` 与 `svelte-check`；每个受管类型配置最终恰好由其中一个负责。前三者可以输出声明，Astro 和 Svelte 则按叶子配置执行，没有声明配置投影。启用相应检查器时，请安装对应包；`tsgo` 需要 `@typescript/native-preview`。Astro 检查与语义图分析要求所属叶子包安装 `astro`、`@astrojs/check` 和 `typescript`；Limina 从已安装的 `@astrojs/check` 语言服务器工具链获取 Astro 编译器，不再声明独立的 `@astrojs/compiler` 对等依赖或运行时依赖。Svelte 检查与语义图分析要求所属叶子包安装 `svelte-check`、`svelte2tsx`、`svelte` 和 `typescript`。Vue 语义图分析从检查器执行范围解析受支持的 `vue-tsc`，再从该检查器的安装环境解析内部工具链，应用无需为 Limina 单独安装 Language Core 或 Volar TypeScript。独立的导入收集只接受原生 JavaScript 或 TypeScript 文件；框架文件必须使用项目及检查器上下文。
