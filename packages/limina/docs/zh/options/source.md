# Source coverage

Source settings 定义哪些文件需要 proof coverage。

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

## `include`

`include` 是需要进入 proof coverage 的源码 glob。省略时，Limina 会从 active checker extensions 推导源码文件，再应用默认 exclude list。

如果你希望 `packages/**/src` 下的 TypeScript、TSX 和 Vue 文件都必须被 checker 覆盖，就把它们写进 `include`。之后新增文件会自动进入 `proof check` 的检查范围。

## `exclude`

`exclude` 是不需要进入 proof coverage 的目录或 glob。它适合排除 `dist`、`.tsbuild`、fixtures、生成缓存等不应该当作源码治理的内容。

例如 `include` 覆盖了 `packages/**/src/**/*.{ts,tsx,vue}` 后，新增这个文件：

```ts
// packages/core/src/generated/runtime.ts
export const runtimeName = 'core';
```

如果它没有被 checker entry 可达的 project 覆盖，也没有写进 `proof.allowlist`，`limina proof check` 会把它当作未覆盖源码报告出来。相反，如果某类 fixture 不应该进入治理范围，就应该用 `exclude` 明确排除，而不是让它偶然逃过检查。

完整一点看，目录可以是：

```text
packages/core/
  src/index.ts
  src/generated/runtime.ts
  tsconfig.lib.dts.json
  tsconfig.lib.json
```

`config.source.include` 覆盖了 `packages/**/src/**/*.{ts,tsx,vue}`，所以 `src/generated/runtime.ts` 会被视为需要 proof coverage 的源码。运行 `pnpm exec limina proof check` 时，Limina 会收集 include 命中的源码文件，再检查它们是否被 graph project、checker entry 或 `proof.allowlist` 覆盖。

如果 `runtime.ts` 没有被任何 checker 覆盖，结果是 proof check 失败，并把这个文件列为 uncovered source。若它其实是 fixture 或缓存，就把对应目录写进 `exclude`；若它是有意例外，就写进 `proof.allowlist` 并说明原因。
