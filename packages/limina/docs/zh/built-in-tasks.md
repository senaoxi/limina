# 内置任务

Limina 的内置任务围绕同一条主线组织：在 `TypeScript` 单体仓库中，把源码 `tsconfig`、`TypeScript` 项目引用、真实导入关系和工作区包关系整理成可检查的工程图，再基于这张图运行类型构建、源码边界和发布期检查。

下面说明内置任务如何分工，以及应该如何理解这些任务的边界。配置字段的完整写法、规则细节和命令行参数请参见配置文档。

## 先理解默认检查

`limina check` 不带流水线名时，会运行五个默认任务：

1. `graph:check`
2. `source:check`
3. `proof:check`
4. `checker:build`
5. `checker:typecheck`

这个顺序是结果展示和记录顺序，不表示默认检查按这个顺序串行执行。默认检查会把这些任务作为独立任务调度；在并发额度和资源锁允许时，它们可以同时运行。某个任务失败会让本次检查失败，但不应理解为它会天然阻塞其他默认任务继续运行。

命名流水线不同。`limina check <name>` 会按照配置中的流水线步骤顺序执行，用于表达明确的先后关系，例如先构建再检查产物。

内置任务可以直接写成字符串：

```js
export default defineConfig({
  pipelines: {
    release: ['graph:prepare', 'checker:build', 'package:check', 'release:check'],
  },
});
```

也可以写成显式对象：

```js
{ type: 'task', name: 'graph:check' }
```

除内置任务外，流水线步骤也可以是外部命令。内置任务失败会让最终结果失败，但不会按失败策略阻塞后续步骤；命名流水线只保证后续步骤等待前一步完成。外部命令步骤失败会阻塞剩余步骤，并把它们记为 `skipped`。

## 任务总览

| 任务                | 默认检查 | 主要关注点                                            | 应该如何理解                                                       |
| ------------------- | -------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `graph:prepare`     | 否       | 生成 `.limina` 下的工程图、声明构建配置和相关生成文件 | 物化生成图；不等同于检查图是否符合规则                             |
| `graph:check`       | 是       | 项目引用、工作区导入、导出解析、图规则和条件域        | 检查 `TypeScript` 项目引用图是否和源码导入关系、配置规则一致       |
| `source:check`      | 是       | 源码归属、包边界、依赖声明、`Knip` 支持的源码使用分析 | 检查源码依赖关系是否能被包归属和清单文件解释                       |
| `proof:check`       | 是       | 源码覆盖证明和 `tsconfig` 角色                        | 检查源码是否进入 Limina 管辖的类型检查范围；具体诊断以实现输出为准 |
| `checker:build`     | 是       | 构建类检查器                                          | 调用底层检查器的构建模式，通常会产出声明文件和构建信息             |
| `checker:typecheck` | 是       | 只检查不产出的检查器                                  | 调用不能作为构建图提供者的检查器，例如部分框架检查器               |
| `package:check`     | 否       | 已构建包产物                                          | 对 `outDir` 产物运行打包、类型解析和产物导入边界检查               |
| `release:check`     | 否       | 发布期产物一致性                                      | 发布前补充检查；不应理解为发布系统或安全保证                       |

核心任务是 `graph:check`、`source:check`、`proof:check`、`checker:build` 和 `checker:typecheck`。`package:check` 与 `release:check` 是发布期补充任务，适合放进发布流水线，但不应放大成 Limina 的核心能力。

## 生成图是后续检查的基础

Limina 的治理建立在生成图之上。生成图来自普通源码 `tsconfig.json` 入口、被这些入口引用到的源码 `tsconfig`、源码文件导入关系，以及少量显式配置。

`checker.include` 选择的是源码层的普通 `tsconfig.json` 入口。普通叶子配置不应该手写 `TypeScript references`；如果某个目录需要聚合多个类型检查环境，应使用默认 `tsconfig.json` 作为聚合器，让它通过 `references` 指向叶子配置。Limina 再根据这些源码配置生成自己的声明构建图。

