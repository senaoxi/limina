# 内置任务

内置任务是 `limina check` 能直接调用的检查单元，每一个都对应一条 `limina <command>` 子命令。`limina check`（不带名字）会按固定顺序跑下表前六个，遇到第一个失败就停下，后续步骤标记为跳过。`package:check` 和 `release:check` 不在默认流程里，通常放进发布用的命名[流水线](./config/pipelines.md)。

| 任务                | 对应命令                   | 默认 `limina check` | 作用面                   |
| ------------------- | -------------------------- | ------------------- | ------------------------ |
| `graph:check`       | `limina graph check`       | 是，第 1 步         | 声明图 / 项目引用        |
| `source:check`      | `limina source check`      | 是，第 2 步         | 包归属边界               |
| `nx:check`          | `limina nx check`          | 是，第 3 步         | Nx 构建边                |
| `proof:check`       | `limina proof check`       | 是，第 4 步         | 源码覆盖 / tsconfig 形状 |
| `checker:build`     | `limina checker build`     | 是，第 5 步         | 一等公民编译（产出声明） |
| `checker:typecheck` | `limina checker typecheck` | 是，第 6 步         | 二等公民类型检查         |
| `package:check`     | `limina package check`     | 否，发布期          | 构建产物                 |
| `release:check`     | `limina release check`     | 否，发布期          | 发布卫生                 |

表格第一列就是这些任务在流水线里的字符串名，也可以写成显式对象 `{ type: 'task', name: 'graph:check' }`。

## `graph:check`

对应 `limina graph check`，校验由声明叶子（`tsconfig*.dts.json`）组成的项目引用图。下面逐项说明它检测什么、为什么这么要求、以及一个典型例子。

::: tip
这里提到的 deny/allow 规则在[图规则](./config/graph-rules.md)中定义。
:::

### 声明叶子的编译选项要齐全

声明叶子靠 `tsc -b` 增量地只产出 `.d.ts`。所以它必须打开 `composite`、`incremental`、`declaration`、`emitDeclarationOnly`，关掉 `noEmit`，并写明 `rootDir` / `outDir` / `tsBuildInfoFile`。少一个，增量构建就没法正确产出声明。

```jsonc
// packages/core/tsconfig.lib.dts.json
{
  "compilerOptions": {
    "composite": true,
    "incremental": true,
    "declaration": true,
    "emitDeclarationOnly": true,
    "noEmit": false,
    "rootDir": "./src",
    "outDir": "./dist",
    "tsBuildInfoFile": "./dist/.tsbuildinfo",
  },
}
```

漏了 `composite` 这类选项会报 `Invalid declaration leaf compiler option:`；漏了 `outDir` 这类输出项会报 `Missing declaration leaf output option:`。

### 每个叶子都要有配对的本地配置

每个 `*.dts.json` 都要有一个同范围的普通 `tsconfig*.json`（本地配套配置）来管类型语义。两者的类型相关选项（如 `strict`、`module`、`target`）必须一致，且叶子纳入的文件不能超出本地配套配置——否则「产声明用的配置」和「类型检查用的配置」会对不上。

```text
packages/core/
  tsconfig.lib.json       # 本地配套配置：strict: true
  tsconfig.lib.dts.json   # 叶子：也要 strict: true，文件集是本地配套配置的子集
```

没有本地配套配置会报 `Missing typecheck companion config:`；选项不一致会报 `Typecheck option mismatch between declaration leaf and companion config:`。

### 源码入口导入需要匹配引用

叶子的 `references` 必须和真实导入到的、由其他声明项目拥有的源码入口对应。代码导入了别的包的源码入口，就必须有对应引用；否则增量构建拿不到上游声明。反过来，列了却没有导入证明的引用也会被指出来，避免无用边。

```ts
// packages/app/src/main.ts
import { createClient } from '@acme/core'; // 引用了 core
```

如果 `packages/app/tsconfig.lib.dts.json` 的 `references` 没列 core，报 `Missing project reference for workspace import:`；列了多余、无导入支撑的引用报 `Extra project reference not proven by static imports:`。解析到 `dist/*.d.ts` 这类构建声明产物的导入不要求项目引用。源码入口边的修复方式是补上或删掉引用，或直接 `limina graph sync` 自动对齐。

### 工作区包导出必须可解析

对于每个声明了 `exports` 的工作区包，图检查会使用当前检查器配置预解析每个公开子路径。TypeScript 解析必须到达稳定类型入口或源码入口：`.d.ts` 系列文件、TypeScript 源码、`.json`，或检查器支持的源码文件，例如 `.vue`。Oxc 解析也必须成功；纯声明导出可以把 TypeScript 的 `.d.ts` 结果作为有效 Oxc 结果。

