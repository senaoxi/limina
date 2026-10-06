# 快速开始

本页按安装、初始化、必要时迁移、首次检查的顺序接入 Limina。完成后，你会得到源码结构与类型检查结果；项目的生产产物仍由相应构建流程生成。

## 环境要求

Limina 支持单包项目，以及 pnpm、npm、Yarn 和 Bun 工作区。下面的配置示例使用 ESM。

- Node.js `^22.18.0 || >=24.11.0`。
- 可读取且顶层为对象的 `package.json`。
- 处于所安装 Limina 对等依赖范围内的 TypeScript；当前源码版本支持 `>=5.4.0 <5.10.0 || >=6.0.0 <6.1.0`。

使用 Vue、Astro 或 Svelte 时，还需要对应的检查器依赖。安装位置与前置生成步骤见[检查器配置](./config/checkers.md#框架前置条件)。

## 安装

已有兼容 TypeScript 的项目可以保留当前版本，先安装 Limina：

::: code-group

```bash [pnpm]
pnpm add -D limina
```

```bash [npm]
npm install -D limina
```

```bash [yarn]
yarn add -D limina
```

```bash [bun]
bun add -d limina
```

:::

如果项目尚未安装 TypeScript，再安装符合 Limina 对等依赖范围的版本。以当前源码版本和 pnpm 为例：

```sh
pnpm add -D typescript@~6.0.3
```

安装其他 Limina 发行版本时，以该版本声明的兼容范围为准。原生 `tsc` 检查器使用 Limina 自身解析到的 TypeScript；`PATH` 或包目录中另一个 `tsc` 不会覆盖它。

## 选择接入方式

尚无 Limina 配置时，可以使用下面的初始化流程，也可以直接编写[最小手动配置](#最小手动配置)。两种方式都保留用户对源码范围和类型环境的控制；已有源码项目引用可能需要另行迁移。

## 初始化已有项目

在希望接入的项目目录运行，后续命令以 pnpm 为例：

```sh
pnpm exec limina init
```

初始化从当前目录向上寻找最近的 `package.json`，并在其旁边写入配置。最近清单无效时会停止；只有整条祖先链都没有包清单时，才提供创建流程。它不添加工作区声明。

初始化可能创建或更新：

- `limina.config.mts`，启用检查器自动发现，`auto.exclude` 初始为 `[]`；
- `.gitignore` 中的 `.limina/`；
- `package.json` 中的 `limina:build` 脚本，内容为 `limina checker build`；
- 缺失的 `limina` 和 `typescript` 开发依赖。

`limina:build` 执行 Limina 内部的声明构建，不是项目的生产打包命令。初始化还可以按选择安装 Limina 智能体技能。

::: warning 再次初始化前先检查已有内容
初始化会删除根 `.limina/` 目录，包括生成文件和持久化的检查、迁移记录。`--yes` 接受核心初始化确认，包括覆盖已有配置或冲突的 `limina:build` 脚本，并跳过可选技能安装。
:::

非交互调用使用：

```sh
pnpm exec limina init --yes
```

仅在初始化修改了依赖或创建了包清单时，按输出提示重新安装依赖：

```sh
pnpm install
```

无包管理器元信息时，`--yes` 也可完成，后续提示不绑定特定包管理器。需要手动安装可选技能时，见[初始化命令](./cli.md#limina-init)。

### 已有项目引用时先迁移

初始化不会改写源码 `tsconfig`。如果实际包含源码的配置仍手写原生 `references`，应先安装与 `limina` 同版本的独立 `limina-migrate`，再运行：

```sh
pnpm exec limina-migrate
```

查看迁移结果后再执行检查。迁移只建立可重新读取的输入配置，不表示完整治理或检查器已经通过，也不保证与原生 `tsc -b` 等价。具体适用条件、写入范围和结果位置见[迁移说明](./cli.md#limina-migration)。

## 首次检查

```sh
pnpm exec limina check
```

默认流水线包括以下任务：

| 任务                | 主要检查内容                           |
| ------------------- | -------------------------------------- |
| `graph:check`       | 声明引用、实际导入与已配置的图规则     |
| `source:check`      | 源码归属、包导入授权及已启用的源码分析 |
| `proof:check`       | 期望检查的源码是否获得覆盖             |
| `checker:build`     | `tsc`、`tsgo`、`vue-tsc` 的声明构建    |
| `checker:typecheck` | Astro、Svelte 源码配置的类型检查       |

这里的排列是报告顺序，任务可在并发额度和资源锁允许时并发执行。命令会按需生成 `.limina/` 下的检查器配置并运行真实检查器；它不构建所有包的生产产物，也不包含包检查或发布检查。

同时查看任务的执行状态。没有框架检查目标时，`checker:typecheck` 为 `disabled`；禁用、受阻和跳过都不同于检查通过。任务职责及状态解释见[内置任务](./built-in-tasks.md)。

失败时先看输出中的任务、问题代码和文件路径。需要重新查看已完成运行的问题，可以使用：

```sh
pnpm exec limina check --issues
```

`--issues` 读取保存的结果，不重新运行检查。若对应尝试未完成或记录不可用，不能把它理解为零问题。按任务缩小范围以及各类失败的处理入口见[故障排查](./troubleshooting.md#先定位失败任务)。

## 治理根

配置决定本次检查范围。Limina 从所选配置模块向上找到最近的 `package.json`，以其目录作为治理根；只有这个根自身的工作区声明决定成员集合。没有工作区声明时，按单包处理。

### 在多包仓库内选择配置 {#在-monorepo-内选择配置}

选择仓库根配置，会检查它对应的工作区。选择子包自身配置，则使用子包最近的包清单；祖先工作区声明不会自动扩大范围。从子目录运行时，应明确选择希望使用的配置：

```sh
pnpm exec limina --config ../../limina.config.mts check
```

示例路径须按当前目录调整。配置查找顺序、包管理器依据和路径坐标见[配置文件](./config/config-file.md)。

## 最小手动配置

在选定项目的 `package.json` 旁创建 `limina.config.mts`：

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

自动发现始终启用。Limina 在已激活的包范围内寻找默认 `tsconfig.json` 入口，再沿聚合配置的 `references` 找到源码配置。`auto.exclude` 可排除自动发现的入口，但不会切断已经选中入口的引用关系。完整选择规则见[检查器配置](./config/checkers.md)。

手动配置后同样运行 `pnpm exec limina check`。如果需要独立的声明构建脚本，可以添加：

```json
{
  "scripts": {
    "limina:build": "limina checker build"
  }
}
```

## 配置检查器归属

通常可以先保留自动发现。只有需要固定某些入口的检查器时，再添加具名范围：

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      'vue-tsc': {
        include: ['packages/web/tsconfig.json'],
      },
    },
  },
});
```

未被具名范围接管的入口继续自动发现。`include` 只选择默认 `tsconfig.json`；`tsconfig.lib.json`、`tsconfig.test.json` 等命名源码配置应由聚合入口引用，不能直接写入选择器。聚合入口与源码配置的区别见[核心概念](./concepts.md#聚合器配置)。

需要声明输出的关系还要求兼容的检查器归属，不能随意把相互依赖的源码范围固定给不同构建检查器。Astro 和 Svelte 配置只执行类型检查；应用构建与框架生成类型等前置步骤仍由项目流程负责。

首次检查完成后，按[工作流](./workflows.md)接入本地开发和持续集成；需要发布包时，再配置产物检查。
