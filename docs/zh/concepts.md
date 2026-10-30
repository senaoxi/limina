# 核心概念

先从熟悉的 TypeScript 配置看起。假设一个包只有 `tsconfig.json` 和 `src/index.ts`：

```text
my-package/
  package.json
  tsconfig.json
  src/index.ts
```

`tsconfig.json` 决定哪些文件属于这个类型检查范围，以及使用什么编译选项。Limina 可以自动发现它，判断源码是否得到预期覆盖，并调用 TypeScript 检查器。你继续维护这份配置。Limina 在 `.limina/` 中生成自己需要的声明构建配置。声明文件（如 `.d.ts`）描述导出的类型，供 TypeScript 在其他位置使用。

项目变大后，浏览器代码和 Node 脚本可能需要不同的类型环境。这时可以分成 `tsconfig.app.json` 和 `tsconfig.node.json`，再用一个不直接包含源码的 `tsconfig.json` 把两者组织起来：

`tsconfig.json`：

```jsonc
{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }],
}
```

这里的 `tsconfig.json` 是**聚合配置**，它告诉 Limina 从哪里找到各份源码配置。实际包含源码的 `tsconfig.app.json`、`tsconfig.node.json` 则是**源码配置**。例如，应用导入工具代码与两份配置同时把同一文件当作自身源码，是不同的事情。清楚的源码归属有助于发现遗漏和重复覆盖。

当两份源码配置之间存在需要声明构建的依赖时，Limina 会结合检查器和源码归属推导相应引用，并另外检查图规则。一条 `import` 不一定需要一条项目引用。例如，导入已有声明文件与导入另一份受管源码的含义不同。

直接包含文件的源码配置也称为**源码叶子配置**。聚合配置只组织其他配置，不直接包含源码。它们的职责如下：

| 文件或配置                  | 谁维护 | 作用                                                       |
| --------------------------- | ------ | ---------------------------------------------------------- |
| 源码配置                    | 用户   | 定义源码范围与类型环境。                                   |
| 聚合配置                    | 用户   | 用默认名称 `tsconfig.json` 组织其他源码配置。              |
| `.limina/` 中的声明构建配置 | Limina | 供支持声明构建的检查器使用，不需要手工编辑。               |
| 发布产物配置                | 用户   | 按需要指定用户产物输出，也可以继续使用项目自己的构建工具。 |

下面先介绍这些配置，再说明检查器、构建和依赖图的区别。只想完成第一次检查时，可以先读[快速开始](./getting-started.md)，遇到范围问题时再回来查阅。

## 源码配置

源码配置是用户维护的普通 `tsconfig*.json`，位于 `.limina` 之外，且不使用保留的 `.build`、`.dts`、`.base` 或 `.check` 后缀。它决定源码文件集合和类型检查语义，例如 `lib`、`types`、`jsx`、`paths`、`customConditions` 和框架相关设置。

Limina 根据每份配置实际包含的文件确定源码归属，而不是仅凭附近的 `tsconfig` 或包名猜测。如果同一实现文件对应多个可能的源码配置，Limina 会报告归属冲突。

常见结构如下：

```text
packages/core/tsconfig.json
packages/core/tsconfig.lib.json
packages/core/tsconfig.test.json
packages/core/tsconfig.tools.json
```

常见布局中，`tsconfig.json` 是入口或聚合配置，`tsconfig.lib.json`、`tsconfig.test.json`、`tsconfig.tools.json` 是源码叶子配置。源码叶子配置描述自己拥有的源码文件，不允许直接声明原生 `references`，空数组也不行。Limina 根据源码导入和受管声明推导声明构建引用，`liminaOptions.implicitRefs` 可以补充分析无法观察到的关系。

::: details 静态分析看不到的声明关系

`import("./module.js")` 这类字面量动态导入已经参与依赖收集。如果声明构建关系来自生成代码、计算后的运行时导入或其他依赖分析无法观察的关系，可以在源码叶子配置里声明 `liminaOptions.implicitRefs`。

例如，假设 `packages/app` 和 `packages/contracts` 都是受治理的工作区包，它们的源码配置都能从检查器入口找到，且 `app` 已声明对 `contracts` 的依赖。如果 `app` 的声明构建需要一条分析无法观察到的关系，可以将以下内容加入 `packages/app/tsconfig.lib.json`：

