# 配置文件

Limina 从 workspace 内部的 `limina.config.mjs` 读取配置。这个文件通常放在 workspace root：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  strict: true,
  config: {},
});
```

配置也可以是函数：

```js
export default defineConfig(({ command, mode }) => ({
  strict: mode === 'ci',
  config: {
    // 可以按 CI、本地或发布模式返回不同配置
  },
}));
```

`mode` 来自 `--mode`，然后是 `NODE_ENV`，最后回退到 `default`。

## `mode`

本地、CI、发布前需要使用不同 checker、规则或 package entries 时，可以用函数配置根据 `mode` 返回不同内容。环境差异会留在一个可审查的配置文件里。

如果 package output entries 只服务于 package/release 命令，优先按 `command` 分支；`mode` 更适合表达更宽的环境差异。

## `strict`

`strict` 是顶层 boolean 配置项，默认值是 `false`，所以升级后现有项目会保持原有检查行为。

当 workspace 已经准备好遵循 Limina 的完整结构模型时，可以开启：

```js
export default defineConfig(({ mode }) => ({
  strict: mode === 'strict' || mode === 'ci',
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: 'tsconfig.build.json',
      },
    },
  },
}));
```

strict 模式不会改变命令入口，但会在 `graph:check`、`source:check`、`proof:check`、`package:check` 和 `release:check` 中追加更完整的建模约束。Typecheck leaf 必须有同名 declaration leaf；declaration leaf 必须继承 companion，并且除 declaration/build 输出配置外保持相同文件集合；build graph config 只能引用 build aggregator 或 declaration leaf；源码归属必须落在 nearest `package.json` 下；workspace 源码 import 必须解析到 source graph 拥有的文件；构建后和打包后的 package manifest 不能暴露 `workspace:`、`link:`、`file:` 或 `catalog:` 依赖 specifier。

## `command`

`command` 表示当前加载配置的命令族，例如 `check`、`graph`、`source`、`package` 或 `release`。当某些昂贵配置只服务于特定命令时，可以按 `command` 分支返回。

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