```jsonc
// 被依赖的 packages/core/package.json
{
  "exports": {
    ".": "./src/index.ts",
    "./types": { "types": "./dist/types.d.ts" },
    "./runtime": {
      "types": "./dist/runtime.d.ts",
      "default": "./dist/runtime.js",
    },
  },
}
```

无法解析时分别报 `Workspace package export is not resolvable by TypeScript:` 或 `Workspace package export is not resolvable by Oxc:`。如果 TypeScript 只能把导出解析到运行时 JavaScript，则报 `Workspace package export resolves to runtime JavaScript in TypeScript:`。

### 命中 deny 规则的引用/依赖会被拒

如果在 `graph.rules.<label>.deny` 里定义了架构红线（例如「客户端不准依赖 Node 运行时」），并让某个叶子通过 `liminaOptions.graphRules` 显式启用，那么命中红线的引用或依赖会被拒绝。

```jsonc
// tsconfig.lib.dts.json
{ "liminaOptions": { "graphRules": ["runtime-client"] } }
```

命中时报 `Denied graph access:`，并带上你在规则里写的 `reason`。

## `source:check`

对应 `limina source check`，校验包归属边界——谁能导入谁、依赖有没有声明。

### 不准跨包相对导入

不能用 `../` 跨进别的包目录拿东西；引用别的包要走包名，这样依赖关系才显式、可追踪。

```ts
// packages/b/src/index.ts（错误示范）
import { helper } from '../../a/src/util';
```

报 `Relative import escapes package owner scope:`。修复：在 `packages/b/package.json` 用 `workspace:*` 声明对 `@acme/a` 的依赖，并改成 `import { helper } from '@acme/a'`。

### 裸包导入必须先声明

按包名引入的依赖，必须出现在最近 `package.json` 的 `dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies` 任一中（Node 内置模块和包自身豁免），否则就是用了没声明的依赖。

```ts
import pMap from 'p-map'; // 但 package.json 里没声明 p-map
```

报 `Unauthorized bare package import:`。修复：把 `p-map` 加进对应依赖区。

### `#子路径` 导入要匹配 imports 且不越界

`#xxx` 这种子路径导入必须在本包 `package.json#imports` 里有定义，解析后还要落在本包内。

```jsonc
// package.json
{ "imports": { "#utils/*": "./src/utils/*.ts" } }
```

没匹配上报 `Unauthorized package import specifier:`；解析不了报 `Unresolved package import specifier:`；落到别的包报 `Package import resolves to another package owner:`。

### strict：跨包要用 `workspace:` 协议

strict 模式下，导入解析到另一个工作区包时，依赖声明必须用 `workspace:`，不能用 `link:` / `file:` / `catalog:` 或普通版本号——这样源码图才确定。

```jsonc
// package.json（不能写成 "link:../a"）
{ "dependencies": { "@acme/a": "workspace:*" } }
```

不满足报 `Workspace bare package import must use workspace: dependency:`。

### 一个 tsconfig / 模块只能属于一个归属方

治理用的 tsconfig，或一个源码模块，不能横跨多个包（即多个最近的 `package.json`），否则归属不清。

报 `Tsconfig source file set mixes package owners:` 或 `Source module belongs to multiple package owners:`。修复：拆分 tsconfig，让每个治理单元只覆盖单个包。

### 声明了却没用到的工作区依赖（Knip）

`package.json` 里声明了对另一个工作区包的依赖，但没有任何源码真的导入它。判定只看依赖名是否匹配工作区包：四个依赖段（`dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies`）都算，且与版本协议无关（`workspace:`、`link:`、`catalog:`、普通版本号等都一样）。可达性分析交给 Knip。

```js
// limina.config.mjs
export default defineConfig({
  source: {
    knip: {
      workspaces: {
        '@acme/app': {
          ignoreDependencies: [{ dep: '@acme/codegen', reason: '只被生成脚本用到' }],
        },
      },
    },
  },
});
```

报 `Unused workspace package dependency:`。若确实是经生成代码/运行时字符串使用，用 `source.knip.workspaces[pkg].ignoreDependencies` 豁免；否则删掉这条依赖。

### strict：从 exports 不可达的源码模块（Knip）

strict 模式下，Limina 还会让 Knip 检查：某个归属方的源码模块如果从包 `exports`、`bin`、scripts、Knip 支持的插件入口和 `source.knip.workspaces[pkg].entry` 都触达不到，就是死模块。

```js
source: {
  knip: {
    workspaces: {
      '@acme/app': {
        ignoreFiles: [
          { file: 'packages/app/src/generated/runtime.ts', reason: '框架运行时加载' },
        ],
      },
    },
  },
}
```

报 `Unused source module:`。如果它是真实的额外入口，写进 `source.knip.workspaces[pkg].entry`；确属有意保留但 Knip 看不见的，用 `source.knip.workspaces[pkg].ignoreFiles` 豁免。

## `nx:check`

