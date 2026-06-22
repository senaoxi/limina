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
              reason: 'client runtime must not depend on Node runtime',
            },
          ],
          deps: [
            {
              name: 'node:*',
              reason: 'browser output must stay free of Node builtins',
            },
            {
              name: '@acme/internal-node',
              reason: 'browser output must not consume Node-only packages',
            },
          ],
        },
        allow: {
          refs: [
            {
              path: 'packages/app/src/generated/tsconfig.lib.json',
              reason: 'generated declarations are wired by the build pipeline',
            },
          ],
        },
      },
    },
  },
});
```

## rules.\<label\>

- **类型：** `Record<string, GraphRule>`

`rules` 的 key 必须和源码 tsconfig 里的 `liminaOptions.graphRules` 项对上。一个源码配置可以列出多个标签，Limina 会合并这些标签对应的规则。

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

## allow.refs

- **类型：** `Array<{ path: string; reason: string }>`

`allow.refs` 的条目形状和 `deny.refs` 相同，但它只用于兼容那些已经声明、静态导入分析无法证明的额外 `references`。它不会创建引用，也不会让被拒绝的引用合规；同一路径同时被 allow 和 deny 时，仍然以 `deny.refs` 为准。

生成引用会从源码导入和源码 tsconfig 上的 `liminaOptions.implicitRefs` 推导。动态导入、生成清单或虚拟模块确实形成源码边，但静态分析看不到时，使用 `implicitRefs` 补边。`allow.refs` 只保留给已声明引用的兼容诊断。

## deny.refs

- **类型：** `Array<{ path: string; reason: string }>`

`deny.refs` 禁止当前标签的项目引用指向某个源码 tsconfig 对应的声明构建配置。它适合表达“客户端运行时不能依赖服务端运行时”“公开 API 不能依赖内部工具”这类项目边界。

例如规则里写了：

```jsonc
{
  "path": "packages/app/src/node/tsconfig.lib.json",
  "reason": "client runtime must not depend on Node runtime",
}
```

如果标记了 `runtime-client` 的项目在 `references` 里指向了这个仅 Node 源码配置对应的生成配置，`limina graph check` 会直接失败，并显示 `reason`。

完整一点看，它对应这样的目录和配置：

```text
packages/app/
  src/client/tsconfig.lib.json
  src/node/tsconfig.lib.json
  src/client/main.ts
  src/node/read-file.ts
```

客户端源码配置标记为 `runtime-client`；引用由 Limina 生成：

```jsonc
// packages/app/src/client/tsconfig.lib.json
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "include": ["main.ts"],
}
```

运行 `pnpm exec limina graph check` 时，Limina 会先 prepare 生成图，再读取相关项目的 `references`。当它看到标记了 `runtime-client` 的项目引用到 `packages/app/src/node/tsconfig.lib.json` 对应的生成配置时，会拿源码路径和 `graph.rules.runtime-client.deny.refs` 对比。

结果是图检查失败，并提示这条项目引用命中了禁止规则。这个结果说明问题不只是某个导入写错，而是 TypeScript 图里已经把客户端运行时和 Node 运行时建成了依赖关系。

## deny.deps

- **类型：** `Array<{ name: string; reason: string }>`

`deny.deps` 禁止源码导入某些包、`#imports` 或 Node 内置模块。`name` 可以是包名、`#subpath`（例如 `#server/*`）、`fs`、`node:fs`，也可以用 `node:*` 匹配所有 Node 内置模块。

如果这个标签覆盖的源码写了：

```ts
// packages/app/src/client/load.ts
import { readFileSync } from 'node:fs';
import { createServerClient } from '@acme/internal-node';
```

`limina graph check` 会按 `runtime-client` 规则命中 `node:*` 和 `@acme/internal-node`，并显示规则里的 `reason`。这样浏览器 / 运行时边界不是靠口头约定，而是由配置和源码导入一起验证。

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

运行 `pnpm exec limina graph check` 时，Limina 会用 TypeScript 解析 `src/client/load.ts` 中的导入。因为这个文件属于配置了 `liminaOptions.graphRules: ["runtime-client"]` 的叶子，Limina 会把解析到的说明符和 `deny.deps` 对比：`node:fs` 命中 `node:*`，`@acme/internal-node` 命中同名包规则。

结果是图检查失败，并显示每条命中规则的 `reason`。这能让评审者直接看到“浏览器运行时引入了仅 Node 能力”，而不需要自己推断这些导入会不会在浏览器里出问题。
