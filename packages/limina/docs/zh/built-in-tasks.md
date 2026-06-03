# 内置任务

内置任务是 `limina check` 能直接调用的检查单元，每一个都对应一条 `limina <command>` 子命令。`limina check`（不带名字）会按固定顺序跑下表前六个，遇到第一个失败就停下，后续步骤标记为跳过。`package:check` 和 `release:check` 不在默认流程里，通常放进发布用的命名 [Pipelines](./options/pipelines.md)。

| 任务                | 对应命令                   | 默认 `limina check` | 作用面                      |
| ------------------- | -------------------------- | ------------------- | --------------------------- |
| `graph:check`       | `limina graph check`       | 是，第 1 步         | 声明图 / project references |
| `source:check`      | `limina source check`      | 是，第 2 步         | package 归属边界            |
| `nx:check`          | `limina nx check`          | 是，第 3 步         | Nx build 边                 |
| `proof:check`       | `limina proof check`       | 是，第 4 步         | 源码覆盖 / tsconfig 形状    |
| `checker:build`     | `limina checker build`     | 是，第 5 步         | 一等公民编译（产出声明）    |
| `checker:typecheck` | `limina checker typecheck` | 是，第 6 步         | 二等公民类型检查            |
| `package:check`     | `limina package check`     | 否，发布期          | 构建产物                    |
| `release:check`     | `limina release check`     | 否，发布期          | 发布卫生                    |

表格第一列就是这些任务在 pipeline 里的字符串名，也可以写成显式对象 `{ type: 'task', name: 'graph:check' }`。

## `graph:check`

对应 `limina graph check`，校验由 declaration leaf（`tsconfig*.dts.json`）组成的 project-reference 图。下面逐项说明它检测什么、为什么这么要求、以及一个典型例子。

### 声明叶子的编译选项要齐全

declaration leaf 靠 `tsc -b` 增量地只产出 `.d.ts`。所以它必须打开 `composite`、`incremental`、`declaration`、`emitDeclarationOnly`，关掉 `noEmit`，并写明 `rootDir` / `outDir` / `tsBuildInfoFile`。少一个，增量构建就没法正确产出声明。

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

### 每个叶子都要有配对的 companion

每个 `*.dts.json` 都要有一个同范围的普通 `tsconfig*.json`（companion）来管类型语义。两者的类型相关选项（如 `strict`、`module`、`target`）必须一致，且叶子纳入的文件不能超出 companion——否则「产声明用的配置」和「类型检查用的配置」会对不上。

```text
packages/core/
  tsconfig.lib.json       # companion：strict: true
  tsconfig.lib.dts.json   # 叶子：也要 strict: true，文件集是 companion 的子集
```

没有 companion 报 `Missing typecheck companion config:`；选项不一致报 `Typecheck option mismatch between declaration leaf and companion config:`。

### references 要精确等于真实 import

叶子的 `references` 必须和源码里真实的 `import` 一一对应：代码 import 了别的包就必须有对应引用（否则增量构建拿不到上游声明）；反过来，列了却没人 import 的引用也会被指出来（避免无用边）。

```ts
// packages/app/src/main.ts
import { createClient } from '@acme/core'; // 引用了 core
```

如果 `packages/app/tsconfig.lib.dts.json` 的 `references` 没列 core，报 `Missing project reference for workspace import:`；列了多余、无 import 支撑的引用报 `Extra project reference not proven by static imports:`。修复：补上或删掉引用，或直接 `limina graph sync` 自动对齐。

### `workspace:*` 依赖必须解析到源码

`workspace:*` 表示「按源码消费」。如果这个依赖的 `exports` 把 import 解析到了构建产物 `dist`，graph 拿到的就是产物而不是源码，增量类型构建会失真。

```jsonc
// 被依赖的 packages/core/package.json
{
  "exports": { ".": "./dist/index.js" }, // 指向 dist，会出问题
}
```

这种情况报 `Referenced workspace dependency resolves through package exports to a build artifact:`。修复：让源码 manifest 的 `exports` 指向源码入口，或把依赖改成 artifact 协议并移除 project reference。

### 命中 deny 规则的引用/依赖会被拒

如果在 `graph.rules.<label>.deny` 里定义了架构红线（例如「client 不准依赖 node 运行时」），并让某个叶子通过 `liminaOptions.graphRules` 显式启用，那么命中红线的引用或依赖会被拒绝。

