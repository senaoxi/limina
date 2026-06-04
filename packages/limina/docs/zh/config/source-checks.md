# 源码检查

::: warning
本页介绍顶层 `source` 选项 —— 由 `source:check` 运行的、Knip 驱动的依赖和模块可达性检查。它不同于 `config.source`，后者定义的是覆盖证明使用的被治理文件边界。关于那个选项，请参见[源码边界](./source-boundary.md)。
:::

`source check` 负责包授权和普通类型检查归属。其中未使用工作区依赖分支由 Knip 接管，使用包条目，而不是 `include` / `exclude`。在 `strict: true` 下，`source check` 还会把 Limina 已知的包归属方模块集合交给 Knip，用来报告未使用源码模块。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  strict: true,
  source: {
    additionalEntries: [],
    unusedDependencies: { ignore: [] },
    unusedModules: { ignore: [] },
  },
});
```

## additionalEntries

- **类型：** `Array<{ owner: string; files: string[]; reason: string }>`

`source check` 会为包拥有的源码模块建立入口可达图。对于带有 `package.json#exports` 的归属方，默认入口来自包 `exports`、`bin`、scripts，以及 Knip 支持的插件入口。

对于没有 `package.json#exports` 的包归属方，Limina 会把完整的被治理源码模块集合视为应用型入口面。它会为依赖分析生成临时入口，并跳过该归属方的未使用文件覆盖检查，因为这些已知源码模块都被视为应用入口面的一部分。

有些源码模块是合法入口，但不应该暴露成包导出。比如测试运行器会直接加载 `*.spec.ts` 文件。此时可以通过 `source.additionalEntries` 为测试运行器、本地工具或构建步骤追加归属方范围内的 glob：

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

额外入口配置必须使用具名包归属方；`files` 必须是正向的工作区根目录相对 glob，并且位于该归属方包目录内；`reason` 必须是非空字符串。

## unusedDependencies.ignore

- **类型：** `Array<{ importer: string; dependency: string; reason: string }>`

`source check` 会验证 `package.json` 中声明的工作区包是否能从导入方包的公开入口图触达。这个规则会检查每个工作区包，包括工作区根目录。

Limina 会把这部分未使用依赖分析交给 Knip。它会扫描 `dependencies`、`devDependencies`、`peerDependencies` 和 `optionalDependencies` 中的依赖名。只要依赖名匹配 pnpm 工作区中的包，Limina 就期待 Knip 能证明这条依赖可以从包 `exports`、包 `bin`、scripts，或 Knip 支持的工具 / 插件入口触达。

对于有 `package.json#exports` 的包归属方，这些导出会成为 Knip 入口。如果某个包归属方没有 `package.json#exports` 字段，Limina 会把它视为应用型归属方：临时生成一个 Knip 入口，导入这个 package.json 管辖的完整源码模块集合，因此任意被该 package.json 管辖的模块都可以证明依赖使用。对于有导出的包归属方，只出现在不可达死文件里的导入不再能证明依赖被使用；在 strict 模式下，这个死文件本身也会被报告为未使用源码模块。与此同时，`source check` 仍会校验普通类型检查配置的归属方：也就是排除 `tsconfig*.dts.json`、`tsconfig*.build.json`、`tsconfig*.base.json` 和 `tsconfig*.check.json` 后剩余的 `tsconfig*.json`。

对于生成代码、运行时字符串，或其他 Knip 无法看见的真实使用，可以添加忽略条目：

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

忽略条目必须指向已存在的工作区包，并且这对 importer/dependency 仍然要在导入方的包清单中声明。如果这个依赖是有意保留的，就把原因留在配置旁边；如果它已经不需要了，应直接删除依赖声明。

## unusedModules.ignore

- **类型：** `Array<{ owner: string; file: string; reason: string }>`

::: info
这是一个 `strict: true` 特性。`source check` 会在 `strict: true` 时自动启用未使用源码模块检测。
:::

只有当 strict 模式下的源码模块确实需要保留，但 Knip 无法看见它的使用时，才添加忽略条目：

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

忽略条目必须使用具名包归属方、工作区根目录相对文件路径，并且解析后仍在仓库根目录内；同时 `reason` 必须是非空字符串。这个文件也必须确实属于 Limina 已知的该归属方源码模块集合。
