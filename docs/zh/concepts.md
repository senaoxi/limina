# 核心概念

Limina 选择需要治理的 `tsconfig`，根据源码导入和模块解析结果生成声明构建图，并在同一套流程中检查源码依赖、产物依赖和包边界。

它不替代 TypeScript、框架检查器、打包器、测试框架或包管理器。Limina 负责把这些工具已经依赖的配置关系显式化，并报告源码、配置和包边界之间不一致的地方。

## 检查器入口

[检查器入口](./config/checkers.md)指定由哪个检查器处理选中的源码 `tsconfig.json`。

自动发现始终启用，即使同时配置了具名检查器范围。它发现普通 `tsconfig.json` 入口，并为每个可达的类型配置在 `tsc`、`tsgo`、`vue-tsc`、`astro`、`svelte-check` 中确定唯一负责的检查器。普通 TypeScript 项目的默认检查器只有在设置 `auto.useTsgo: true` 时才会选择 `tsgo`；具名检查器范围则直接为选中的默认入口提供归属证据。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      auto: {
        exclude: ['**/docs/**'],
        useTsgo: false,
      },
      tsc: {
        include: ['packages/core/tsconfig.json'],
      },
      'vue-tsc': {
        include: ['packages/app/tsconfig.json'],
      },
    },
  },
});
```

入口选择受治理区域约束。具名检查器范围的 `include` 只选择默认源码 `tsconfig.json` 入口，`auto.exclude` 只过滤自动发现的根入口。不要把 `tsconfig.lib.json`、`tsconfig.test.json`、`tsconfig.build.json` 或 `.limina` 下的生成配置直接写进具名检查器范围。`tsconfig.lib.json`、`tsconfig.test.json` 等普通命名源码配置只有经已选中 `tsconfig.json` 的 `references` 触达时才会进入管理范围；保留的 `tsconfig*.build.json`、`tsconfig*.dts.json`、`tsconfig*.base.json` 和 `tsconfig*.check.json` 不属于受管源码入口。`auto.exclude` 与具名检查器范围的 `exclude` 都不会切断已经建立的引用闭包；如果引用触达已激活区域之外的现有普通源码配置，Limina 会报告跨区域引用。

各个固定检查器身份的角色不同：

- `tsc`、`tsgo` 和 `vue-tsc` 可以拥有源码配置，并执行 Limina 生成的声明构建入口；
- `svelte-check` 和 `astro` 负责完整的框架类型配置，按叶子配置执行且不产出声明。

这个区分会影响后续命令。`limina checker build` 运行能生成声明的检查器，`limina checker typecheck` 运行由框架检查器负责的叶子配置。

## 源码配置

源码配置是用户维护的普通 `tsconfig*.json`，位于 `.limina` 之外，且不使用保留的 `.build`、`.dts`、`.base` 或 `.check` 后缀。它决定源码文件集合和类型检查语义，例如 `lib`、`types`、`jsx`、`paths`、`customConditions` 和框架相关设置。

源码配置以规范化的词法路径作为身份标识。源码文件归属索引来自每个配置实际生效的所属文件集合：先按词法路径精确匹配，未命中时再按规范物理身份查找；附近的配置文件名或包名本身不能证明归属，按物理身份查找时若有歧义，会报告输入问题。源码所属包的身份则由已验证的物理包目录另行确定。

常见结构如下：

```text
packages/core/tsconfig.json
packages/core/tsconfig.lib.json
packages/core/tsconfig.test.json
packages/core/tsconfig.tools.json
```

常见布局中，`tsconfig.json` 是入口或聚合配置，`tsconfig.lib.json`、`tsconfig.test.json`、`tsconfig.tools.json` 是源码叶子配置。源码叶子配置应该描述自己拥有的源码文件，不应该手工维护 `references`。Limina 会根据静态导入和 `liminaOptions.implicitRefs` 推导声明构建引用。

`import("./module.js")` 这类字面量动态导入已经参与依赖收集。如果声明构建关系来自生成代码、计算后的运行时导入或其他依赖分析无法观察的关系，可以在源码叶子配置里声明 `liminaOptions.implicitRefs`：

```jsonc
{
  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../contracts/tsconfig.lib.json",
        "reason": "运行时模式定义生成过程通过生成代码导入此项目",
      },
    ],
  },
}
```

`implicitRefs` 的 `path` 必须指向同一检查器可达范围内的普通源码 `tsconfig*.json`，不能指向 `.limina` 生成配置、构建配置、基础配置或自身。

## 聚合配置 {#聚合器配置}

当检查器解析出的文件集合为空，并且配置直接声明了 `references` 时，Limina 才把它视为 TypeScript 聚合配置。文件集合会使用当前检查器解析，因此会考虑 `extends`、`.vue` 等框架扩展名以及 TypeScript 项目规则。`files: []` 显式声明空文件列表，其他配置写法也可能满足这一条件。

```jsonc
{
  "files": [],
  "references": [{ "path": "./tsconfig.lib.json" }, { "path": "./tsconfig.test.json" }],
}
```

只有路径名称恰好为 `tsconfig.json` 的聚合配置才受 Limina 支持。解析后仍拥有源码文件的默认 `tsconfig.json` 属于普通源码叶子配置；如果它同时声明 `references`，Limina 会报告源码引用问题，而不会把它当作聚合配置。`tsconfig.solution.json` 这类带名称的配置虽然可能符合 TypeScript 的聚合配置语义，但不是 Limina 支持的聚合配置入口，不能这样使用。

运行 `limina graph prepare` 时，Limina 会从检查器入口出发，沿着受支持的 `tsconfig.json` 聚合配置的有效 `references` 展开源码配置，并生成检查器实际消费的构建图。

不要把聚合配置当成源码拥有者。需要区分不同运行环境、测试范围或构建目标时，应让聚合配置引用多个源码叶子配置，而不是让一个配置同时承担聚合和源码归属两种职责。

## 输入拓扑与依赖图

只读输入拓扑通过 TypeScript 配置读取器展开已选默认入口与聚合配置引用；它不会锁定解析源码时确定的语义判定依据，也不会建立可执行的检查器图。因此，输入拓扑的 `complete` 状态只证明该次配置与入口拓扑读取没有输入诊断。

下面几类关系必须区分：

| 图视图         | 事实与边界                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 原生引用       | 用户书写的 TypeScript `references`；聚合配置引用建立成员关系，原生叶子构建引用必须从受管源码叶子配置中迁出。                               |
| 补充声明       | `liminaOptions.implicitRefs`；显式声明关系，仍须通过目标、检查器和规则校验。                                                               |
| 已观察源码关系 | 来自已锁定检查器上下文的依赖分析；已观察到部分关系时，`complete` 仍可能为 `false`。                                                        |
| 有效生成图     | 执行所用的有效生成声明引用与 `declaration-provider`（声明提供者）或 `framework-schedule`（框架调度）类型边；并非每个已观察目标都变成引用。 |

不完整的比较不能证明未观察到的原生关系多余。比较不可用时，迁移会把保留的显式关系转为 `implicitRefs` 并报告分析不完整，而不会把缺少证据当作空依赖图。包依赖图导出则另行提供源码与产物两类视图。

## 声明构建配置

声明构建配置是 Limina 生成给构建类检查器使用的内部 `tsconfig`。它们位于：

```text
.limina/tsconfig/checkers/<checker>/projects/.../*.dts.json
.limina/tsconfig/checkers/<checker>/solutions/.../tsconfig.build.json
.limina/tsconfig/checkers/<checker>/tsconfig.build.json
```

项目级声明构建配置会 `extends` 对应的源码配置，并写入明确的 `files`、`compilerOptions`、`references` 和 `liminaOptions`。生成的选项包括：

```jsonc
{
  "compilerOptions": {
    "composite": true,
    "incremental": true,
    "noEmit": false,
    "declaration": true,
    "emitDeclarationOnly": true,
    "declarationMap": false,
    "rootDir": "...",
    "outDir": "...",
    "declarationDir": "...",
    "tsBuildInfoFile": "...",
  },
  "liminaOptions": {
    "generated": true,
    "checker": "tsc",
    "sourceConfig": "...",
  },
}
```

声明文件会写到 `.limina/dts/checkers/<checker>/...`，构建缓存会写到 `.limina/tsbuildinfo/checkers/<checker>/...`。生成的声明配置会把 `outDir` 和 `declarationDir` 同时设为这个受管根目录，因此源码配置继承的 `declarationDir` 不会把检查器输出重定向到用户目录。这些路径属于 Limina 的内部输出，不应该手工编辑，也不应该写进用户维护的源码配置。

生成的声明目录和缓存分区保留完整源配置文件名，避免同目录下的配置在去掉前缀后共用位置。此布局升级会重新生成受管配置，并可能产生一次增量缓存失效。清理只删除此前登记为受管的路径，未登记的文件会保留。

生成的 `references` 来自通过验证的源码编译关系和显式 `liminaOptions.implicitRefs`。仅有源码目标不足以生成引用：关系还需要非空的编译关系需求、有效的声明提供者归属和声明生成能力、相同的最终检查器身份，并且图规则允许。指向 `.d.ts` 系列文件的目标或具体声明提供者仍属于声明消费，不产生新的源码引用。

## 用户产物构建配置

声明构建配置只用于 Limina 内部的检查器构建，不等同于用户发布到 `dist` 的产物。

需要通过 Limina 执行用户侧产物构建时，应在源码叶子配置上声明 `liminaOptions.outputs`，再运行：

```sh
pnpm exec limina build packages/core/tsconfig.lib.json
```

`liminaOptions.outputs` 支持 `target`、`rootDir`、`outDir` 和 `declarationMap`。路径字段相对声明它们的源码配置解析；没有显式设置时，`rootDir` 默认指向源码配置所在目录，`outDir` 默认指向该目录下的 `dist`，`target` 会优先继承源码配置中的 `compilerOptions.target`，否则使用 `ESNext`，`declarationMap` 默认是 `false`。

```jsonc
{
  "liminaOptions": {
    "outputs": {
      "rootDir": "src",
      "outDir": "dist",
      "declarationMap": true,
    },
  },
}
```

Limina 会在 `.limina/tsconfig/checkers/<checker>/outputs/...` 下生成输出构建配置，并用构建类检查器执行它。输出构建缓存会写到 `.limina/tsbuildinfo/build/...`，并由 Limina 管理。没有声明 `liminaOptions.outputs` 的源码配置不能作为 `limina build <config>` 的受管产物构建目标；如果只是想直接调用检查器构建某个原始配置，应使用 `limina build <config> --raw --preset <tsc|tsgo|vue-tsc>`。

生成的用户产物配置会把 `outDir` 与 `declarationDir` 同时设为 `liminaOptions.outputs.outDir`。Limina 当前只支持一个受管产物输出根目录，不表达 JavaScript 与声明文件分离的输出目录。Astro/Svelte 框架叶子配置不支持这类受管产物配置投影，应使用相应应用构建流程。

## 源码边、声明边与产物边

一条 `import` 不一定等于一条 `references`。Limina 会先看这条导入在当前源码配置和检查器语义下解析到哪里，再决定它属于哪类关系。

检查器解析到受管源码目标，只能建立候选源码关系。生成声明引用还要求非空的编译关系需求、有效源码归属、允许的目标，以及由同一检查器最终负责的声明构建端点。即使原解析保留源码路径，具体声明证据也可能阻止新增源码关系。Astro/Svelte 源码关系可以转为 `framework-schedule`（框架调度）边，这类边绝不会成为声明引用；包依赖授权则单独检查源码所属包的清单。

如果 TypeScript 解析结果落到 `.d.ts`、`.d.mts` 或 `.d.cts`，这条导入已经在消费声明文件，不需要再生成源码项目引用。

对于没有受管源码归属方的跨包依赖，只有检查器解析的目标落在已验证输出根内时，`limina graph export` 才会把它归类为产物边；仅有 `dist` 目录名不够。产物边记录对构建产物的消费，不表示 Limina 受管图中的源码 `references`。

对于声明了 `exports` 的工作区包，Limina 会按相关源码配置的解析条件检查公开入口。受治理源码通过包导入访问这些入口时，TypeScript 应该能解析到稳定的类型入口或检查器支持的源码入口。如果实际受治理的导入经该包的 `exports` 只解析到运行时 JavaScript，或检查器没有解析目标，图检查会报告消费问题；它不会扫描未被消费的导出分支，也不会用 Oxc 修复已锁定检查器的解析失败。

## 依赖图导出

`limina graph export` 会以 JSON 导出包节点和跨包边：

```sh
pnpm exec limina graph export --view all
```

可选视图包括：

- `--view source`：只导出源码边；
- `--view artifact`：只导出产物边；
- `--view all`：同时导出两类边。

导出结果用于观察 Limina 当前能证明的包级依赖事实。跨包导出边要求两端包清单都有非空包名；无名包仍可以成为源码归属方，但不能提供具名导出节点，涉及无名包的有效候选边会报告身份错误。导出的节点和边不定义构建任务、包管理器依赖清单或构建顺序。构建顺序仍由 TypeScript 项目引用图和具体执行器决定；包发布产物仍需要由构建、测试、包检查和发布流程共同维护。

## 标签与图规则

源码配置可以通过 `liminaOptions.graphRules` 绑定一组图规则标签。Limina 会把这些标签带到对应的生成声明配置上，并在图检查时使用它们判断哪些引用或依赖不允许出现。

```jsonc
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
}
```

规则在 `limina.config.mts` 中声明：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    rules: {
      'runtime-client': {
        deny: {
          deps: [
            {
              name: 'node:*',
              reason: '浏览器运行时不得导入 Node 内置模块',
            },
          ],
        },
      },
    },
  },
});
```

`deny.refs` 用来禁止项目引用指向某些源码配置，`deny.deps` 用来禁止源码导入某些包、`#imports` 或 Node 内置模块。`allow.refs` 只解释已经存在的额外引用，不会创建引用，也不会覆盖 `deny.refs`。

图规则适合表达浏览器与 Node、公开 API 与内部工具、生产代码与测试代码这类边界。Limina 会把规则、源码导入和生成声明图一起检查；如果带有 `runtime-client` 标签的源码导入了 `node:fs`，图检查会失败，并显示规则里的 `reason`。