```jsonc
// tsconfig.lib.dts.json
{ "liminaOptions": { "graphRules": ["runtime-client"] } }
```

命中时报 `Denied graph access:`，并带上你在规则里写的 `reason`。

## `source:check`

对应 `limina source check`，校验 package 归属（ownership）边界——谁能 import 谁、依赖有没有声明。

### 不准跨包相对 import

不能用 `../` 跨进别的 package 目录拿东西；引用别的包要走包名，这样依赖关系才显式、可追踪。

```ts
// packages/b/src/index.ts（错误示范）
import { helper } from '../../a/src/util';
```

报 `Relative import escapes package owner scope:`。修复：在 `packages/b/package.json` 用 `workspace:*` 声明对 `@acme/a` 的依赖，并改成 `import { helper } from '@acme/a'`。

### bare import 必须先声明

按包名引入的依赖，必须出现在最近 `package.json` 的 `dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies` 任一中（Node 内置模块和包自身豁免），否则就是用了没声明的依赖。

```ts
import pMap from 'p-map'; // 但 package.json 里没声明 p-map
```

报 `Unauthorized bare package import:`。修复：把 `p-map` 加进对应依赖区。

### `#子路径` import 要匹配 imports 且不越界

`#xxx` 这种 subpath import 必须在本包 `package.json#imports` 里有定义，解析后还要落在本包内。

```jsonc
// package.json
{ "imports": { "#utils/*": "./src/utils/*.ts" } }
```

没匹配上报 `Unauthorized package import specifier:`；解析不了报 `Unresolved package import specifier:`；落到别的包报 `Package import resolves to another package owner:`。

### strict：跨包要用 `workspace:` 协议

strict 模式下，import 解析到另一个 workspace package 时，依赖声明必须用 `workspace:`，不能用 `link:` / `file:` / `catalog:` 或普通版本号——这样源码图才确定。

```jsonc
// package.json（不能写成 "link:../a"）
{ "dependencies": { "@acme/a": "workspace:*" } }
```

不满足报 `Workspace bare package import must use workspace: dependency:`。

### 一个 tsconfig / 模块只能属于一个 owner

治理用的 tsconfig，或一个源码模块，不能横跨多个 package（即多个最近的 `package.json`），否则归属不清。

报 `Tsconfig source file set mixes package owners:` 或 `Source module belongs to multiple package owners:`。修复：拆分 tsconfig，让每个治理单元只覆盖单个包。

### 声明了却没用到的 workspace 依赖（Knip）

`package.json` 里声明了对另一个 workspace 包的依赖，但没有任何源码真的 import 它。判定只看依赖名是否匹配 workspace 包：四个依赖段（`dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies`）都算，且与版本协议无关（`workspace:`、`link:`、`catalog:`、普通版本号等都一样）。可达性分析交给 Knip。

```js
// limina.config.mjs
export default defineConfig({
  source: {
    unusedDependencies: {
      ignore: [{ importer: '@acme/app', dependency: '@acme/codegen', reason: '只被生成脚本用到' }],
    },
  },
});
```

报 `Unused workspace package dependency:`。若确实是经生成代码/运行时字符串使用，用 `source.unusedDependencies.ignore` 豁免；否则删掉这条依赖。

### strict：从 exports 不可达的源码模块（Knip）

strict 模式下，Limina 还会让 Knip 检查：某个 owner 的源码模块如果从 package `exports`、`bin`、scripts、Knip 支持的 plugin entries 和 `source.additionalEntries` 都触达不到，就是 dead module。

```js
source: {
  unusedModules: {
    ignore: [
      { owner: '@acme/app', file: 'packages/app/src/generated/runtime.ts', reason: '框架运行时加载' },
    ],
  },
}
```

报 `Unused source module:`。如果它是真实的额外入口，写进 `source.additionalEntries`；确属有意保留但 Knip 看不见的，用 `source.unusedModules.ignore` 豁免。

## `nx:check`

对应 `limina nx check`，校验各包的 Nx `project.json` build 边是否与 `link:` 产物依赖保持同步。

### 从 `link:` 产物依赖推导 build 边

每个包的 `link:<dep>/dist` 表示「我依赖这个包构建后的产物」。Limina 据此推导出该包 `project.json` 里 `targets.build.dependsOn` 应该有哪些上游。

