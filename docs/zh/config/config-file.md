# 配置文件

Limina 读取所选的配置模块，通常是项目 `package.json` 旁边的 `limina.config.mts`：

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  config: {},
});
```

省略 `--config` 时，Limina 搜索当前目录及其祖先，每层依次检查 `limina.config.mts`、`limina.config.mjs`、`limina.config.ts`、`limina.config.js`。显式 `--config` 相对于当前工作目录解析，执行命令要求该模块存在。

所选模块向上最近的 `package.json` 固定治理根。它必须是可读的普通文件，内容为非 `null`、非数组的对象。Limina 不跳过无效的最近包清单。只有该根自身的工作区声明决定本次治理工作区还是一个包。包管理器的判定依据和迁移说明见[治理根](../getting-started.md#治理根)。

选定配置后，从不同目录调用保持同一个治理根：选择仓库根配置仍治理其工作区，选择子包配置则使用子包最近的包清单。配置目录本身不必就是包根目录。

只读 `check --issues` 将显式 `--config` 作为定位锚点，因此模块可以已经删除或重命名。它从该路径的目录找到并验证最近包清单，读取对应持久化状态，不导入配置、不解析包管理器确定的成员关系、不执行治理。没有 `--config` 时，必须发现当前存在的默认配置。缺少记录不会触发向祖先工作区回退。

`defineConfig` 保留传入的对象、`Promise` 或函数，并提供配置类型；运行时加载和数据格式验证由加载器完成。公开 `limina` 入口导出该辅助函数、配置与问题类型，以及验证错误类。仅工作区使用的 `limina/internal/*` 源码导出会从发布包移除，不是消费者 API。

配置也可以是函数：

```ts
export default defineConfig(({ command, mode }) => ({
  config: {
    // 可为持续集成、本地或发布模式返回不同配置
  },
}));
```

本地、持续集成和发布流程需要不同检查器、规则或包条目时，可以使用函数配置。

::: tip 提示
省略 `config.checkers` 时，Limina 会自动发现检查器。需要显式控制检查器路由时，参见[检查器入口](./checkers.md)。
:::

## 配置加载器 {#config-loader}

- **类型：** `'native' | 'tsx'`
- **默认值：** `'native'`
- **CLI：** `--config-loader native` 或 `--config-loader tsx`

`native` 加载器会通过当前运行时直接导入配置，并遵循运行时的模块规则。因此，当 Node 把已有的 `limina.config.js` 视为 CommonJS 时，该文件可以使用 CommonJS；`.mts` 和 `.mjs` 使用 ESM。当配置使用了当前运行时无法原生导入的 TypeScript 语法时，使用 `tsx`。`tsx` 加载器使用 `tsx/esm/api`，因此使用前需要在接入工作区安装 `tsx`。

## `mode`

- **类型：** `string`

`mode` 的解析顺序是 `--mode`，然后是 `NODE_ENV`，最后回退到 `'default'`。

函数配置可以根据 `mode`，为本地、持续集成和发布流程返回不同的检查器、规则或包条目。

如果包输出条目只服务于 `package` / `release` 命令，优先按 `command` 分支；`mode` 更适合表达更宽的环境差异。

```ts
export default defineConfig(({ mode }) => ({
  config: {
    // 可为持续集成、本地或发布模式返回不同配置
  },
}));
```

## `command`

- **类型：** `'check' | 'graph' | 'package' | 'proof' | 'release' | 'source' | (string & {})`
- **相关：** [检查器入口](./checkers.md)

`command` 表示当前加载配置的命令族，例如 `check`、`graph`、`source`、`package` 或 `release`。开放字符串类型也允许 `build`、`migration` 等当前值，不代表另有受支持命令。不带配置路径的 `checker build` 与 `checker typecheck` 按 `check` 加载；`checker build <config>` 与顶层 `build` 按 `build` 加载。命名 `check` 流水线仅以 `command: 'check'` 加载一次配置，包括其中的包检查或发布步骤。

例如，只为 `package` 和 `release` 命令返回包输出条目：

```ts
export default defineConfig(({ command }) => ({
  package:
    command === 'package' || command === 'release'
      ? {
          entries: [
            {
              name: '@acme/core',
              outDir: 'packages/core/dist',
            },
          ],
        }
      : undefined,
}));
```

使用这个分支时，图检查和覆盖证明不会收到包输出条目。

以下面的目录为例：

```text
limina.config.mts
packages/core/
  src/index.ts
  dist/package.json
```

配置可以选择检查器，并为 `package` 和 `release` 命令返回包输出：

```ts
export default defineConfig(({ command }) => ({
  config: {
    checkers: {
      tsc: {
        include: ['packages/**/tsconfig.json'],
      },
    },
  },
  package:
    command === 'package' || command === 'release'
      ? {
          entries: [
            {
              name: '@acme/core',
              outDir: 'packages/core/dist',
            },
          ],
        }
      : undefined,
}));
```

运行 `pnpm exec limina check` 时，Limina 会用 `check` 命令族加载配置，只分析图、源码、覆盖证明、检查器构建和检查器类型检查需要的内容。运行 `pnpm exec limina package check` 或 `pnpm exec limina release check` 时，Limina 会按对应命令族加载配置，并读取 `package.entries`。

使用这个分支时，日常检查不要求输出文件已经构建，独立包检查和发布检查则要求 `packages/core/dist`。若要把 `package:check` 或 `release:check` 放进命名 `check` 流水线，还必须在 `command: 'check'` 时返回条目，例如仅在 `mode === 'release'` 时返回，并运行 `limina --mode release check <name>`。流水线步骤不会按各自命令族重新加载配置。
