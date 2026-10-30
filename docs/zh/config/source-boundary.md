# 源码边界

`scope.source` 决定哪些文件需要纳入源码治理。`proof check` 会将这些文件与检查器入口、生成图和允许清单比较，找出没有得到预期覆盖的文件。导入授权、环境声明和可选的未使用代码检查则在 [`source`](./source-checks.md) 中配置。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  scope: {
    source: {
      include: ['...', 'packages/**/src/**/*.vue'],
    },
  },
});
```

## `include`

- **类型：** `string[]`

`include` 使用通配模式选择需要检查的源码文件。省略时，Limina 使用默认的 TypeScript 文件模式。显式配置会替换默认模式，如果还要保留默认项，可以像上例一样在数组中写 `...`。

`include` 和 `exclude` 都必须是非空字符串数组，且各自最多使用一次 `...`。

模式相对于 `config.rootDir`，可以包含 `../`。Limina 会分别发现每个已激活包中的源码候选，再用这些模式过滤结果，包括位于根目录之外的激活包。模式不能让未激活的目录进入治理范围，也不能跨越只对所属包生效的边界。

::: details 默认 `include` 通配模式集合
`**/*.ts`、`**/*.tsx`、`**/*.d.ts`、`**/*.cts`、`**/*.d.cts`、`**/*.mts` 和 `**/*.d.mts`。
:::

检查器支持的扩展名不会自动加入。如果希望默认 TypeScript 源码和 `packages/**/src` 下的 `.vue` 文件都进入治理，应像上例一样展开默认集合，并显式加入 Vue 文件的通配模式。之后新增的匹配文件也会进入源码和覆盖证明检查范围。

这个配置只改变 Limina 期望获得覆盖的文件。还需要让合适的 `tsconfig` 和兼容的检查器包含这些文件。Vue 的完整设置见[快速开始](../getting-started.md#使用-vue-astro-或-svelte)。

## `exclude`

- **类型：** `string[]`

`exclude` 是不进入被治理源码集合的目录或通配模式。它适合排除测试夹具、生成缓存和其他不应作为被检查源码的文件。省略时，Limina 使用默认排除集合。例如，只需要额外排除生成目录时：

`limina.config.mjs`：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  scope: {
    source: {
      exclude: ['...', 'packages/**/src/generated/**'],
    },
  },
});
```

显式配置 `exclude` 会替换默认排除集合。像上例一样保留 `...`，就能保留默认规则，包括根目录的 `.gitignore`。然后可以在数组中添加自己的排除模式。

没有 `...` 时，默认文件过滤集合不会展开。治理区域边界、固定发现忽略和已验证的输出目录仍然生效。根 `.gitignore` 只过滤 `config.rootDir` 内的候选文件，不过滤外部激活包的文件。

::: details 默认排除集合
`node_modules`、`bower_components`、`jspm_packages`、来自 `package.entries` 和当前可见 `liminaOptions.outputs` 声明的已验证输出根，以及只用于 `config.rootDir` 内候选文件的根 `.gitignore`。
:::

声明 `liminaOptions.outputs: {}` 就会把相对该源码配置的 `./dist` 作为输出根。显式填写 `outDir` 时则使用指定路径。没有 `outputs` 声明或包条目输出时，Limina 不会仅因目录名为 `dist` 就推断输出。输出路径只作用于声明它的配置或包条目，不会扩展成全局同名目录排除。

`liminaOptions.outputs.outDir` 相对于声明它的源码配置。Limina 只从结构可达、且尚未位于无条件包条目输出内的 `tsconfig` 读取它；在稳定的工作区输出计算中，该 `tsconfig` 保持可见时，声明才继续生效。

## 排除文件时要同步检查 `tsconfig`

`scope.source.exclude` 只改变 Limina 的源码治理集合，不会改写检查器的 `files`、`include` 或导入后纳入的文件。若检查器或生成图仍覆盖这些文件，`proof check` 可以报告 `LIMINA_PROOF_SOURCE_BOUNDARY_MISMATCH`：两边描述的文件集合不同。

例如，`packages/core/src/generated/runtime.ts` 被源码边界排除，但仍在 `tsconfig.lib.json` 的有效文件集合中，单独添加排除项并不能解决覆盖问题。应按文件的实际用途选择：

- 它属于项目源码：保留在 `scope.source` 中，并让一个源码叶子配置拥有它。
- 它不属于本次治理：同时调整相关 `tsconfig` 的覆盖范围，并留意导入是否会把它重新带入检查器。
- 它留在治理范围内，却有意没有普通覆盖：使用带原因的[覆盖证明允许清单](./proof-allowlist.md)。

覆盖允许清单只解释未覆盖文件，不用来消除边界外仍有检查器覆盖的问题。
