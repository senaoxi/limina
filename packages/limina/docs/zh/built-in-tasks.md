# 内置任务

内置任务是 `limina check` 能直接调用的检查单元，每一个都对应一条 `limina <command>` 子命令。`limina check`（不带名字）会按固定顺序跑下表前五个，遇到第一个失败就停下，后续步骤标记为跳过。`package:check` 和 `release:check` 不在默认流程里，通常放进发布用的命名[流水线](./config/pipelines.md)。

| 任务                | 对应命令                   | 默认 `limina check` | 作用面                   |
| ------------------- | -------------------------- | ------------------- | ------------------------ |
| `graph:check`       | `limina graph check`       | 是，第 1 步         | 声明图 / 项目引用        |
| `source:check`      | `limina source check`      | 是，第 2 步         | 包归属边界               |
| `proof:check`       | `limina proof check`       | 是，第 3 步         | 源码覆盖 / tsconfig 形状 |
| `checker:build`     | `limina checker build`     | 是，第 4 步         | 构建类类型检查           |
| `checker:typecheck` | `limina checker typecheck` | 是，第 5 步         | 只检查不产出             |
| `package:check`     | `limina package check`     | 否，发布期          | 构建产物                 |
| `release:check`     | `limina release check`     | 否，发布期          | 发布卫生                 |

表格第一列就是这些任务在流水线里的字符串名，也可以写成显式对象 `{ type: 'task', name: 'graph:check' }`。

## `graph:check`

对应 `limina graph check`，校验 `.limina/` 下生成的声明构建图；用户可见的规范路径是被 `checker.include` 选中的源码 tsconfig。下面逐项说明它检测什么、为什么这么要求、以及一个典型例子。

::: tip
这里提到的 deny/allow 规则在[图规则](./config/graph-rules.md)中定义。
:::

### 声明构建配置的编译选项要齐全

生成的声明构建配置会通过 `tsc -b` 增量地产出 `.d.ts`。Limina 会在 `limina graph prepare` 时写出这些配置；每个配置都会打开 `composite`、`incremental`、`declaration`、`emitDeclarationOnly`，关掉 `noEmit`，并写明 `rootDir` / `outDir` / `tsBuildInfoFile`。

```jsonc
// .limina/tsconfig/checkers/typescript/projects/packages/core/tsconfig.lib.dts.json
{
  "extends": "../../../../../packages/core/tsconfig.lib.json",
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

这些文件是生成产物，所以形状错误通常表示生成图过期或异常；运行 `limina graph prepare`，并查看诊断中映射回来的源码 tsconfig 路径。

### 每个叶子都要有配对的本地配置

每个生成的 `*.dts.json` 都要通过 `liminaOptions.sourceConfig` 指回负责类型语义的普通源码 `tsconfig*.json`。`module`、`target`、`lib` 等类型相关选项来自这个源码配置，生成配置纳入的文件也不能超出源码配置。

```text
packages/core/
  tsconfig.lib.json       # 源码配置负责类型相关选项
.limina/tsconfig/checkers/typescript/projects/packages/core/
  tsconfig.lib.dts.json   # 生成叶子，sourceConfig -> packages/core/tsconfig.lib.json
