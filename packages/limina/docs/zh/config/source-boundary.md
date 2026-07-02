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
      include: ['packages/**/src/**/*.{ts,tsx,vue}'],
      exclude: ['node_modules', 'dist', '.tsbuild', 'coverage'],
    },
  },
});
```

## include

- **类型：** `string[]`

`include` 是 Limina 需要检查的全局源码 `glob`。省略时，Limina 会先使用一组基础源码范围，再根据当前检查器补充 `**/*.vue` 或 `**/*.svelte` 等框架扩展，最后应用默认排除列表。

::: details 默认 include glob 集合
`**/*.ts`、`**/*.d.ts`、`**/*.tsx`、`**/*.cts`、`**/*.d.cts`、`**/*.mts`、`**/*.d.mts`、`**/*.mjs` 和 `**/*.json`。
:::

如果你希望 `packages/**/src` 下的 `TypeScript`、`TSX` 和 `Vue` 文件都进入治理，就把它们写进 `include`。之后新增文件会自动进入源码和覆盖证明检查范围。

```js
export default defineConfig({
  config: {
    source: {
      include: ['packages/**/src/**/*.{ts,tsx,vue}'],
    },
  },
});
```

## exclude

- **类型：** `string[]`

`exclude` 是不需要进入源码治理的目录或 `glob`。它适合排除 `dist`、`.tsbuild`、测试夹具、生成缓存等不应该当作源码治理的内容。省略 `exclude` 时，Limina 会读取工作区根目录的 `.gitignore`，并且始终额外排除一组固定的目录和配置文件。

::: details 始终额外排除的条目（在 root `.gitignore` 之外）
`TypeScript` 配置文件、常见任务工具配置/缓存文件、`dist`、`.git`、`.tsbuild`、`coverage` 和 `node_modules`。
:::

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