`graph:prepare` 会把这些关系写到 `.limina` 目录下，包括：

- 检查器构建入口；
- 生成的声明构建 `tsconfig`；
- `solution-style` 构建聚合配置；
- 生成清单；
- 供源码使用分析使用的生成配置。

生成的声明构建配置会继承对应源码配置，并写入适合声明构建的选项，例如 `composite`、`incremental`、`declaration`、`emitDeclarationOnly`、`noEmit: false`、`rootDir`、`outDir` 和 `tsBuildInfoFile`。

这不是在扩展 `TypeScript` 项目引用本身的表达能力。更准确地说，Limina 把“哪些源码关系应该进入 `references` 图”这件事从人工判断和手写维护，转成由源码导入、配置入口和显式例外共同生成，再由检查任务验证。

### 静态导入与显式引用例外

大多数引用边来自源码中的静态导入。假设一个包的源码导入了另一个受管源码项目：

```ts
import { createClient } from '@acme/core';
```

如果这个导入解析到另一个生成声明项目管辖的源码，生成图应包含对应项目引用。这样底层 `tsc -b`、`vue-tsc -b` 或 `tsgo -b` 才能沿着项目引用进行增量声明构建。

也存在静态导入无法表达的关系，例如生成文件、虚拟模块或运行时约定。此时可以在声明该关系的源码 `tsconfig` 中写 `liminaOptions.implicitRefs`：

```jsonc
{
  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../core/tsconfig.json",
        "reason": "由生成的路由清单加载。",
      },
    ],
  },
}
```

`path` 指向另一份普通源码 `tsconfig`，并且需要提供 `reason`。这类配置的作用是说明“这条边为什么应进入生成图”，而不是绕过所有检查。

## graph:check：让项目引用图和源码关系对齐

`graph:check` 检查的是生成图，而不是直接替代 `TypeScript` 编译器。它关心的问题是：当前工程图中的项目引用、源码导入、工作区包关系和架构规则是否能互相解释。

它主要覆盖以下几类问题。

### 项目引用是否有依据

当受管源码通过静态导入访问另一个受管源码项目时，生成的声明构建配置应有对应项目引用。缺少引用会导致增量声明构建无法正确看到上游声明。

反过来，如果生成配置里存在没有静态导入依据、也没有被规则允许的额外引用，`graph:check` 会把它报告出来。这样可以避免生成图里长期保留已经失去依据的边。

如果确实存在静态分析看不见的边，应使用 `liminaOptions.implicitRefs` 或图规则中的允许项说明原因，而不是在普通叶子 `tsconfig` 里手写 `references`。

### 工作区包导出是否适合源码导入

当受管源码通过包名导入工作区包的导出时，Limina 会尝试解析该导出。对于被源码导入的公开入口，解析结果需要能落到稳定的类型入口或检查器支持的源码入口。

这意味着：运行时产物导出可以存在，但如果受管源码直接导入某个导出，而该导出只解析到 `JavaScript` 产物、缺少类型入口，Limina 会把它视为需要修正的边界问题。

这里的目的不是判断包是否一定能发布成功，而是让源码依赖图能被类型图解释。

### 跨包引用是否有依赖声明

跨工作区包的项目引用代表源码层依赖。引用方和被引用方都需要有明确的包身份；引用方还需要在自己的 `package.json` 依赖区中声明被引用包。

这条规则的意义是把 `TypeScript` 项目引用图和包依赖图对齐。否则源码已经依赖另一个包，但清单文件没有记录这条关系，后续构建、检查或发布影响都会变得不清晰。

### 图规则是否被违反

如果源码 `tsconfig` 通过 `liminaOptions.graphRules` 启用了某个图规则，`graph:check` 会按该标签检查被禁止的引用或依赖。

例如，一个面向浏览器的项目不应依赖 `Node` 运行时模块，可以把这类约束写成图规则，再让对应 `tsconfig` 启用该规则。命中规则时，诊断会带上规则中的原因。

需要注意，图规则只覆盖源码和配置表达出来的关系。它不是运行时沙箱，也不是发布安全保证。

