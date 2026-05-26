# 配置文件

Limina 从 workspace 内部的 `limina.config.mjs` 读取配置。这个文件通常放在 workspace root：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {},
});
```

配置也可以是函数：

```js
export default defineConfig(({ command, mode }) => ({
  config: {
    // 可以按 CI、本地或发布模式返回不同配置
  },
}));
```

`mode` 来自 `--mode`，然后是 `NODE_ENV`，最后回退到 `default`。

## `mode`

本地、CI、发布前需要使用不同 checker、规则或 package entries 时，可以用函数配置根据 `mode` 返回不同内容。环境差异会留在一个可审查的配置文件里。

如果 package output entries 只服务于 package/release 命令，优先按 `command` 分支；`mode` 更适合表达更宽的环境差异。

## `command`

`command` 表示当前加载配置的命令族，例如 `check`、`graph`、`paths`、`package` 或 `release`。当某些昂贵配置只服务于特定命令时，可以按 `command` 分支返回。

例如只在 package-aware 命令里声明发布产物 entries：

```js
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

这样普通 graph/proof 检查不会被发布产物配置干扰。

完整一点看，目录可以是：

```text
limina.config.mjs
packages/core/
  src/index.ts
  dist/package.json
```

配置里可以只为 package-aware 命令声明 package output：

```js
export default defineConfig(({ command }) => ({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: 'tsconfig.build.json',
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

运行 `pnpm exec limina check` 时，Limina 会用 `check` 命令族加载配置，只分析 graph、source、proof、checker build 和 checker typecheck 需要的内容。运行 `pnpm exec limina package check` 或 `pnpm exec limina release check` 时，Limina 会按对应命令族加载配置，并读取 `package.entries`。

结果是本地日常检查不需要关心 `dist` 是否存在；package 和 release 检查则会明确要求 `packages/core/dist` 已经构建好，并按 package entry 做产物验证。
