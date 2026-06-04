# 架构一致性

[为什么需要 Limina](./why.md) 解释了它的定位：Nx 和 Turborepo 工作在任务执行层，而 limina 工作在架构一致性层——在任何任务运行之前，证明单体仓库所依赖的结构是可信的。

本页是它的实战篇。它通过一系列具体场景展示：一个 pnpm + TypeScript 单体仓库看起来很健康——命令能跑、CI 是绿的——但底层的各张图其实已经彼此矛盾。每个场景都给出现象、limina 怎么看，以及如何修复。

## 工作区导出可以混合源码和构建产物

假设你有两个包：

```text
packages/
  core/
    src/index.ts
    dist/runtime.js
    dist/runtime.d.ts
    dist/types.d.ts
    dist/index.d.ts
    package.json
  app/
    src/main.ts
    package.json
```

`app` 依赖 `core`：

```json
{
  "dependencies": {
    "@acme/core": "workspace:*"
  }
}
```

在 `app/src/main.ts` 中：

```ts
import { createClient } from '@acme/core';
```

从 pnpm 的角度看，这没有问题。`workspace:*` 会把本地工作区包链接进来。

`@acme/core/package.json` 可以有意同时暴露源码入口和构建产物入口：

```json
{
  "name": "@acme/core",
  "exports": {
    ".": "./src/index.ts",
    "./runtime": {
      "types": "./dist/runtime.d.ts",
      "import": "./dist/runtime.js"
    },
    "./types": {
      "types": "./dist/types.d.ts"
    }
  }
}
```

这在 Limina 当前模型里是合法的。工作区包导出可以指向源码，也可以指向构建产物，而且这条规则不受 strict 模式控制。真正重要的是解析后的入口：

- TypeScript 必须能把每个公开导出解析到稳定类型入口或受支持的源码入口；
- Oxc 也必须能解析每个公开导出；纯声明导出可以使用 TypeScript 的 `.d.ts` 结果作为有效 Oxc 结果；
- 解析到检查器管辖源码入口的导入参与项目引用治理；
- 解析到 `dist` 的导入参与 Nx 产物构建边治理。

### limina 会怎么看

Limina 会先按照当前检查器配置预解析导出。如果 `@acme/core/runtime` 没有出现在导出映射中、指向不存在的文件，或者 TypeScript 只能解析到运行时 JavaScript，图检查会先报告这个包导出，然后才进入引用分析。

对于源码入口：

```ts
import { createClient } from '@acme/core';
```

如果 TypeScript 把这个入口解析到 `packages/core/src/index.ts`，且这个文件由 `packages/core/tsconfig.lib.dts.json` 管辖，那么 app 的声明叶子必须引用 core：

```jsonc
// packages/app/tsconfig.lib.dts.json
{
  "references": [{ "path": "../core/tsconfig.lib.dts.json" }],
}
```

对于构建产物入口：

```ts
import { renderRuntime } from '@acme/core/runtime';
```

如果这个入口解析到 `packages/core/dist`，图引用不要求项目引用。相应地，`limina nx check` 会要求 `packages/app/project.json` 让 app 的构建通过 `dependsOn` 指向 core 的构建：

```jsonc
{
  "targets": {
    "build": {
      "dependsOn": [{ "projects": ["@acme/core"], "target": "build" }],
    },
  },
}
```

### 修复方式

修复方式取决于失败发生在哪一层：

- 如果导出预解析失败，修 `exports` target、condition 顺序、检查器入口，或补齐缺失的构建产物。
- 如果实际消费了源码入口，但声明叶子缺引用，补上引用或运行 `limina graph sync`。
- 如果通过 `workspace:*` 消费了产物入口，但 Nx `dependsOn` 过期，运行 `limina nx sync`。
- 如果产物导出所属包没有 `scripts.build`，补构建目标，或不要把这个入口作为构建产物暴露。

产物构建边的 Nx 侧规则见[内置任务](./built-in-tasks.md)。

## `tsconfig.json` 同时承担太多职责

很多项目会把 `tsconfig.json` 写成这样：

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "outDir": "dist",
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "references": [{ "path": "../core" }],
}
```

这个配置同时在做几件事：

- IDE 默认入口；
- 本地类型检查；
- 声明产出；
- 项目引用图；
- lib + test 混合环境。

短期看方便，长期看会导致几个问题：

1. IDE 看到的类型环境和构建看到的不一致。
2. 测试专用依赖可能进入生产声明图。
3. 声明产出可能包含不该发布的文件。
4. 项目引用无法表达 lib/test/tools 的不同边界。

limina 更推荐拆开：

```text
packages/app/
  tsconfig.json
  tsconfig.lib.json
  tsconfig.lib.dts.json
  tsconfig.test.json
  tsconfig.test.dts.json
  tsconfig.tools.json
  tsconfig.tools.dts.json
```

单环境目录中，`tsconfig.json` 可以直接是叶子：

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "strict": true,
  },
  "include": ["src/**/*.ts"],
}
```

多环境目录中，`tsconfig.json` 应该是纯聚合器：

```jsonc
{
  "files": [],
  "references": [
    { "path": "./tsconfig.lib.json" },
    { "path": "./tsconfig.test.json" },
    { "path": "./tsconfig.tools.json" },
  ],
}
```

### limina 会怎么看

