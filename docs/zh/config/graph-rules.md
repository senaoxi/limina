# 图规则

图规则按源码 `tsconfig*.json` 中声明的标签匹配。Limina 会把这些标签带到对应的生成构建配置里，并在图检查时用它们判断哪些引用或依赖不允许出现。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    rules: {
      'runtime-client': {
        deny: {
          refs: [
            {
              path: 'packages/app/src/node/tsconfig.lib.json',
              reason: '客户端运行时不得依赖 Node 运行时',
            },
          ],
          deps: [
            {
              name: 'node:*',
              reason: '浏览器产物不得包含 Node 内置模块',
            },
            {
              name: '@acme/internal-node',
              reason: '浏览器产物不得消费仅适用于 Node 的包',
            },
          ],
        },
        allow: {
          refs: [
            {
              path: 'packages/app/src/generated/tsconfig.lib.json',
              reason: '生成声明由构建流水线连接',
            },
          ],
        },
      },
    },
  },
});
```

## `rules.<label>`

- **类型：** `Record<string, GraphRule>`

每个 `rules` 键名对应一个标签。源码配置在 `liminaOptions.graphRules` 中列出该标签时，才使用它的规则；同一配置可以列出多个标签并使用各自匹配的规则。未使用的标签不作用于任何源码配置。

配合源码配置中的标签：

```jsonc
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "include": ["src/**/*.ts"],
}
```

这个配置覆盖的源码会套用 `graph.rules.runtime-client`。

## `allow.refs`

- **类型：** `Array<{ path: string; reason: string }>`

`allow.refs` 的条目形状和 `deny.refs` 相同，用来承认那些已经声明、但静态导入分析无法证明的额外 `references`。每个 `path` 都相对 `config.rootDir` 解析，必须能映射到可达的生成声明叶子；可填写原源码叶子路径，外部激活包可使用 `../`。聚合配置或未治理配置不是合法规则目标。它不会创建引用，也不会让被拒绝的引用合规；同一路径同时被 `allow` 和 `deny` 命中时，仍然以 `deny.refs` 为准。

生成引用会从源码导入和源码 `tsconfig` 上的 `liminaOptions.implicitRefs` 推导。字面量动态导入已经参与分析。计算后的运行时导入、生成清单或其他未被观察的代码形成明确声明构建关系时，使用 `implicitRefs` 补充；它不会新增模块解析器，也不会让不支持的虚拟模块变为可消费。`allow.refs` 只用于解释已经存在的额外声明引用。

## `deny.refs`

- **类型：** `Array<{ path: string; reason: string }>`

`deny.refs` 禁止当前标签的项目引用指向某个源码 `tsconfig` 对应的声明构建配置。它适合表达“客户端运行时不能依赖服务端运行时”“公开 `API` 不能依赖内部工具”这类项目边界。

例如规则里写了：

```jsonc
{
  "path": "packages/app/src/node/tsconfig.lib.json",
  "reason": "客户端运行时不得依赖 Node 运行时",
}
```

如果标记了 `runtime-client` 的项目在 `references` 里指向了这个仅 `Node` 源码配置对应的生成配置，`limina graph check` 会直接失败，并显示 `reason`。

示例目录和配置如下：

```text
packages/app/
  src/client/tsconfig.lib.json
  src/node/tsconfig.lib.json
  src/client/main.ts
  src/node/read-file.ts
```

客户端源码配置标记为 `runtime-client`：

```jsonc
// packages/app/src/client/tsconfig.lib.json
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "include": ["main.ts"],
}
```

运行 `pnpm exec limina graph check` 时，Limina 会把源码提供者关系与 `graph.rules.runtime-client.deny.refs` 对比，同时检查实际项目引用。引用推断会从生成配置中省略被禁止的导入推导引用；省略引用不会让该源码导入合规。

需要 Node 叶子配置的客户端导入会被报告为图访问遭拒，并显示配置中的 `reason`。应处理源码关系或规则，而不是修改生成文件。

## `deny.deps`

- **类型：** `Array<{ name: string; reason: string }>`

`deny.deps` 禁止源码导入某些包、`#imports` 或 `Node` 内置模块。`name` 可以是包名、`#subpath`（例如 `#server/*`）、`fs`、`node:fs`，也可以用 `node:*` 匹配所有 `Node` 内置模块。

如果这个标签覆盖的源码写了：

```ts
// packages/app/src/client/load.ts
import { readFileSync } from 'node:fs';
import { createServerClient } from '@acme/internal-node';
```

`limina graph check` 会按 `runtime-client` 规则命中 `node:*` 和 `@acme/internal-node`，并显示规则里的 `reason`。

对应的目录可以是：

```text
packages/app/
  src/client/tsconfig.lib.json
  src/client/load.ts
packages/internal-node/
  src/index.ts
```

模块里出现了被禁止的导入：

```ts
// packages/app/src/client/load.ts
import { readFileSync } from 'node:fs';
import { createServerClient } from '@acme/internal-node';
```

运行 `pnpm exec limina graph check` 时，Limina 会用 `TypeScript` 解析 `src/client/load.ts` 中的导入。因为这个文件属于配置了 `liminaOptions.graphRules: ["runtime-client"]` 的叶子，Limina 会把解析到的说明符和 `deny.deps` 对比：`node:fs` 命中 `node:*`，`@acme/internal-node` 命中同名包规则。

图检查会失败，并显示每条命中规则的 `reason`。
