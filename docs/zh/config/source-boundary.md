# 源码边界

`config.source` 选择被治理的源码文件。`proof check` 将这个集合与检查器入口、生成图项目和允许清单比较，找出遗漏文件或不一致的覆盖范围。顶层 `source` 则配置导入授权、环境声明和可选 Knip 检查，见[源码检查](./source-checks.md)。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    source: {
      include: ['...', 'packages/**/src/**/*.vue'],
      exclude: ['...', 'packages/**/src/generated/**'],
    },
  },
});
```

## `include`

- **类型：** `string[]`

`include` 是 Limina 需要检查的全局源码通配模式集合。显式 `include` 和 `exclude` 都必须是非空字符串数组，每个数组最多使用一次 `...`。省略时，Limina 使用默认 TypeScript 源码通配模式集合；显式配置后会替换默认集合。可以在需要展开默认集合的位置使用精确字符串 `...`。

模式相对于 `config.rootDir`，可以包含 `../`。它们只过滤每个已激活包的独立治理范围（包治理单元）已经发现的源码候选；模式不能让未激活目录或仅对所属包生效的边界变得可见。默认发现同样会针对外部激活包运行。

::: details 默认 `include` 通配模式集合
`**/*.ts`、`**/*.tsx`、`**/*.d.ts`、`**/*.cts`、`**/*.d.cts`、`**/*.mts` 和 `**/*.d.mts`。
:::

检查器扩展不会自动加入。如果希望默认 TypeScript 源码和 `packages/**/src` 下的 `Vue` 文件都进入治理，应展开默认集合并显式加入 Vue 通配模式。之后新增的匹配文件会自动进入源码和覆盖证明检查范围。

## `exclude`

- **类型：** `string[]`

`exclude` 是不进入被治理源码集合的目录或通配模式。它适合排除测试夹具、生成缓存和其他不应作为被检查源码的文件。省略时，Limina 使用默认排除集合。

显式配置 `exclude` 会替换默认排除集合，并且不再使用根 `.gitignore`。可以在需要展开默认排除集合（包括根 `.gitignore`）的位置使用精确字符串 `...`。显式数组如果没有 `...`，会关闭默认文件过滤集合；结构区域边界、固定发现忽略和已验证输出根仍会限制候选集合。根 `.gitignore` 只应用于 `config.rootDir` 内的候选文件，绝不会过滤外部激活包的候选文件。

::: details 默认排除集合
`node_modules`、`bower_components`、`jspm_packages`、来自 `package.entries` 和当前可见 `liminaOptions.outputs` 声明的已验证输出根，以及只用于 `config.rootDir` 内候选文件的根 `.gitignore`。
:::

声明 `liminaOptions.outputs: {}` 就会把相对该源码配置的 `./dist` 作为输出根；显式 `outDir` 会改用指定路径。没有 `outputs` 声明或包条目输出时，Limina 不会仅因目录名为 `dist` 就推断输出。输出路径只作用于声明它的配置或包条目，不会扩展成全局同名目录排除。

`liminaOptions.outputs.outDir` 相对于声明它的源码配置。Limina 只从结构可达、且尚未位于无条件包条目输出内的 `tsconfig` 读取它；在稳定的工作区输出计算中，该 `tsconfig` 保持可见时，声明才继续生效。

## 排除文件时要同步检查 `tsconfig`

`config.source.exclude` 只改变 Limina 的源码治理集合，不会改写检查器的 `files`、`include` 或导入后纳入的文件。若检查器或生成图仍覆盖这些文件，`proof check` 可以报告 `LIMINA_PROOF_SOURCE_BOUNDARY_MISMATCH`：两边描述的文件集合不同。

例如，`packages/core/src/generated/runtime.ts` 被源码边界排除，但仍在 `tsconfig.lib.json` 的有效文件集合中，单独添加排除项并不能解决覆盖问题。应按文件的实际用途选择：

- 它属于项目源码：保留在 `config.source` 中，并让一个源码叶子配置拥有它。
- 它不属于本次治理：同时调整相关 `tsconfig` 的覆盖范围；还需留意导入是否会把它重新带入检查器。
- 它留在治理范围内，却有意没有普通覆盖：使用带原因的[覆盖证明允许清单](./proof-allowlist.md)。

覆盖允许清单只解释未覆盖文件，不用来消除边界外仍有检查器覆盖的问题。