对应 `limina nx check`，校验各包的 Nx `project.json` 构建边是否与产物消费保持同步。

### 从产物依赖推导构建边

每个包的 `link:<dep>/dist` 表示「我依赖这个包构建后的产物」。Limina 还会扫描检查器覆盖的源码文件：如果包 A 用 `workspace:*` 声明了包 B，并且实际导入了一个解析到 B 产物目录的公开导出，那么 A 也需要构建依赖指向 B。这包括 `dist/*.d.ts` 这类纯类型产物。

```jsonc
// packages/app/package.json
{
  "dependencies": {
    "@acme/core": "workspace:*",
    "@acme/ui": "link:../ui/dist",
  },
}
```

对应地，`app` 的 `project.json` 中 `build` 应当 `dependsOn` `ui` 的构建；当 app 实际导入了一个解析到 `core/dist` 的 core 导出时，也应当 `dependsOn` core 的构建。

### 缺 `project.json` 或 `dependsOn` 不一致就是过期

非根工作区包没有 `project.json`，或它的 `dependsOn` 与推导结果对不上，都判为过期，`nx:check` 失败。

报 `Nx project config state is stale; run \`limina nx sync build\`.`。修复：跑 `limina nx sync`。

### 产物依赖目标必须合法

`link:` 必须指向真实的工作区包、目标要有 `build` 脚本、要指向产物目录（如 `dist`），且不能成环。被消费到的 `workspace:*` 产物导出也要求目标包有 `build` 脚本。由 link 推导的边和由工作区导出推导的边会一起参与环检测。

分别报 `Nx build dependency points at an unknown workspace package:`、`Nx build dependency target has no build script:`、`Nx build dependency does not point at an artifact directory:`、`Nx artifact build dependency cycle:`。

::: warning
`nx:check` 在默认 `limina check` 里，所以全新仓库要先 `limina nx sync` 生成 `project.json`，否则默认检查会卡在这一步。
:::

## `proof:check`

对应 `limina proof check`，证明每个源码文件都被某个检查器覆盖，并校验 tsconfig 的形状与角色。

::: tip
有意不覆盖的文件写进[覆盖证明允许清单](./config/proof-allowlist.md)。
:::

### 边界内每个文件都要被覆盖

`config.source` 边界内的每个源码文件，都必须被某个检查器入口、图项目或 `proof.allowlist` 覆盖；没人管的文件会被揪出来。

```text
packages/core/src/generated/runtime.ts  # 没被任何 checker entry 覆盖
```

报 `Source files are not covered by typecheck proof:`。修复：纳入某个被检查器入口触达的 tsconfig；若是生成代码/fixture 就写进 `config.source.exclude`，或加一条带原因的 `proof.allowlist`。

### 同一文件不能被重复覆盖

同一个源码文件被同一检查器的两个声明叶子同时纳入，会造成重复构建和归属歧义。

报 `Duplicate checker graph coverage:`。修复：让每个文件只属于一个叶子。

### 聚合器必须是纯聚合器

`tsconfig*.build.json` 和带 `references` 的聚合 `tsconfig.json` 只能有 `$schema` / `files: []` / `references`，不能混入 `compilerOptions` 等。

```jsonc
// tsconfig.build.json
{ "files": [], "references": [{ "path": "./tsconfig.lib.dts.json" }] }
```

不满足报 `Build graph config is not a pure aggregator:` 或 `Default tsconfig.json is not a pure aggregator:`。

### 声明叶子的形状要对

每个 `*.dts.json` 要能被某检查器入口触达、有配对的本地配置、对 `tsc -b` 合法，且文件集和（非输出类）选项与本地配套配置对齐。

分别报 `DTS config is not reachable from any checker entry:`、`DTS config is not valid for tsc -b:`、`DTS config file set does not match its strict local tsconfig:`、`DTS config overrides a typecheck compiler option from its strict local tsconfig:`。

### 目录里 `tsconfig.json` 的角色

一个目录只有单一类型检查环境时，应直接用默认 `tsconfig.json` 当叶子；有多个环境时，`tsconfig.json` 应作纯聚合器。

报 `Single typecheck environment should use default tsconfig.json:` 或 `Directory with multiple typecheck environments must use tsconfig.json as an aggregator:`。

### strict 追加约束

strict 模式下还要求：叶子必须（传递地）`extends` 其本地配套配置、构建图只能引用 build/dts 项目、每个模块只属于一个类型检查配置。

分别报 `Strict mode requires declaration leaves to transitively extend their companion typecheck config:`、`Strict mode build graph references a non-build project:`、`Strict mode source file belongs to multiple typecheck configs:`。

## `checker:build`

对应 `limina checker build`，跑「一等公民」构建编译器，真正做类型检查并产出声明。

### 先预检所有检查器的 peer 依赖