## source:check：让源码导入能被包归属解释

`source:check` 关注源码文件属于哪个工作区包，以及源码里的导入是否能被这个归属关系解释。

这和上一节的问题相同：Limina 希望仓库里的依赖关系可追踪。`graph:check` 从 `TypeScript` 项目引用图看问题，`source:check` 从包归属、清单文件和源码导入看问题。

### 相对导入不能跨包边界

相对导入只能在当前最近的 `package.json` 包边界内移动。跨进另一个包目录时，应改用包名导入，并在引用方清单文件中声明依赖。

错误示例：

```ts
import { helper } from '../../core/src/helper';
```

更合适的形式是：

```ts
import { helper } from '@acme/core';
```

这样依赖关系会出现在源码导入和 `package.json` 中，而不是隐藏在目录相对路径里。

### 裸包导入需要授权

裸包导入，例如 `import pMap from 'p-map'`，需要能被当前源码归属方的 `package.json` 解释。Limina 还支持通过 `source.importAuthority.allow` 增加有限的授权来源：按源码归属方分组的授权可以让匹配导入读取工作区根清单中的指定依赖声明。

这类例外应保持具体，不能把它当成“所有包都可以从根依赖里拿”的开关。否则源码归属会重新变得模糊。

### # 子路径导入遵守包作用域

`#utils/*` 这类 `package imports` 会匹配导入文件最近包作用域的 `package.json#imports`。如果这个映射使用相对 `target`，解析结果必须留在声明它的包作用域内。

`imports target` 也可以写成包名，例如 `{ "imports": { "#dep": "p-map" } }`。这种写法表示外部依赖入口，可以解析到三方包或工作区依赖；但授权仍然来自导入文件所属的 `pnpm` 工作区源码归属方，需要在依赖字段里声明，或命中匹配的工作区根依赖授权。

没有匹配会报告 `Unauthorized package import specifier:`，并指向最近的包作用域。匹配后无法解析会报告 `Unresolved package import specifier:`。相对 `target` 越过声明它的包作用域，会报告 `Package import relative target escapes package scope:`。`package target` 未授权时继续使用依赖授权诊断。

### Knip 支持的使用分析是辅助信号

`source:check` 可以使用 `Knip` 支持的分析结果报告两类问题：

- 已声明但未被源码使用到的工作区依赖；
- 从包入口、二进制入口、脚本、插件入口或显式入口不可达的源码模块。

这类检查适合发现明显的遗留依赖和死模块，但不应被理解为完整的运行时可达性证明。对于生成代码、运行时字符串或外部工具加载的入口，应通过带原因的配置项声明例外。

## proof:check：确认源码进入受管检查范围

`proof:check` 的职责是回答一个基础问题：仓库中应被 Limina 管辖的源码文件，是否确实被某个检查器入口、生成图项目或允许清单覆盖。

它和 `source:check` 的区别在于：

- `source:check` 关心源码导入和包归属是否清楚；
- `proof:check` 关心源码是否进入受管类型检查范围，以及 `tsconfig` 的角色是否清楚。

在使用 `TypeScript` 项目引用的单体仓库里，遗漏一个源码文件并不一定会立刻表现为项目引用错误。它可能只是没有被任何检查器入口触达。`proof:check` 用来把这类“没人检查”的文件暴露出来。

如果某个文件确实不应纳入常规检查范围，应使用带原因的允许清单，而不是让它自然漂在工程图之外。

`proof:check` 的诊断分支很多，这里不逐一展开。阅读诊断时，可以把它归到一个原则下理解：每个源码文件、每个 `tsconfig`，都应有明确角色；同一个文件不应在同一检查域里产生重复或冲突的归属。

## checker:build：调用构建类检查器

`checker:build` 会调用构建类检查器。源码中内置的构建类 `preset` 包括：

- `tsc`
- `tsgo`
- `vue-tsc`

这些检查器会以构建模式运行，例如 `tsc -b`、`tsgo -b`、`vue-tsc -b`。运行目标是 Limina 生成的检查器构建入口，而不是用户手写的任意命令。

