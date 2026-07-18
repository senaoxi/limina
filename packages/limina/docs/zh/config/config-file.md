# 配置文件

Limina 从工作区内部的 `limina.config.mts` 读取配置。这个文件通常放在工作区根目录：

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  config: {},
});
```

省略 `--config` 时，Limina 会从当前目录向上查找到 `pnpm` 工作区根目录。每一层目录都会依次检查 `limina.config.mts`、`limina.config.mjs`、`limina.config.ts`、`limina.config.js`。已有的 `limina.config.ts` 和 `limina.config.mjs` 仍然支持，新项目优先使用 `limina.config.mts`。

配置也可以是函数：

```ts
export default defineConfig(({ command, mode }) => ({
  config: {
    // 可以按 CI、本地或发布模式返回不同配置
  },
}));
```

本地、`CI`、发布前需要使用不同检查器、规则或包条目时，可以用函数配置返回不同内容。环境差异会留在一个可审查的配置文件里。

::: tip
省略 `config.checkers` 时，Limina 会自动发现 `checker`。需要显式控制 `checker` 路由时，再看[检查器入口](./checkers.md)。
:::

## config loader

- **类型：** `'native' | 'tsx'`
- **默认值：** `'native'`
- **CLI：** `--config-loader native` 或 `--config-loader tsx`

`native` loader 会通过当前运行时直接导入配置，并遵循运行时的模块规则。因此，当 Node 把已有的 `limina.config.js` 视为 CommonJS 时，该文件可以使用 CommonJS；`.mts` 和 `.mjs` 使用 ESM。当配置使用了当前运行时无法原生导入的 TypeScript 语法时，使用 `tsx`。`tsx` loader 使用 `tsx/esm/api`，因此使用前需要在接入工作区安装 `tsx`。

## mode

- **类型：** `string`

`mode` 的解析顺序是 `--mode`，然后是 `NODE_ENV`，最后回退到 `'default'`。

本地、`CI`、发布前需要使用不同检查器、规则或包条目时，可以用函数配置根据 `mode` 返回不同内容。环境差异会留在一个可审查的配置文件里。

如果包输出条目只服务于 `package` / `release` 命令，优先按 `command` 分支；`mode` 更适合表达更宽的环境差异。

```ts
export default defineConfig(({ mode }) => ({
  config: {
    // 可以按 CI、本地或发布模式返回不同配置
  },
}));
```

## command

- **类型：** `'check' | 'graph' | 'package' | 'proof' | 'release' | 'source' | (string & {})`
- **相关：** [检查器入口](./checkers.md)

`command` 表示当前加载配置的命令族，例如 `check`、`graph`、`source`、`package` 或 `release`。开放字符串分支还覆盖 `build`、`migration` 等当前命令，并允许以后增加新的命令族。当某些昂贵配置只服务于特定命令时，可以按 `command` 分支返回。

例如只在包感知命令里声明发布产物条目：

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

这样普通图检查 / 覆盖证明不会被发布产物配置干扰。

完整一点看，目录可以是：

```text
limina.config.mts
packages/core/
  src/index.ts
  dist/package.json
```

配置里可以只为包感知命令声明包输出：

```ts
export default defineConfig(({ command }) => ({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
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

结果是本地日常检查不需要关心 `dist` 是否存在；包和发布检查则会明确要求 `packages/core/dist` 已经构建好，并按包条目做产物验证。