```jsonc
{
  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../contracts/tsconfig.lib.json",
        "reason": "本叶子的声明构建需要生成的模式代码引用的 contracts 源码。",
      },
    ],
  },
}
```

`implicitRefs.path` 相对声明它的源码配置解析，必须指向同一检查器可达范围内、具有声明构建能力的普通源码叶子，不能指向 `.limina` 生成配置、构建配置、基础配置或自身。这些关系仍须通过图规则。该配置不会补充模块解析能力。

:::

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

## 检查器入口

[检查器入口](./config/checkers.md)指定由哪个检查器处理选中的源码 `tsconfig.json`。

自动发现始终启用，即使同时配置了具名检查器范围。它发现普通 `tsconfig.json` 入口，并为每个可达的源码叶子配置在 `tsc`、`tsgo`、`vue-tsc`、`astro`、`svelte-check` 中确定唯一负责的检查器。普通 TypeScript 项目的默认检查器只有在设置 `auto.useTsgo: true` 时才会选择 `tsgo`；具名检查器范围则直接为选中的默认入口提供归属证据。

例如，默认 `tsconfig.json` 直接包含普通 TypeScript 源码时，可由自动发现交给 `tsc`；若它只引用多个叶子配置，Limina 会沿成员引用递归找到这些叶子，再确定各自的检查器。通常可以先使用默认行为，具体配置见[检查器入口](./config/checkers.md)。

入口选择受治理区域约束。具名检查器范围的 `include` 只选择默认源码 `tsconfig.json` 入口，`auto.exclude` 只过滤自动发现的根入口。不要把 `tsconfig.lib.json`、`tsconfig.test.json`、`tsconfig.build.json` 或 `.limina` 下的生成配置直接写进具名检查器范围。`tsconfig.lib.json`、`tsconfig.test.json` 等普通命名源码配置只有经已选中 `tsconfig.json` 的 `references` 触达时才会进入管理范围；保留的 `tsconfig*.build.json`、`tsconfig*.dts.json`、`tsconfig*.base.json` 和 `tsconfig*.check.json` 不属于受管源码入口。`auto.exclude` 与具名检查器范围的 `exclude` 都不会切断已经建立的引用闭包；如果引用触达已激活区域之外的现有普通源码配置，Limina 会报告跨区域引用。

各个固定检查器身份的角色不同：

- `tsc`、`tsgo` 和 `vue-tsc` 可以拥有源码配置，并执行 Limina 生成的声明构建入口；
- `svelte-check` 和 `astro` 负责完整的框架类型配置，按叶子配置执行且不产出声明。

这个区分会影响后续命令。`limina checker build` 运行能生成声明的检查器，`limina checker typecheck` 运行由框架检查器负责的叶子配置。

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

声明目录和缓存分区保留完整源码配置文件名，避免同目录下的叶子共用输出。生成文件由 Limina 维护。需要刷新时运行 `graph prepare` 或相应检查器命令。

生成的 `references` 可以来自通过验证的源码编译关系、受管声明选定的配置上下文，或显式 `liminaOptions.implicitRefs`。对于实现源码之间的关系，仅有源码目标还不足以生成引用：关系还需要非空的编译关系需求、有效的声明提供者归属和声明生成能力，以及相同的最终检查器身份。图规则另行检查关系是否允许，禁止的关系不会通过从分析中删除它来掩盖。声明文件按声明消费，不能仅凭其路径判断由哪个项目生成。受管声明仍可能需要引用负责检查它的配置。

## 用户产物构建配置

声明构建配置只用于 Limina 内部的检查器构建，不等同于用户发布到 `dist` 的产物。

需要通过 Limina 执行用户侧产物构建时，应在源码配置上声明 `liminaOptions.outputs`。例如，假设工作区已包含 `packages/core`，其 `tsconfig.json` 聚合入口引用了 `tsconfig.lib.json`，后者的源码输入都位于 `src` 目录内。可以把下面的字段合并进 `tsconfig.lib.json`，保留原有的 `compilerOptions` 和 `include`：

`packages/core/tsconfig.lib.json`：

```jsonc
{
  "liminaOptions": {
    "outputs": {
      "rootDir": "src",
      "outDir": "dist",
    },
  },
}
```