```jsonc
// packages/app/package.json
{ "dependencies": { "@acme/ui": "link:../ui/dist" } }
```

对应地，`app` 的 `project.json` 中 `build` 应当 `dependsOn` `ui` 的 build。

### 缺 `project.json` 或 `dependsOn` 不一致就是 stale

非根 workspace 包没有 `project.json`，或它的 `dependsOn` 与推导结果对不上，都判为 stale，`nx:check` 失败。

报 `Nx project config state is stale; run \`limina nx sync build\`.`。修复：跑 `limina nx sync`。

### `link:` 依赖本身要合法

`link:` 必须指向真实的 workspace 包、目标要有 `build` 脚本、要指向产物目录（如 `dist`），且不能成环。

分别报 `Nx build dependency points at an unknown workspace package:`、`Nx build dependency target has no build script:`、`Nx build dependency does not point at an artifact directory:`、`Nx artifact build dependency cycle:`。

> `nx:check` 在默认 `limina check` 里，所以全新仓库要先 `limina nx sync` 生成 `project.json`，否则默认检查会卡在这一步。

## `proof:check`

对应 `limina proof check`，证明每个源码文件都被某个 checker 覆盖，并校验 tsconfig 的形状与角色。

### 边界内每个文件都要被覆盖

`config.source` 边界内的每个源码文件，都必须被某 checker entry、graph project 或 `proof.allowlist` 覆盖；没人管的文件会被揪出来。

```text
packages/core/src/generated/runtime.ts  # 没被任何 checker entry 覆盖
```

报 `Source files are not covered by typecheck proof:`。修复：纳入某个被 checker entry 触达的 tsconfig；若是生成代码/fixture 就写进 `config.source.exclude`，或加一条带原因的 `proof.allowlist`。

### 同一文件不能被重复覆盖

同一个源码文件被同一 checker 的两个 declaration leaf 同时纳入，会造成重复构建和归属歧义。

报 `Duplicate checker graph coverage:`。修复：让每个文件只属于一个 leaf。

### 聚合器必须是纯聚合器

`tsconfig*.build.json` 和带 `references` 的聚合 `tsconfig.json` 只能有 `$schema` / `files: []` / `references`，不能混入 `compilerOptions` 等。

```jsonc
// tsconfig.build.json
{ "files": [], "references": [{ "path": "./tsconfig.lib.dts.json" }] }
```

不满足报 `Build graph config is not a pure aggregator:` 或 `Default tsconfig.json is not a pure aggregator:`。

### 声明叶子的形状要对

每个 `*.dts.json` 要能被某 checker entry 触达、有配对 companion、对 `tsc -b` 合法，且文件集和（非输出类）选项与 companion 对齐。

分别报 `DTS config is not reachable from any checker entry:`、`DTS config is not valid for tsc -b:`、`DTS config file set does not match its strict local tsconfig:`、`DTS config overrides a typecheck compiler option from its strict local tsconfig:`。

### 目录里 `tsconfig.json` 的角色

一个目录只有单一 typecheck 环境时，应直接用默认 `tsconfig.json` 当叶子；有多个环境时，`tsconfig.json` 应作纯聚合器。

报 `Single typecheck environment should use default tsconfig.json:` 或 `Directory with multiple typecheck environments must use tsconfig.json as an aggregator:`。

### strict 追加约束

strict 模式下还要求：leaf 必须（传递地）`extends` 其 companion、build 图只能引用 build/dts 项目、每个模块只属于一个 typecheck 配置。

分别报 `Strict mode requires declaration leaves to transitively extend their companion typecheck config:`、`Strict mode build graph references a non-build project:`、`Strict mode source file belongs to multiple typecheck configs:`。

## `checker:build`

对应 `limina checker build`，跑「一等公民」build 编译器，真正做类型检查并产出声明。

### 先预检所有 checker 的 peer 依赖

跑编译器前，先确认每个已配置 checker 需要的工具包都装了；缺任何一个就立刻失败，并直接给出安装命令。

例如用了 `tsgo` preset 却没装 `@typescript/native-preview`，会报 `Missing checker peer dependencies:`，并附 `Fix: pnpm add -D @typescript/native-preview`。

### 跑 build 类编译器并产出声明

跑 execution 为 build 的 preset：`tsc -b`、`tsgo -b`、`vue-tsc -b`。`-b` 是增量 project build，会真正产出 `.d.ts` 和 `.tsbuildinfo`。

