# Source coverage

Source settings 定义 Limina 的全局源码边界。`source check` 会用这条边界做 source-owned validations，`proof check` 也使用同一条边界做 coverage proof。

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

`include` 是 Limina 需要检查的全局源码 glob。省略时，Limina 会从 active checker extensions 推导源码文件，再应用默认 exclude list。

如果你希望 `packages/**/src` 下的 TypeScript、TSX 和 Vue 文件都进入治理，就把它们写进 `include`。之后新增文件会自动进入 source 和 proof checks 的检查范围。

## `exclude`

`exclude` 是不需要进入源码治理的目录或 glob。它适合排除 `dist`、`.tsbuild`、fixtures、生成缓存等不应该当作源码治理的内容。

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

`config.source.include` 覆盖了 `packages/**/src/**/*.{ts,tsx,vue}`，所以 `src/generated/runtime.ts` 会被视为被治理源码。运行 `pnpm exec limina proof check` 时，Limina 会收集 include 命中的源码文件，再检查它们是否被 graph project、checker entry 或 `proof.allowlist` 覆盖。

如果 `runtime.ts` 没有被任何 checker 覆盖，结果是 proof check 失败，并把这个文件列为 uncovered source。若它其实是 fixture 或缓存，就把对应目录写进 `exclude`；若它是有意例外，就写进 `proof.allowlist` 并说明原因。

## `unusedDependencies.ignore`

`source check` 会验证 `package.json` 中声明的 workspace package 是否真的被这个 package 自己的源码使用。这个规则会检查每个 workspace package，包括 workspace root。

Limina 会扫描 `dependencies`、`devDependencies`、`peerDependencies` 和 `optionalDependencies` 中的依赖名。只要依赖名匹配 pnpm workspace 中的 package，Limina 就期待 importer package 的归属源码里出现静态 import，例如 `import`、`export ... from`、`import type` 或 dynamic `import()`。

源码范围来自全局 `config.source.include` / `config.source.exclude` 边界。每个命中的源码文件归属离它最近的 `package.json`，workspace dependency usage 也只从 importer package 自己拥有的源码里统计。与此同时，`source check` 会校验 ordinary typecheck config 的 owner：也就是排除 `tsconfig*.dts.json`、`tsconfig*.build.json`、`tsconfig*.base.json` 和 `tsconfig*.check.json` 后剩余的 `tsconfig*.json`。

对于生成代码、配置文件、脚本或运行时字符串等静态 import 分析看不到的真实使用，可以添加 ignore entry：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    source: {
      unusedDependencies: {
        ignore: [
          {
            importer: '@acme/app',
            dependency: '@acme/runtime',
            reason: 'Loaded by generated code outside static source imports.',
          },
        ],
      },
    },
  },
});
```

ignore entry 必须指向已存在的 workspace package，并且这对 importer/dependency 仍然要在 importer 的 package manifest 中声明。如果这个依赖是有意保留的，就把原因留在配置旁边；如果它已经不需要了，应直接删除依赖声明。
