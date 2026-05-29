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
      },
    },
  },
});
```

## `rules.<label>`

`rules` 的 key 必须和 declaration leaf 里的 `limina` label 对上。只有带相同 label 的 `tsconfig*.dts.json` 会启用这条规则。

配合 declaration leaf 中的 label：

```jsonc
{
  "limina": "runtime-client",
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
  "limina": "runtime-client",
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

运行 `pnpm exec limina graph check` 时，Limina 会用 TypeScript 解析 `src/client/load.ts` 中的 import。因为这个文件属于带有 `"limina": "runtime-client"` 的 leaf，Limina 会把解析到的 specifier 和 `deny.deps` 对比：`node:fs` 命中 `node:*`，`@acme/internal-node` 命中同名 package rule。

结果是 graph check 失败，并显示每条命中规则的 `reason`。这能让 reviewer 直接看到“browser runtime 引入了 Node-only 能力”，而不需要自己推断这些 import 会不会在浏览器里出问题。

## `unusedWorkspaceDependencies.allowlist`

`graph check` 还会验证 `package.json` 中声明的 workspace package 是否真的被这个 package 自己的源码使用。这个规则会检查每个 workspace package，包括 workspace root。

Limina 会扫描 `dependencies`、`devDependencies`、`peerDependencies` 和 `optionalDependencies` 中的依赖名。只要依赖名匹配 pnpm workspace 中的 package，Limina 就期待 importer package 的归属源码里出现静态 import，例如 `import`、`export ... from`、`import type` 或 dynamic `import()`。

源码范围由 package 归属的 `tsconfig*.json` 决定。Limina 会排除 `tsconfig*.dts.json`、`tsconfig*.build.json`、`tsconfig*.base.json` 和 `tsconfig*.check.json`；剩下的每个 tsconfig 归属离它最近的 `package.json`。如果某个 tsconfig include 了另一个更近 package owner 的文件，graph check 会把它作为配置问题报告。

对于生成代码、配置文件、脚本或运行时字符串等静态 import 分析看不到的真实使用，可以添加 allowlist：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    unusedWorkspaceDependencies: {
      allowlist: [
        {
          importer: '@acme/app',
          dependency: '@acme/runtime',
          reason: 'Loaded by a Vite virtual module generated at build time.',
        },
      ],
    },
  },
});
```

allowlist entry 必须指向已存在的 workspace package，并且这对 importer/dependency 仍然要在 importer 的 package manifest 中声明。如果这个依赖是有意保留的，就把原因留在配置旁边；如果它已经不需要了，应直接删除依赖声明。
