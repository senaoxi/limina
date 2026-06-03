# Source coverage

Source settings 定义 Limina 用于 coverage proof 的全局源码边界。`proof check` 会用这条边界判断哪些文件必须被 checker entries 或 allowlist 覆盖。`source check` 另外负责 package authority 和 ordinary typecheck ownership；其中 unused workspace dependency 分支由 Knip 接管，使用 package entries，而不是 `include` / `exclude`。在 `strict: true` 下，`source check` 还会把 Limina 已知的 package owner module set 交给 Knip，用来报告 unused source modules。

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

`include` 是 Limina 需要检查的全局源码 glob。省略时，Limina 会先使用 `**/*.ts`、`**/*.d.ts`、`**/*.tsx`、`**/*.cts`、`**/*.d.cts`、`**/*.mts`、`**/*.d.mts`、`**/*.mjs` 和 `**/*.json` 这组基础源码范围，再根据 active checkers 补充 `**/*.vue` 或 `**/*.svelte` 等框架扩展，最后应用默认 exclude list。

如果你希望 `packages/**/src` 下的 TypeScript、TSX 和 Vue 文件都进入治理，就把它们写进 `include`。之后新增文件会自动进入 source 和 proof checks 的检查范围。

## `exclude`

`exclude` 是不需要进入源码治理的目录或 glob。它适合排除 `dist`、`.tsbuild`、fixtures、生成缓存等不应该当作源码治理的内容。省略 `exclude` 时，Limina 会读取 workspace root 的 `.gitignore`，并且始终额外排除 `nx.json`、`project.json`、`tsconfig.json`、`**/tsconfig.*.json`、`dist`、`.nx`、`.git`、`.tsbuild`、`coverage` 和 `node_modules`。

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

`source check` 会验证 `package.json` 中声明的 workspace package 是否能从 importer package 的公开入口图触达。这个规则会检查每个 workspace package，包括 workspace root。

Limina 会把这部分 unused dependency 分析交给 Knip。它会扫描 `dependencies`、`devDependencies`、`peerDependencies` 和 `optionalDependencies` 中的依赖名。只要依赖名匹配 pnpm workspace 中的 package，Limina 就期待 Knip 能证明这条依赖可以从 source-facing `exports`、package `bin`、scripts，或 Knip 支持的工具 / plugin 入口触达。

因为源码 manifest 的最佳实践是直接暴露源码入口，这些 exports 会天然成为 Knip entries。如果某个 package owner 没有 `package.json#exports` 字段，Limina 会把它视为应用型 owner：临时生成一个 Knip entry，导入这个 package.json 管辖的完整 source module 集合，因此任意被该 package.json 管辖的模块都可以证明 dependency 使用。对于有 exports 的 package owner，只出现在不可达 dead file 里的 import 不再能证明依赖被使用；在 strict mode 下，这个 dead file 本身也会被报告为 unused source module。与此同时，`source check` 仍会校验 ordinary typecheck config 的 owner：也就是排除 `tsconfig*.dts.json`、`tsconfig*.build.json`、`tsconfig*.base.json` 和 `tsconfig*.check.json` 后剩余的 `tsconfig*.json`。

对于生成代码、运行时字符串，或其他 Knip 无法看见的真实使用，可以添加 ignore entry：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: {
    unusedDependencies: {
      ignore: [
        {
          importer: '@acme/app',
          dependency: '@acme/runtime',
          reason: 'Loaded by generated code outside the entry-reachable graph.',
        },
      ],
    },
  },
});
```

ignore entry 必须指向已存在的 workspace package，并且这对 importer/dependency 仍然要在 importer 的 package manifest 中声明。如果这个依赖是有意保留的，就把原因留在配置旁边；如果它已经不需要了，应直接删除依赖声明。

## `additionalEntries`

`source check` 会为 package-owned source modules 建立 entry-reachable graph。对于带有 `package.json#exports` 的 owner，默认入口来自 package `exports`、`bin`、scripts，以及 Knip 支持的 plugin entries。

对于没有 `package.json#exports` 的 package owner，Limina 会把完整的被治理 source module 集合视为应用型入口面。它会为 dependency 分析生成临时 entry，并跳过该 owner 的 unused-file 覆盖检查，因为这些已知 source module 都被视为应用入口面的一部分。

有些 source module 是合法入口，但不应该暴露成 package export。比如测试 runner 会直接加载 `*.spec.ts` 文件。此时可以通过 `source.additionalEntries` 为测试 runner、本地工具或构建步骤追加 owner-scoped globs：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  strict: true,
  source: {
    additionalEntries: [
      {
        owner: '@acme/app',
        files: ['packages/app/src/**/*.spec.ts'],
        reason: 'Vitest loads spec modules directly.',
      },
    ],
  },
});
```

additional entry config 必须使用具名 package owner；`files` 必须是正向的 workspace-root-relative glob，并且位于该 owner package 目录内；`reason` 必须是非空字符串。

## `unusedModules.ignore`

`source check` 会在 `strict: true` 时自动启用 unused source module 检测。只有当 strict-mode source module 确实需要保留，但 Knip 无法看见它的使用时，才添加 ignore entry：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  strict: true,
  source: {
    unusedModules: {
      ignore: [
        {
          owner: '@acme/app',
          file: 'packages/app/src/generated/runtime.ts',
          reason: 'Generated runtime module loaded by the framework.',
        },
      ],
    },
  },
});
```

ignore entry 必须使用具名 package owner、workspace-root-relative file path，并且解析后仍在 repo root 内；同时 `reason` 必须是非空字符串。这个文件也必须确实属于 Limina 已知的该 owner source module set。
