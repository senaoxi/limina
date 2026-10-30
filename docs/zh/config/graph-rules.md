# 图规则

当项目有明确的依赖方向时，可以用图规则让 Limina 帮你发现违背约定的导入。例如，浏览器代码不应依赖 Node 内置模块。

先在 Limina 配置中定义一条名为 `browser` 的规则：

`limina.config.mjs`：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    rules: {
      browser: {
        deny: {
          deps: [{ name: 'node:*', reason: '浏览器代码不能依赖 Node 内置模块' }],
        },
      },
    },
  },
});
```

再把标签放到**负责浏览器源码的** `tsconfig` 中。下面假设 Limina 配置位于工作区根目录，`apps/web` 有自己的 `package.json`，并已被工作区声明纳入。例如，pnpm 工作区的 `pnpm-workspace.yaml` 中的 `packages` 要覆盖它。如果是单包项目，则在该项目的源码配置中添加标签。

这个例子中的 `apps/web/tsconfig.json` 直接包含 `src` 下的浏览器代码：

`apps/web/tsconfig.json`：

```jsonc
{
  "include": ["src/**/*.ts"],
  "liminaOptions": {
    "graphRules": ["browser"],
  },
}
```

保留项目实际需要的 `compilerOptions`。现在，如果该配置覆盖的文件导入 `node:fs`，运行 `pnpm exec limina graph check` 会报告 `LIMINA_GRAPH_ACCESS_DENIED` 和规则中的原因。移除或调整这条导入后再检查。规则只有被源码配置引用时才生效；目录叫 `web` 本身不会自动启用它。

默认 `limina check` 也包含图检查。不配置 `graph` 时，图检查仍会执行，但不会添加这些自定义规则。配置 `graph` 时必须声明 `rules`；`rules: {}` 表示没有附加规则，`graph: {}` 无效。即使命名流水线只执行检查器，适用的 `deny.refs` 也会在编译器执行前检查。

## `rules.<label>`

- **类型：** `Record<string, GraphRule>`

每个 `rules` 键名对应一个标签。源码配置在 `liminaOptions.graphRules` 中列出该标签时，才使用它的规则；同一配置可以列出多个标签并使用各自匹配的规则。未使用的标签不作用于任何源码配置。

配合源码配置中的标签：

```jsonc
{
  "liminaOptions": {
    "graphRules": ["browser"],
  },
  "include": ["src/**/*.ts"],
}
```

这个配置覆盖的源码会套用 `graph.rules.browser`。

## `allow.refs`

- **类型：** `Array<{ path: string; reason: string }>`

`allow.refs` 用于图检查中的“额外引用”判定：当待检查的声明图中已经存在某个引用，但静态导入分析无法证明它时，可以用允许规则承认这个引用。这里的引用属于声明构建图，无需在源码叶子配置中手写 `references`。

每个 `path` 都相对 `config.rootDir` 解析，必须能映射到可达的生成声明叶子。可以填写原源码叶子路径，外部激活包可使用 `../`。聚合配置或未治理配置不能作为规则目标。`allow.refs` 不会创建引用，也不会让被拒绝的引用合规。同一路径同时被 `allow` 和 `deny` 命中时，以 `deny.refs` 为准。

生成引用可以来自源码关系、[受管声明的检查上下文](../monorepo-constraints.md#选择声明的配置上下文)，或源码配置中的 `liminaOptions.implicitRefs`。字面量动态导入已经参与分析。计算后的运行时导入、生成清单或其他未被观察的代码如果形成明确的声明构建关系，可以用 `implicitRefs` 补充。它不会新增模块解析器，也不会让不支持的虚拟模块变为可消费。

`allow.refs` 只解释已有关系。需要新增静态分析看不到的关系时，使用 `implicitRefs`，无需同时添加一份允许规则。两者都不能覆盖禁止规则，也不要求修改 `.limina` 中的生成文件。`implicitRefs.path` 相对声明它的源码配置解析，完整形状见[补充声明关系示例](../concepts.md#源码配置)。

## `deny.refs`

- **类型：** `Array<{ path: string; reason: string }>`

`deny.refs` 禁止当前标签的项目引用指向某个源码 `tsconfig` 对应的声明构建配置。它适合表达“客户端运行时不能依赖服务端运行时”“公开 `API` 不能依赖内部工具”这类项目边界。

示例目录和配置如下：

```text
packages/app/
  package.json
  tsconfig.json
  src/client/tsconfig.lib.json
  src/node/tsconfig.lib.json
  src/client/main.ts
  src/node/read-file.ts
```

假设 `packages/app` 是已纳入工作区的包，包清单设置了 `"type": "module"`，Limina 配置位于工作区根目录。`packages/app/tsconfig.json` 作为入口，引用客户端和 Node 两份源码配置：

`packages/app/tsconfig.json`：

```jsonc
{
  "files": [],
  "references": [
    { "path": "./src/client/tsconfig.lib.json" },
    { "path": "./src/node/tsconfig.lib.json" },
  ],
}
```

如果没有入口引用这些命名配置，Limina 无法发现规则的目标，会报告图规则配置无效。

在 Limina 配置中定义禁止引用的目标（路径相对于配置根目录）。这是独立示例；如果已经配置了前面的 `browser` 规则，请把 `runtime-client` 加到同一个 `rules` 对象中：

`limina.config.mjs`：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    rules: {
      'runtime-client': {
        deny: {
          refs: [
            { path: 'packages/app/src/node/tsconfig.lib.json', reason: '客户端不能依赖 Node 源码' },
          ],
        },
      },
    },
  },
});
```

客户端源码配置标记为 `runtime-client`：

```jsonc
// packages/app/src/client/tsconfig.lib.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "types": [],
  },
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "include": ["main.ts"],
}
```

Node 源码配置也使用相同的 `compilerOptions`，并包含 `read-file.ts`。这里的 `types: []` 只让示例不依赖其他环境类型；已有项目应保留自己需要的类型环境。

```jsonc
// packages/app/src/node/tsconfig.lib.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "types": [],
  },
  "include": ["read-file.ts"],
}
```

在 Node 源码配置中导出一个函数，并让客户端导入它：

`packages/app/src/node/read-file.ts`：

```ts
export const read = () => 'node data';
```

`packages/app/src/client/main.ts`：

```ts
import { read } from '../node/read-file.js';

export const message = read();
```

运行 `pnpm exec limina graph check` 时，Limina 会把源码提供者关系与 `graph.rules.runtime-client.deny.refs` 对比，同时检查实际项目引用。即使只运行检查器，适用的禁止引用也会在执行前被拒绝。

需要 Node 叶子配置的客户端导入会被报告为图访问遭拒，并显示配置中的 `reason`。应处理源码关系或规则，而不是修改生成文件。

## `deny.deps`

- **类型：** `Array<{ name: string; reason: string }>`

`deny.deps` 禁止源码导入某些包、`#imports` 或 `Node` 内置模块。`name` 可以是包名、`#subpath`（例如 `#server/*`）、`fs`、`node:fs`，也可以用 `node:*` 匹配所有 `Node` 内置模块。

例如，本页开头的 `browser` 规则使用 `node:*`。如果带有该标签的 `apps/web/tsconfig.json` 覆盖了下面的文件：

```ts
// apps/web/src/load.ts
import { readFileSync } from 'node:fs';
```

这个导入会命中 `graph.rules.browser.deny.deps` 中的 `node:*` 规则。也可以按同样的方式增加一条 `name: '@acme/internal-node'`，禁止导入指定的服务端包。处理源码导入或重新审视规则适用的标签范围后，再运行检查。