然后在工作区根目录运行：

```sh
pnpm exec limina build packages/core/tsconfig.lib.json
```

例如，在适合输出 JavaScript 和声明的 TypeScript 配置下，`src/index.ts` 可以生成 `dist/index.js` 和 `dist/index.d.ts`。包清单等发布文件仍需由项目准备，之后才能运行[包检查](./config/package-checks.md)。

`liminaOptions.outputs` 支持 `target`、`rootDir`、`outDir` 和 `declarationMap`。路径字段相对声明它们的源码配置解析；没有显式设置时，`rootDir` 默认指向源码配置所在目录，`outDir` 默认指向该目录下的 `dist`，`target` 会优先继承源码配置中的 `compilerOptions.target`，否则使用 `ESNext`，`declarationMap` 默认是 `false`。开启 `declarationMap` 可以生成 `.d.ts.map`，但[发布检查](./config/release-checks.md)会拒绝打包内容中的 `.map` 文件；发布前应决定是否将它们排除在发布包之外。

使用相同目录结构时，`outputs: {}` 会默认以包目录为 `rootDir`，因此 `src/index.ts` 的产物位于 `dist/src/`。像上例一样设置 `rootDir: 'src'` 后，产物会直接位于 `dist/`。

Limina 会在 `.limina/tsconfig/checkers/<checker>/outputs/...` 下生成输出构建配置，并用构建类检查器执行它。输出构建缓存会写到 `.limina/tsbuildinfo/build/...`，并由 Limina 管理。没有声明 `liminaOptions.outputs` 的源码配置不能作为 `limina build <config>` 的受管产物构建目标；如果只是想直接调用检查器构建某个原始配置，应使用 `limina build <config> --raw --preset <tsc|tsgo|vue-tsc>`。

生成的用户产物配置会把 `outDir` 与 `declarationDir` 同时设为 `liminaOptions.outputs.outDir`。Limina 当前只支持一个受管产物输出根目录，不表达 JavaScript 与声明文件分离的输出目录。Astro/Svelte 框架叶子配置不支持这类受管产物配置投影，应使用相应应用构建流程。

## 源码边、声明边与产物边

一条 `import` 不一定对应一条项目引用。Limina 先按当前检查器和源码配置解析，再判断关系：

| 观察到的关系                        | 后续含义                                           |
| ----------------------------------- | -------------------------------------------------- |
| 导入当前叶子拥有的源码              | 留在当前项目内部，无需跨项目引用                   |
| 导入另一受管叶子的源码              | 候选源码关系；满足声明需求和检查器条件时可推导引用 |
| 解析到已有 `.d.ts` 系列文件         | 消费该声明，受管声明可能还需要引用负责检查它的配置 |
| Astro / Svelte 等框架间的受支持关系 | 可以形成调度边，不等于声明项目引用                 |
| 无源码归属的目标位于已验证输出根    | 包依赖导出可记录为产物消费，不能据此安排生产构建   |

例如，`app` 通过包名导入 `core/src/index.ts`，两侧都有唯一源码归属、同一构建检查器，且存在声明构建需求时，Limina 可以让 `app` 的生成配置引用 `core` 的生成配置。图规则会另行检查该关系是否允许。若同一导入解析到受管源码覆盖范围之外的构建产物 `core/dist/index.d.ts`，Limina 不会仅凭路径推断生产它的项目。产物更新由项目的构建流程负责。

检查器解析到受管源码目标，只能建立候选源码关系。从实现源码关系推导引用，还要求非空的编译关系需求、有效的源码归属和目标，以及由同一检查器最终负责的声明构建端点。即使原解析保留源码路径，具体声明证据也可能阻止新增源码关系。Astro/Svelte 源码关系可以转为 `framework-schedule`（框架调度）边，这类边绝不会成为声明引用。包依赖授权则单独检查源码所属包的清单。

如果 TypeScript 解析到 `.d.ts`、`.d.mts` 或 `.d.cts`，说明这次导入消费的是声明文件。Limina 不会仅凭该路径反推出生成它的源码项目。受管声明仍可能按[声明上下文规则](./monorepo-constraints.md#选择声明的配置上下文)形成引用。

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
