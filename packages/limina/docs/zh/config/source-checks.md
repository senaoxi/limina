# 源码检查

::: warning
本页描述顶层 `source` 选项，也就是 `source:check` 运行的 **Knip 驱动依赖和模块可达性检查**。它不同于 `config.source`，后者定义 proof coverage 使用的治理文件边界。`config.source` 见 [源码边界](./source-boundary.md)。
:::

`source check` 负责包权限和普通 typecheck 归属检查。未使用工作区依赖分支由 Knip 驱动，使用包入口而不是 `include` / `exclude`。在 `strict: true` 下，`source check` 还会让 Knip 基于 Limina 的包归属模块集合报告未使用源码模块。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  strict: true,
  source: {
    knip: {
      workspaces: {},
    },
    tsconfigOwnership: { ignore: [] },
  },
});
```

## knip

- **类型：** `boolean | SourceKnipCheckConfig`
- **默认值：** `true`

`source.knip` 控制 `source:check` 中由 Knip 驱动的部分：未使用工作区依赖，以及 `strict: true` 下的未使用源码模块。

省略该选项或写 `knip: true` 时，Limina 使用自动生成的默认 Knip 配置。写 `knip: false` 时，会跳过这些 Knip 驱动的检查。对象形式表示按工作区包名配置 Limina 语义 Knip 规则：

```ts
interface SourceKnipEntryConfig {
  files: string[];
  reason: string;
}

interface SourceKnipIgnoredDependencyConfig {
  dep: string;
  reason: string;
}

interface SourceKnipIgnoredFileConfig {
  file: string;
  reason: string;
}

interface SourceKnipWorkspaceConfig {
  entry?: SourceKnipEntryConfig[];
  ignoreDependencies?: SourceKnipIgnoredDependencyConfig[];
  ignoreFiles?: SourceKnipIgnoredFileConfig[];
}

interface SourceKnipCheckConfig {
  workspaces?: Record<string, SourceKnipWorkspaceConfig>;
}
```

`source.knip.workspaces` 的 key 是 pnpm workspace 中发现的包名，例如 `@acme/app`。如果 key 对应不到工作区包名，`source check` 会直接失败。

::: warning
`knip` 是 Limina 的 optional peer dependency。如果启用了 `source.knip`，但运行 Limina 的工作区没有安装 `knip`，`source check` 会直接报缺失 peer dependency。
:::

Limina 会为受治理的 owner workspace 写入 `entry: []`，从而关闭 Knip 隐式的 `index` / `main` / `cli` 入口猜测。默认可达性仍然包含 package manifest 入口（`exports`、`main`、`module`、`browser`、`bin`、`types`、`typings`）、Knip 插件推断入口、package scripts，以及 Limina 为 application-style owner 生成的 virtual entries。

当一个工作区根部存在 `tsconfig.build.json` 时，Limina 还会让 Knip 用这个文件作为该工作区的 TypeScript 建图入口。它的作用不是额外声明“哪些源码是入口”，而是告诉 Knip：如果 package manifest 暴露的是构建产物，应该怎样从 `dist` 产物路径反推回源码路径。

这是一种通用的包设计方式：`package.json` 面向消费者，只暴露构建后的 `dist` 文件；`tsconfig.build.json` 面向工具，记录构建图，让 Knip 能从产物入口回到源码入口。例如 `@docs-islands/utils` 可以只写：

```json
{
  "exports": {
    "./env": "./dist/src/env.js"
  }
}
```

同时让 `utils/tsconfig.build.json` 引用会产出 `dist` 的构建配置：

```json
{
  "files": [],
  "references": [
    {
      "path": "./tsconfig.lib.dts.json"
    }
  ]
}
```

只要被引用的配置能说明源码目录和输出目录（例如 `rootDir: "."`、`outDir: "./dist"`），Knip 就能把 `utils/dist/src/env.js` 反推成 `utils/src/env.ts`。这样源码模块虽然没有出现在 `exports.source` 里，也仍然会被视为从包入口可达。

反过来，如果 `tsconfig.build.json` 没有通过 `references` 引到真正产出 `dist` 的配置，或者被引用配置没有清楚说明 `outDir` / `rootDir`，Knip 只能看到 `dist` 入口，看不到对应的源码模块。在 `strict: true` 下，这类源码文件可能会被报告为未使用模块。遇到这种情况，优先修正构建引用图，而不是为了让 Knip 通过而给 `package.json` 补一份只给工具看的 `source` 条件。

Knip 的 `project` 文件集合也由 Limina 根据受治理源码模块自动确定；用户不配置 `project`。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  strict: true,
  source: {
    knip: {
      workspaces: {
        '@acme/app': {
          entry: [
            {
              files: ['packages/app/src/**/*.spec.ts'],
              reason: 'Vitest 会直接加载 spec 模块。',
            },
          ],
          ignoreDependencies: [
            {
              dep: '@acme/runtime',
              reason: '由入口图之外的生成代码加载。',
            },
          ],
          ignoreFiles: [
            {
              file: 'packages/app/src/generated/runtime.ts',
              reason: '框架会加载这个生成 runtime 模块。',
            },
          ],
        },
      },
    },
  },
});
```

