# 源码边界

::: warning
`config.source` 定义被治理文件的边界，覆盖证明会用它判断哪些文件必须被检查器入口或允许清单覆盖。它不同于顶层 `source` 选项，后者配置源码导入授权和 `Knip` 驱动的源码使用检查。关于那个选项，请参见[源码检查](./source-checks.md)。
:::

`config.source` 定义 Limina 用于覆盖证明的全局源码边界。`proof check` 会用这条边界判断哪些文件必须被检查器入口或允许清单覆盖。

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

## include

- **类型：** `string[]`

`include` 是 Limina 需要检查的全局源码 `glob` 集合。省略时，Limina 使用默认 TypeScript 源码 glob 集合；显式配置后会替换默认集合。可以在需要展开默认集合的位置使用精确字符串 `...`。

模式相对于 `config.rootDir`，可以包含 `../`。它们只过滤每个激活 package island 已经发现的源码 candidate；模式不能让未激活目录或 owner-local 边界变得可见。默认发现同样会针对外部激活包运行。

::: details 默认 include glob 集合
`**/*.ts`、`**/*.tsx`、`**/*.d.ts`、`**/*.cts`、`**/*.d.cts`、`**/*.mts` 和 `**/*.d.mts`。
:::

检查器扩展不会自动加入。如果希望默认 TypeScript 源码和 `packages/**/src` 下的 `Vue` 文件都进入治理，应展开默认集合并显式加入 `Vue` glob。之后新增的匹配文件会自动进入源码和覆盖证明检查范围。

```js
export default defineConfig({
  config: {
    source: {
      include: ['...', 'packages/**/src/**/*.vue'],
    },
  },
});
```

## exclude

- **类型：** `string[]`

`exclude` 是不进入被治理源码集合的目录或 `glob`。它适合排除 fixture、生成缓存和其他不应作为被检查源码的文件。省略时，Limina 使用默认排除集合。

显式配置 `exclude` 会替换默认排除集合，并且不再使用根 `.gitignore`。可以在需要展开默认排除集合（包括根 `.gitignore`）的位置使用精确字符串 `...`。显式数组如果没有 `...`，会关闭所有默认排除项。根 `.gitignore` 只应用于 `config.rootDir` 内的 candidate，绝不会过滤外部激活包的 candidate。

::: details 默认排除集合
`node_modules`、`bower_components`、`jspm_packages`、当前可见源码配置显式声明的 `liminaOptions.outputs.outDir` 路径，以及只用于 `config.rootDir` 内 candidate 的根 `.gitignore`。
:::

只有显式声明的 `liminaOptions.outputs.outDir` 会进入这个集合。源码配置没有声明时，Limina 不会推断 `./dist`；一个配置声明的输出目录名也不会扩展成全局同名目录排除。

`liminaOptions.outputs.outDir` 相对于声明它的源码配置。Limina 只从结构可达、且尚未位于无条件包条目输出内的 `tsconfig` 读取它；在稳定的工作区输出计算中，该 `tsconfig` 保持可见时，声明才继续生效。

例如 `include` 覆盖了 `packages/**/src/**/*.{ts,tsx,vue}` 后，新增这个文件：

```ts
// packages/core/src/generated/runtime.ts
export const runtimeName = 'core';
```

如果它没有被检查器入口可达的项目覆盖，也没有写进 `proof.allowlist`，`limina proof check` 会把它当作未覆盖源码报告出来。相反，如果某类测试夹具不应该进入治理范围，就应该用 `exclude` 明确排除，而不是让它偶然逃过检查。

完整一点看，目录可以是：

```text
packages/core/
  src/index.ts
  src/generated/runtime.ts
  tsconfig.lib.json
```

`config.source.include` 覆盖了 `packages/**/src/**/*.{ts,tsx,vue}`，所以 `src/generated/runtime.ts` 会被视为被治理源码。运行 `pnpm exec limina proof check` 时，Limina 会收集 `include` 命中的源码文件，再检查它们是否被图项目、检查器入口或 `proof.allowlist` 覆盖。

如果 `runtime.ts` 没有被任何检查器覆盖，结果是覆盖证明检查失败，并把这个文件列为未覆盖源码。若它其实是测试夹具或缓存，就把对应目录写进 `exclude`；若它是有意例外，就写进 `proof.allowlist` 并说明原因。