> 因为跑的是真实 `tsc -b`，默认 `limina check` 会产出声明文件和 `.tsbuildinfo`，并非无副作用。

### 任一编译失败就失败

只要有一个编译进程非零退出（类型错误，或 tsconfig 缺失/非法），任务就失败。

报 `build checks failed:`，后面列出失败的 entry。修复：解决报出来的类型错误。

## `checker:typecheck`

对应 `limina checker typecheck`，跑「二等公民」只检查不产出的 checker。

### 同样先做 peer 依赖预检

和 `checker:build` 一样，先预检全部 checker 的 peer 依赖。

报 `Missing checker peer dependencies:`，并附 `Fix: pnpm add -D <包名>`。

### 跑 typecheck 类 checker（不产出文件）

跑 execution 为 typecheck 的 preset：`vue-tsgo --project`、`svelte-check --tsconfig`。它们只报类型错误，不产出文件。

```js
// limina.config.mjs（节选）
checkers: { vue: { preset: 'vue-tsgo', entry: 'tsconfig.app.dts.json' } }
```

有 `.vue` 类型错误时非零退出，报 `typecheck checks failed:`。修复：解决报出来的 `.vue` 类型错误。

### 纯 `tsc` 仓库是空操作

如果没有配置二等公民 checker（纯 `tsc` / `tsgo` / `vue-tsc`），这一步直接通过，并打印 `No second-class checker entries configured.`；真正的类型检查在 `checker:build` 完成。

## `package:check`

对应 `limina package check`，对**构建产物**（不是源码）跑打包正确性检查，需要先 build。

### publint：打包是否规范

对产物跑 publint（默认 strict），检查 `exports`、`main` / `module` / `types` 字段、发布文件是否齐全等打包规范问题。

报形如 `publint found N issue(s): <label>`。修复：按 publint 提示修 `package.json`。

### attw：类型能否被正确解析

用 `@arethetypeswrong/core` 检查在目标解析模式下类型是否可用（默认 profile `esm-only`，可用 `--attw-profile` 覆盖）。

报形如 `attw found N problem(s): <label>`。修复：补齐或修正 `types` 导出。

### boundary：产物只能 import 已声明依赖

解析产物里的 `.js` / `.cjs` / `.mjs`，它们 import 的包必须在产物 manifest 的 `dependencies` / `peerDependencies` / `optionalDependencies` 里，或是自身 exports。

报形如 `package boundary found N issue(s): <label>`。修复：把漏掉的运行时依赖加进 `dependencies`。

### 需要先 build

检查的是 `outDir` 下的产物，所以必须先构建。没 build 就跑会报 `outDir package.json not found`，并提示 `Run the package build first.`。修复：先 `pnpm build`。

### strict：产物 manifest 要可发布

strict 模式下，产物 `package.json` 必须是完整 npm manifest，且不含 `workspace:` / `link:` / `file:` / `catalog:` 这类 pnpm 本地依赖。

报形如 `[<label>] [strict] output package.json ...`。

## `release:check`

对应 `limina release check`，对构建产物做发布前的卫生与一致性检查。

### 不能是 private（及本地依赖）

产物 manifest 若 `private: true`，npm 根本不会发布，直接拒绝；strict 模式下还拒绝产物里出现 `workspace:` / `link:` / `file:` / `catalog:` 依赖。

private 时报 `selected release package has "private": true; npm publish would reject it`。

### tarball 必含 README/LICENSE，且无 source map

打出的发布包必须包含 `README.md` 和 `LICENSE.md`；不能包含 `.map` 文件或 `sourceMappingURL` 注释（避免把源码映射发出去）。

缺文件报 `tarball is missing required file(s): LICENSE.md`。修复：补上文件并确保它进入发布文件列表。

### 发布 manifest 不暴露本地依赖

打包后的 manifest 不能出现 `workspace:` / `link:` 这类本地 specifier；workspace 发布依赖必须指向真实且已发布的包。

报形如 `packed package manifest must not expose workspace: or link: dependency specifiers`，或 `<dep> is not published to the npm registry`。

### 与 npm 上的内容做哈希对比

把本地产物与 npm 上 baseline dist-tag（默认 `latest`）的已发布内容做内容哈希对比，报告漂移（本地多出、远端多出，或内容变了）。

漂移时报 `[release-check] FAIL <importer> -> <dep>`。