### workspaces[pkg].entry

- **类型：** `Array<{ files: string[]; reason: string }>`

`entry` 用于声明包内合法的直接源码入口，但这些入口不应该成为 package exports。例如测试运行器可能会直接加载 `*.spec.ts` 文件。

entry 配置必须使用正向的、工作区根相对的 glob，且必须位于 key 指向的包目录内，并提供非空 reason。

### workspaces[pkg].ignoreDependencies

- **类型：** `Array<{ dep: string; reason: string }>`

`source check` 会验证 `package.json` 中声明的工作区依赖能从导入方包的公开入口图触达。这个规则适用于每个工作区包，包括 workspace root。

如果依赖确实由生成代码、运行时字符串或 Knip 看不见的路径使用，可以在导入方包名 key 下添加 ignore entry。

ignore entry 的 `dep` 必须是已存在的工作区包，并且这个依赖关系仍然声明在 key 指向的 importer package manifest 中。确实需要保留时，把 reason 写在配置旁；不再需要时，应该删除依赖。

### workspaces[pkg].ignoreFiles

- **类型：** `Array<{ file: string; reason: string }>`

::: info
这是 `strict: true` 功能。`source check` 会在 `strict: true` 时自动启用未使用源码模块检测。
:::

`ignoreFiles` 只用于 strict 模式下确实要保留、但 Knip 看不见的源码模块。

ignore entry 必须使用工作区根相对文件路径，路径必须留在仓库内，并提供非空 reason。该文件还必须属于 key 指向的包的 Limina 已知源码模块集合。

## tsconfigOwnership.ignore

- **类型：** `Array<{ owner: string; files: string[]; reason: string }>`

`source check` 要求每个受治理模块最近的裸 `tsconfig.json` 能识别唯一普通 typecheck owner。最近的 `tsconfig.json` 可以直接 include 该模块，也可以通过传递 `references` 到达唯一普通 typecheck config。

Limina 在这个搜索里只跟随普通 typecheck config，不会把 `tsconfig*.dts.json`、`tsconfig*.build.json`、`tsconfig*.base.json`、`tsconfig*.check.json` 当作归属配置。

测试和 fixture 可能由工具以不符合本地 tsconfig 形状的方式加载。此时可以继续治理这些模块，但只对归属规则做局部豁免：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: {
    tsconfigOwnership: {
      ignore: [
        {
          owner: '@acme/app',
          files: ['packages/app/src/**/*.spec.ts'],
          reason: 'Vitest 会直接加载测试模块。',
        },
      ],
    },
  },
});
```

ignore entry 必须使用具名包 owner、位于该 owner 目录内的正向工作区根相对 glob，并提供非空 reason。它只跳过最近 `tsconfig.json` 归属解析；包归属、导入权限、proof coverage 和未使用模块检查仍会运行。