跑编译器前，先确认每个已配置检查器需要的工具包都装了；缺任何一个就立刻失败，并直接给出安装命令。

例如用了 `tsgo` 预设却没装 `@typescript/native-preview`，会报 `Missing checker peer dependencies:`，并附 `Fix: pnpm add -D @typescript/native-preview`。

### 跑构建类编译器并产出声明

跑执行类型为构建的预设：`tsc -b`、`tsgo -b`、`vue-tsc -b`。`-b` 是增量项目构建，会真正产出 `.d.ts` 和 `.tsbuildinfo`。

::: warning
因为跑的是真实 `tsc -b`，默认 `limina check` 会产出声明文件和 `.tsbuildinfo`，并非无副作用。
:::

### 任一编译失败就失败

只要有一个编译进程非零退出（类型错误，或 tsconfig 缺失/非法），任务就失败。

报 `build checks failed:`，后面列出失败的入口。修复：解决报出来的类型错误。

## `checker:typecheck`

对应 `limina checker typecheck`，跑「二等公民」只检查不产出的检查器。

### 同样先做 peer 依赖预检

和 `checker:build` 一样，先预检全部检查器的 peer 依赖。

报 `Missing checker peer dependencies:`，并附 `Fix: pnpm add -D <包名>`。

### 跑类型检查类检查器（不产出文件）

跑执行类型为类型检查的预设：`vue-tsgo --project`、`svelte-check --tsconfig`。它们只报类型错误，不产出文件。

```js
// limina.config.mjs（节选）
checkers: { vue: { preset: 'vue-tsgo', entry: 'tsconfig.app.dts.json' } }
```

有 `.vue` 类型错误时非零退出，报 `typecheck checks failed:`。修复：解决报出来的 `.vue` 类型错误。

### 纯 `tsc` 仓库是空操作

如果没有配置二等公民检查器（纯 `tsc` / `tsgo` / `vue-tsc`），这一步直接通过，并打印 `No second-class checker entries configured.`；真正的类型检查在 `checker:build` 完成。

## `package:check`

对应 `limina package check`，对**构建产物**（不是源码）跑打包正确性检查，需要先构建。

### publint：打包是否规范

对产物跑 publint（默认 strict），检查 `exports`、`main` / `module` / `types` 字段、发布文件是否齐全等打包规范问题。

报形如 `publint found N issue(s): <label>`。修复：按 publint 提示修 `package.json`。

### attw：类型能否被正确解析

用 `@arethetypeswrong/core` 检查在目标解析模式下类型是否可用（默认配置档 `esm-only`，可用 `--attw-profile` 覆盖）。

报形如 `attw found N problem(s): <label>`。修复：补齐或修正 `types` 导出。

### boundary：产物只能导入已声明依赖

解析产物里的 `.js` / `.cjs` / `.mjs`，它们导入的包必须在产物清单的 `dependencies` / `peerDependencies` / `optionalDependencies` 里，或是自身导出。

报形如 `package boundary found N issue(s): <label>`。修复：把漏掉的运行时依赖加进 `dependencies`。

### 需要先构建

检查的是 `outDir` 下的产物，所以必须先构建。没构建就跑会报 `outDir package.json not found`，并提示 `Run the package build first.`。修复：先 `pnpm build`。

### strict：产物清单要可发布

strict 模式下，产物 `package.json` 必须是完整 npm 清单，且不含 `workspace:` / `link:` / `file:` / `catalog:` 这类 pnpm 本地依赖。

报形如 `[<label>] [strict] output package.json ...`。

## `release:check`

对应 `limina release check`，对构建产物做发布前的卫生与一致性检查。

### 不能是 private（及本地依赖）

产物清单若 `private: true`，npm 根本不会发布，直接拒绝；strict 模式下还拒绝产物里出现 `workspace:` / `link:` / `file:` / `catalog:` 依赖。

private 时报 `selected release package has "private": true; npm publish would reject it`。

### tarball 必含 README/LICENSE，且无源码映射

打出的发布包必须包含 `README.md` 和 `LICENSE.md`；不能包含 `.map` 文件或 `sourceMappingURL` 注释（避免把源码映射发出去）。

缺文件报 `tarball is missing required file(s): LICENSE.md`。修复：补上文件并确保它进入发布文件列表。

### 发布清单不暴露本地依赖

打包后的清单不能出现 `workspace:` / `link:` 这类本地说明符；工作区发布依赖必须指向真实且已发布的包。

报形如 `packed package manifest must not expose workspace: or link: dependency specifiers`，或 `<dep> is not published to the npm registry`。

### 与 npm 上的内容做哈希对比

把本地产物与 npm 上基线 dist-tag（默认 `latest`）的已发布内容做内容哈希对比，报告漂移（本地多出、远端多出，或内容变了）。

漂移时报 `[release-check] FAIL <importer> -> <dep>`。