```

没有 `sourceConfig` 的生成配置会被拒绝。诊断涉及生成路径时，Limina 会尽量映射回源码 tsconfig 路径。

### 源码入口导入需要匹配引用

生成配置里的 `references` 必须和真实源码边对应：静态导入到的、由其他声明项目负责的源码入口，以及写明原因的 `liminaOptions.implicitRefs`。代码导入了别的包的源码入口，就必须有对应引用；否则增量构建拿不到上游声明。反过来，既没有静态导入证明、也没有 `implicitRefs` 说明的引用也会被指出来，避免留下无用边。

```ts
// packages/app/src/main.ts
import { createClient } from '@acme/core'; // 引用了 core
```

生成的声明引用来自真实导入到的、由其他生成配置负责的源码文件。如果源码边缺失，确认两端源码 tsconfig 都被 `checker.include` 选中，然后运行 `limina graph prepare`。解析到 `dist/*.d.ts` 这类构建声明产物的导入不要求项目引用。

如果真实边无法从静态导入里看出来，把它写在需要补边的源码 tsconfig 上：

```jsonc
{
  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../core/tsconfig.json",
        "reason": "Loaded by generated route manifest.",
      },
    ],
  },
}
```

`implicitRefs.path` 相对声明它的配置指向另一份普通源码 tsconfig。Limina 会把它映射到生成的声明项目。不要在普通源码配置里手写 `references`；只有 solution-style 的 `tsconfig.json` 聚合器应该携带 TypeScript `references`。

### 工作区包导出必须可解析

对于每个声明了 `exports` 的工作区包，图检查会使用当前检查器配置预解析每个真实公开子路径。`null` 导出表示这个包子路径被禁止访问，会被跳过。每个真实导出都必须能通过运行时解析器落到具体模块；纯声明导出可以把 TypeScript 的 `.d.ts` 结果作为有效运行时解析结果。

当受管源码 import 了其中某个导出时，TypeScript 解析必须到达稳定类型入口或源码入口：`.d.ts` 系列文件、TypeScript 源码、`.json`，或检查器支持的源码文件，例如 `.vue`。没有被受管源码 import 的运行时导出可以指向 JavaScript artifact；一旦源码 import 它，就必须提供类型入口。

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

无法解析时分别报 `Workspace package export is not resolvable by TypeScript:` 或 `Workspace package export is not resolvable by Oxc:`。如果受管源码 import 的导出只能解析到运行时 JavaScript，则报 `Workspace source import uses package export without a type entry:`。

### 命中 deny 规则的引用/依赖会被拒

如果在 `graph.rules.<label>.deny` 里定义了架构红线（例如「客户端不准依赖 Node 运行时」），并让某个源码 tsconfig 通过 `liminaOptions.graphRules` 显式启用，那么命中红线的引用或依赖会被拒绝。

```jsonc
// packages/app/tsconfig.client.json
{ "liminaOptions": { "graphRules": ["runtime-client"] } }
```

`limina graph prepare` 会把规则标签带到生成的构建配置里。命中时报 `Denied graph access:`，并带上你在规则里写的 `reason`。

## `source:check`

对应 `limina source check`，校验 source ownership、package-scope 相对导入边界，以及依赖有没有声明。

### 不准跨包相对导入

不能用 `../` 跨进别的包目录拿东西；引用别的包要走包名，这样依赖关系才显式、可追踪。

```ts
// packages/b/src/index.ts（错误示范）
import { helper } from '../../a/src/util';
```

报 `Relative import escapes package scope:`。修复：在 `packages/b/package.json` 声明对 `@acme/a` 的依赖，并改成 `import { helper } from '@acme/a'`。

### 裸包导入必须先声明

按包名引入的依赖，必须由最近的 pnpm workspace source owner 授权。匹配的 `source.importAuthority.allow` package rule 可以让 Limina 额外检查 workspace root `package.json`，但这个 root manifest 必须存在，并且要声明这个包。真正不应该由 manifest 声明的例外，可以用 `source.importAuthority.allow` specifier rule 表达。

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

没匹配上报 `Unauthorized package import specifier:`；解析不了报 `Unresolved package import specifier:`；落到别的 source owner 报 `Package import resolves to another source owner:`。

### 一个 tsconfig / 模块只能属于一个归属方

治理用的 tsconfig，或一个源码模块，不能横跨多个 pnpm workspace source owner，否则归属不清。

报 `Tsconfig source file set mixes source owners:` 或 `Source module belongs to multiple source owners:`。修复：拆分 tsconfig，让每个治理单元只覆盖单个包。

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

### 从 exports 不可达的源码模块（Knip）

Limina 会让 Knip 检查：某个归属方的源码模块如果从包 `exports`、`bin`、scripts、Knip 支持的插件入口和 `source.knip.workspaces[pkg].entry` 都触达不到，就是死模块。

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

## `graph export`

对应 `limina graph export`，导出 Limina 在被检查的 tsconfig 域内从真实导入和模块解析结果推导出的包依赖图。

```sh
pnpm exec limina graph export --view all --output .limina/dependency-graph.json
```

JSON 中包含 package 节点，以及 `source` / `artifact` 两类边。`source` 边表示导入解析到了类型图管辖的源码；`artifact` 边表示导入解析到了 `dist/*.js` 或 `dist/*.d.ts` 这类构建产物。依赖协议不决定边类型，解析到的文件才决定。

每条边都会尊重导入方项目的 compiler options，包括 `compilerOptions.customConditions`。这是 Limina 管辖域里的架构视图，不是全局构建解析图；它适合用于架构检查和诊断，不应该作为权威任务图或构建顺序来源：

```sh
pnpm exec limina graph export --view artifact
```

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

同一个源码文件被同一检查器的两个源码 tsconfig 同时纳入，会造成重复的声明构建归属和归属歧义。

报 `Duplicate checker graph coverage:`。修复：让每个文件在同一检查器下只属于一个源码 tsconfig。

### 聚合器必须是纯聚合器

源码层带 `references` 的聚合 `tsconfig.json` 只能有 `$schema` / `files: []` / `references`，不能混入 `compilerOptions` 等。Limina 会在 `.limina/tsconfig/checkers/<checker>/tsconfig.build.json` 写出检查器根 build 聚合器，并在 `.limina/tsconfig/checkers/<checker>/solutions/.../tsconfig.build.json` 下写出源码 solution build 聚合器。

```jsonc
// tsconfig.json
{ "files": [], "references": [{ "path": "./tsconfig.lib.json" }] }
```

不满足报 `Default tsconfig.json is not a pure aggregator:`。

### 声明构建配置的形状要对

每个生成的 `*.dts.json` 要能被生成的检查器 build 入口触达、有 `sourceConfig`、对 `tsc -b` 合法，且文件集和（非输出类）选项与源码配置对齐。

分别报 `DTS config is not reachable from any checker entry:`、`DTS config is not valid for tsc -b:`、`DTS config file set does not match its local typecheck config:`、`DTS config overrides a typecheck compiler option from its local typecheck config:`。

### 目录里 `tsconfig.json` 的角色

一个目录只有单一类型检查环境时，应直接用默认 `tsconfig.json` 当叶子；有多个环境时，`tsconfig.json` 应作纯聚合器。

报 `Single typecheck environment should use default tsconfig.json:` 或 `Directory with multiple typecheck environments must use tsconfig.json as an aggregator:`。

### 类型检查形状约束

叶子必须传递地 `extends` 其本地配套配置、构建图只能引用 build/dts 项目、每个模块只属于一个类型检查配置。

分别报 `Declaration leaf does not transitively extend its companion typecheck config:`、`Build graph references a non-build project:`、`Source file belongs to multiple typecheck configs:`。

## `checker:build`

对应 `limina checker build`，运行支持构建模式的检查器，真正做类型检查并产出声明。

### 先预检所有检查器的 peer 依赖

跑编译器前，先确认每个已配置检查器需要的工具包都装了；缺任何一个就立刻失败，并直接给出安装命令。

例如用了 `tsgo` 预设却没装 `@typescript/native-preview`，会报 `Missing checker peer dependencies:`，并附 `Fix: pnpm add -D @typescript/native-preview`。

### 跑构建类编译器并产出声明

跑执行类型为构建的预设：`tsc -b`、`tsgo -b`、`vue-tsc -b`。`-b` 是增量项目构建，会真正产出 `.d.ts` 和 `.tsbuildinfo`。

::: warning
因为跑的是真实 `tsc -b`，默认 `limina check` 会产出声明文件和 `.tsbuildinfo`，并非无副作用。
:::

### 提示不兼容的构建检查器组合

所有构建进程结束后，Limina 会检查：哪些构建类 checker preset 触达了同一个生成的声明构建配置。这个提示不会改变退出码；它只是提醒底层 build cache 语义可能不安全。

如果触达它的 checker 全部是同一个 preset，不提示。只混用了 `tsc` 和 `vue-tsc`，也不提示。其他构建类 preset 混用，例如 `tsgo` 和 `tsc`、`tsgo` 和 `vue-tsc`，会被提示，因为它们不能安全共享同一套底层 build cache 语义。

提示里会列出生成配置、它对应的源码配置，以及 `reachable from`：

```text
Potentially incompatible build checker combination:
  source config: packages/core/tsconfig.lib.json
  reachable from:
    - config.checkers.typescript (tsgo)
      entry tsconfigs:
        - packages/app/tsconfig.json
    - config.checkers.vue (vue-tsc)
      entry tsconfigs:
        - packages/theme/tsconfig.json
```

重点不只是 `source config` 本身。某个 checker 可能是通过另一个入口 import 到它，进而触达这个配置。想消掉提示，需要对齐 `entry tsconfigs` 里展示的这片可达入口，或者改用兼容组合，例如 `tsc` 和 `vue-tsc`。

### 任一编译失败就失败

只要有一个编译进程非零退出（类型错误，或 tsconfig 缺失/非法），任务就失败。

报 `build checks failed:`，后面列出失败的入口。修复：解决报出来的类型错误。

## `checker:typecheck`

对应 `limina checker typecheck`，运行只做类型检查、不产出文件的检查器。

### 只预检类型检查类 checker 的 peer 依赖

这一步只预检即将运行的只做类型检查的 checker entry，例如 `vue-tsgo` 和 `svelte-check`。执行构建的预设由 `checker:build` 处理。

报 `Missing checker peer dependencies:`，并附 `Fix: pnpm add -D <包名>`。

### 跑类型检查类检查器（不产出文件）

跑执行类型为类型检查的预设：`vue-tsgo --project`、`svelte-check --tsconfig`。它们只报类型错误，不产出文件。

```js
// limina.config.mjs（节选）
checkers: { vue: { preset: 'vue-tsgo', include: ['apps/app/tsconfig.json'] } }
```

有 `.vue` 类型错误时非零退出，报 `typecheck checks failed:`。修复：解决报出来的 `.vue` 类型错误。

### 没有只做类型检查的检查器时是空操作

如果没有显式配置只做类型检查的检查器，例如 auto 模式，或只有 `tsc` / `tsgo` / `vue-tsc`，这一步直接通过，并打印 `No second-class checker entries configured.`；真正的类型检查在 `checker:build` 完成。

## `package:check`

对应 `limina package check`，对**构建产物**（不是源码）跑打包正确性检查，需要先构建。

### publint：打包是否规范

对产物跑 publint，检查 `exports`、`main` / `module` / `types` 字段、发布文件是否齐全等打包规范问题。

报形如 `publint found N issue(s): <label>`。修复：按 publint 提示修 `package.json`。

### attw：类型能否被正确解析

用 `@arethetypeswrong/core` 检查在目标解析模式下类型是否可用（默认配置档 `esm-only`，可用 `--attw-profile` 覆盖）。

报形如 `attw found N problem(s): <label>`。修复：补齐或修正 `types` 导出。

### boundary：产物只能导入已声明依赖

解析产物里的 `.js` / `.cjs` / `.mjs`，它们导入的包必须在产物清单的 `dependencies` / `peerDependencies` / `optionalDependencies` 里，或是自身导出。

报形如 `package boundary found N issue(s): <label>`。修复：把漏掉的运行时依赖加进 `dependencies`。

### 需要先构建

检查的是 `outDir` 下的产物，所以必须先构建。没构建就跑会报 `outDir package.json not found`，并提示 `Run the package build first.`。修复：先 `pnpm build`。

### 产物清单要可发布

产物 `package.json` 必须是完整 npm 清单，且不含 `workspace:` / `link:` / `file:` / `catalog:` 这类 pnpm 本地依赖。

报形如 `[<label>] output package.json ...`。

## `release:check`

对应 `limina release check`，对构建产物做发布前的卫生与一致性检查。

### 不能是 private（及本地依赖）

产物清单若 `private: true`，npm 根本不会发布，直接拒绝；release check 也会拒绝产物里出现 `workspace:` / `link:` / `file:` / `catalog:` 依赖。

private 时报 `selected release package has "private": true; npm publish would reject it`。

### tarball 必含 README/LICENSE，且无源码映射

打出的发布包必须包含 `README.md` 和 `LICENSE.md`；不能包含 `.map` 文件或 `sourceMappingURL` 注释（避免把源码映射发出去）。

缺文件报 `tarball is missing required file(s): LICENSE.md`。修复：补上文件并确保它进入发布文件列表。

### 发布清单不暴露本地依赖

打包后的清单任一依赖区间都不能出现 `workspace:` / `link:` / `file:` / `catalog:` 这类本地说明符；工作区发布依赖必须指向真实且已发布的包。

报形如 `packed package manifest must not expose workspace:, link:, file:, or catalog: dependency specifiers in any dependency section`，或 `<dep> is not published to the npm registry`。

### 与 npm 上的内容做哈希对比

把本地产物与 npm 上基线 dist-tag（默认 `latest`）的已发布内容做内容哈希对比，报告漂移（本地多出、远端多出，或内容变了）。

漂移时报 `[release-check] FAIL <importer> -> <dep>`。