因为生成的声明构建配置会开启 `emitDeclarationOnly` 并关闭 `noEmit`，所以 `checker:build` 不是无副作用检查。它会运行真实的底层检查器，并可能写出 `.d.ts` 和 `.tsbuildinfo` 等产物。

这点很重要：Limina 没有替代 `TypeScript`、`Vue` 检查器或原生 `TypeScript` 构建逻辑。它做的是准备和检查工程图，然后把类型构建交给对应的检查器执行。

运行前，Limina 会检查已配置检查器需要的 `peer dependency` 是否可解析。缺失依赖时会在执行检查器前失败，并给出安装提示。

## checker:typecheck：调用只检查不产出的检查器

`checker:typecheck` 面向执行类型为“只检查”的预设。源码中内置的这类预设包括：

- `vue-tsgo`
- `svelte-check`

它们通过各自命令运行，例如 `vue-tsgo --project` 或 `svelte-check --tsconfig`。`vue-tsgo` 的入口仍可参与源码图和覆盖证明；`svelte-check` 参与覆盖证明和类型检查执行，但当前不作为源码图提供者。二者都不会产出声明文件。

如果项目只配置了构建类检查器，`checker:typecheck` 可能没有实际检查目标。此时它不应被理解为遗漏了 `TypeScript` 检查；类型构建已经由 `checker:build` 负责。

## graph:prepare 和 graph export

`graph:prepare` 只负责生成或刷新 Limina 的工程图文件。消费生成图的任务会在运行前通过预检机制获取生成图；通常只有在你希望把生成文件显式物化、检查生成文件是否可写或准备后续命名流水线时，才需要单独调用它。

`graph export` 用于导出 Limina 在受管 `tsconfig` 范围内收集到的依赖图。它支持不同视图，例如只看源码边、只看产物边，或同时导出。这个图适合用于架构诊断和外部分析，但不应被当作权威构建顺序来源。

## package:check：检查已构建的包产物

`package:check` 不在默认检查中。它面向已构建的包输出目录，而不是源码目录。

源码中可确认的检查工具选择包括：

- `publint`
- `attw`
- `boundary`

因此它适合放在构建之后，用来补充检查包产物的打包形状、类型解析结果和产物导入边界。它不负责运行包构建，也不应被描述为发布安全保证。

如果某个项目还没有产物目录或产物清单文件，应该先运行该项目自己的构建流程，再运行 `package:check`。

## release:check：发布期补充检查

`release:check` 也不在默认检查中。它面向发布前的产物一致性检查，适合放在发布流水线末尾。

源码中的配置边界显示，`release:check` 包含与依赖产物内容哈希比较相关的配置，例如 `baseline tag`、内置忽略集和自定义忽略规则。也就是说，它关注发布产物之间是否存在可报告的漂移，而不是替代 `npm` 发布流程、版本管理或人工 `release review`。

如果需要把 `release:check` 放进 `CI`，建议把它和项目自己的构建、测试、包产物检查放在同一个命名流水线中，让执行顺序明确。

## 推荐理解方式

可以把这些任务分成三层：

第一层是工程图层：`graph:prepare` 和 `graph:check`。它们回答“当前 `TypeScript` 项目引用图从哪里来、是否和源码导入关系一致”。

第二层是源码治理层：`source:check` 和 `proof:check`。它们回答“源码属于谁、导入由谁授权、哪些文件进入检查范围”。

第三层是执行与产物层：`checker:build`、`checker:typecheck`、`package:check` 和 `release:check`。它们回答“底层检查器是否通过、已构建产物是否暴露出可检测的问题、发布前是否存在可报告的不一致”。

这样理解时，Limina 的边界会更清楚：它不是一个替代 `TypeScript`、框架检查器、打包器、测试框架或发布工具的总控系统；它是在 `TypeScript` 项目引用和生成工程图之上，提供一组让仓库结构、依赖关系、检查范围和发布影响更可预测的检查任务。