如果一个带 `references` 的 `tsconfig.json` 还混入 `compilerOptions`、`include` 等字段，limina 会认为它不是纯聚合器。

limina 的判断是：**有 `references` 的默认 `tsconfig.json` 应该只做聚合，不应该同时做叶子。**

## 客户端运行时误用了 Node API

假设你有一个浏览器端运行时：

```text
packages/app/src/client/runtime.ts
```

里面有人写了：

```ts
import fs from 'node:fs';

export function loadConfig() {
  return fs.readFileSync('config.json', 'utf8');
}
```

这在 Node 环境下类型检查可能能过，但这段代码不能进入浏览器运行时。

传统方式通常靠代码审查发现。但在单体仓库里，这种边界很容易被破坏，尤其是 shared/client/server 目录互相引用时。

limina 用标签表达架构边界。

```jsonc
// packages/app/src/client/tsconfig.dts.json
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "extends": ["./tsconfig.json", "../../../tsconfig.dts.base.json"],
  "references": [],
}
```

然后在 `limina.config.mjs` 中声明规则：

```js
export default defineConfig({
  graph: {
    rules: {
      'runtime-client': {
        deny: {
          deps: [
            {
              name: 'node:*',
              reason: 'client runtime must stay free of Node builtin imports',
            },
          ],
        },
      },
    },
  },
});
```

### limina 会怎么看

它会把这类问题作为架构违规，而不是普通 TypeScript 错误：

```text
Denied graph access:
  rules: runtime-client
  importing project: packages/app/src/client/tsconfig.dts.json
  file: packages/app/src/client/runtime.ts:1
  imported specifier: node:fs
  denied dependency: node:*
  reason: client runtime must stay free of Node builtin imports
```

### 适用场景

这种规则特别适合：

- `runtime-client` 不能依赖 `runtime-node`；
- `runtime-shared` 不能依赖仅客户端或仅 Node 实现；
- 浏览器包不能导入 Node 内置模块；
- 公开 API 层不能导入内部包；
- 插件运行时不能依赖仅 CLI 代码。

::: tip
完整的标签与拒绝规则语法，参见[图规则](./config/graph-rules.md)。
:::

## 一个文件被多个声明叶子同时拥有

假设你有：

```text
packages/core/src/index.ts
packages/core/tsconfig.lib.dts.json
packages/core/tsconfig.tools.dts.json
```

两个 dts 配置都 include 了同一个文件：

```jsonc
{
  "include": ["src/**/*.ts"],
}
```

这样 `src/index.ts` 同时属于 lib 声明图和 tools 声明图。

这会导致几个问题：

1. 同一个文件可能被不同编译选项检查。
2. 声明产出可能重复。
3. 项目引用图中无法判断谁才是这个文件的归属方。
4. 运行时边界标签可能冲突。

limina 会认为一个检查器图文件必须只有一个声明归属方。

### 修复方式

让不同叶子拥有不同文件集合：

```jsonc
// tsconfig.lib.dts.json
{
  "include": ["src/**/*.ts"],
  "exclude": ["src/tools/**"],
}
```

```jsonc
// tsconfig.tools.dts.json
{
  "include": ["src/tools/**/*.ts"],
}
```

或者重新调整目录结构：

```text
src/
  lib/
  tools/
```

让每个声明叶子的边界更自然。

## 把它们串起来

limina 眼中的健康单体仓库，不是“所有命令能跑完”，而是下面几张图互相一致：

```text
pnpm workspace packages
        │
        ▼
package.json dependencies
        │
        ▼
workspace package exports
        │
        ▼
TypeScript / Oxc module resolution
        │
        ▼
source-owned imports and artifact imports
        │
        ▼
TypeScript 项目引用和 Nx 构建边
        │
        ▼
被检查器覆盖的源码文件
        │
        ▼
built package outputs consumed by users
```

只要其中某一层表达了不同的事实，limina 就会认为单体仓库不健康。

例如：

| 现象                                         | limina 的判断                               |
| -------------------------------------------- | ------------------------------------------- |
| 工作区导出无法被 TypeScript/Oxc 解析         | 公开包契约在当前检查器/运行时配置下不可解析 |
| `workspace:*` 导入解析到源码但没有引用       | 源码入口已被消费，但缺少对应 TS 项目边      |
| `workspace:*` 导入解析到 `dist` 但没有 Nx 边 | 产物入口已被消费，但缺少必要构建依赖        |
| 跨包相对导入                                 | 绕开包导出和包归属方边界                    |
| 项目引用跨包但没有 `workspace:*`             | TS 图声明了源码依赖，但包图没有             |
| dts 叶子没有本地配套配置                     | 声明产出没有严格类型检查证明                |
| 源码文件没被任何检查器覆盖                   | CI 绿不代表文件被检查                       |
| 浏览器运行时导入 `node:fs`                   | 运行时边界被破坏                            |
| dist 清单 exports/types 错误                 | 源码健康但发布产物不健康                    |
| dist 导入未声明依赖                          | 消费者安装后可能缺依赖                      |

::: tip
上面源码侧的场景由图检查和源码检查强制执行，产物构建边由 Nx 检查强制执行；`dist` 输出健康度相关行由[包检查](./config/package-checks.md)强制执行。运行这些层的完整命令，参见[内置任务](./built-in-tasks.md)。
:::
