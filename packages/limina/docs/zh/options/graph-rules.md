# Graph rules

Graph rules 按 `tsconfig*.dts.json` 中声明的 label 匹配。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    rules: {
      'runtime-client': {
        deny: {
          refs: [
            {
              path: 'packages/app/src/node/tsconfig.lib.dts.json',
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
              path: 'packages/app/src/generated/tsconfig.lib.dts.json',
              reason: 'generated declarations are wired by the build pipeline',
            },
          ],
        },
      },
    },
  },
});
```

## `rules.<label>`

`rules` 的 key 必须和 declaration leaf 里的 `liminaOptions.graphRules` 项对上。一个 leaf 可以列出多个 label，Limina 会合并这些 label 对应的规则。

配合 declaration leaf 中的 labels：

```jsonc
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "extends": ["./tsconfig.lib.json"],
  "references": [],
}
```

这个 leaf 覆盖的源码会套用 `graph.rules.runtime-client`。

## `deny.refs`

`deny.refs` 禁止当前 label 的 project reference 到指定 declaration leaf。它适合表达“client runtime 不能依赖 server runtime”“public API 不能依赖 internal tools”这类项目边界。

例如规则里写了：

```jsonc
{
  "path": "packages/app/src/node/tsconfig.lib.dts.json",
  "reason": "client runtime must not depend on Node runtime",
}
```

如果 `runtime-client` leaf 在 `references` 里指向了这个 Node-only leaf，`limina graph check` 会直接失败，并显示 `reason`。

完整一点看，它对应这样的目录和配置：

```text
packages/app/
  src/client/tsconfig.lib.dts.json
  src/node/tsconfig.lib.dts.json
  src/client/main.ts
  src/node/read-file.ts
```

client leaf 标记为 `runtime-client`，但错误地 reference 了 Node leaf：

```jsonc
// packages/app/src/client/tsconfig.lib.dts.json
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "extends": ["./tsconfig.lib.json"],
  "references": [
    {
      "path": "../node/tsconfig.lib.dts.json",
    },
  ],
}
```

运行 `pnpm exec limina graph check` 时，Limina 会先从 checker entry 找到可达的 declaration leaves，再读取每个 leaf 的 `references`。当它看到 `runtime-client` leaf reference 到 `packages/app/src/node/tsconfig.lib.dts.json` 时，会拿这条 reference 和 `graph.rules.runtime-client.deny.refs` 对比。

结果是 graph check 失败，并提示这条 project reference 命中了禁止规则。这个结果说明问题不只是某个 import 写错，而是 TypeScript graph 里已经把 client runtime 和 Node runtime 建成了依赖关系。

## `allow.refs`

`allow.refs` 的 entry 形状和 `deny.refs` 相同，但它只用于允许那些静态 import 分析无法证明、却确实需要保留的额外 `references`。它不会让被 deny 的 reference 合规；同一路径同时被 allow 和 deny 时，仍然以 `deny.refs` 为准。

`limina graph sync` 只会保留当前已经声明、并且命中合并后 `allow.refs` 的额外 references；不会因为 allow 里有一项就主动新增未使用的 reference。

## `deny.deps`

`deny.deps` 禁止源码 import 某些 package、`#imports` 或 Node builtin。`name` 可以是 package name、`#server/*`、`fs`、`node:fs`，也可以用 `node:*` 匹配所有 Node builtin。

如果这个 leaf 覆盖的源码写了：

```ts
// packages/app/src/client/load.ts
import { readFileSync } from 'node:fs';
import { createServerClient } from '@acme/internal-node';
```

`limina graph check` 会按 `runtime-client` 规则命中 `node:*` 和 `@acme/internal-node`，并显示规则里的 reason。这样 browser/runtime 边界不是靠口头约定，而是由配置和源码 import 一起验证。

对应的目录可以是：

```text
packages/app/
  src/client/tsconfig.lib.dts.json
  src/client/load.ts
packages/internal-node/
  src/index.ts
```

模块里出现了被禁止的 import：

```ts
// packages/app/src/client/load.ts
import { readFileSync } from 'node:fs';
import { createServerClient } from '@acme/internal-node';
```

运行 `pnpm exec limina graph check` 时，Limina 会用 TypeScript 解析 `src/client/load.ts` 中的 import。因为这个文件属于配置了 `liminaOptions.graphRules: ["runtime-client"]` 的 leaf，Limina 会把解析到的 specifier 和 `deny.deps` 对比：`node:fs` 命中 `node:*`，`@acme/internal-node` 命中同名 package rule。

结果是 graph check 失败，并显示每条命中规则的 `reason`。这能让 reviewer 直接看到“browser runtime 引入了 Node-only 能力”，而不需要自己推断这些 import 会不会在浏览器里出问题。
