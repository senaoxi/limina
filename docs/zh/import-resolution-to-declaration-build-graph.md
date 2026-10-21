# 从导入解析到声明构建图

Limina 根据当前检查器和 `tsconfig` 下的依赖事实生成声明构建图。一条导入可以停在 Coverage 边界，也可以证明编译关系。引用投影保留这些事实；Governance 独立判断策略，Build Admission 单独控制执行。

本页解释具体判定过程。若还不清楚包依赖、源码导入和 `references` 的区别，先读[为什么导入不能直接等于引用](./why-import-is-not-references.md)。

## Limina 如何判断一条导入是否需要项目引用

以 `app` 中的一条导入为例：

```ts
import { createClient } from '@acme/core';
```

Limina 先确定这行代码属于哪个源码叶子，使用该项目的检查器语义收集和解析依赖，再判断是否需要另一个项目参与声明构建。对于原生 TypeScript 依赖，这个过程保留四项不同的事实：

| 事实                                   | 回答的问题                                          | 为什么不能单独决定引用                                       |
| -------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| 解析目标                               | 当前检查器把说明符解析到哪个文件，或没有目标？      | 目标可能是现有声明、当前项目源码或其他项目源码               |
| 编译器输入情况                         | 原始解析目标是否进入当前有界 TypeScript `Program`？ | 被编译器读到不等于归当前源码叶子所有，也不等于它实际提供类型 |
| 类型证据（`TypeEvidence`）             | 类型来自检查器源码、具体声明、环境声明，还是缺失？  | 类型来源与原始解析路径可能不同                               |
| 编译关系需求（`referenceRequirement`） | 是否已证明存在编译义务，引用结构是否满足？          | 义务、结构和产物状态独立；还需合法投影和构建准入             |

这里的 `Program` 是检查器用于分析一组文件的 TypeScript 程序上下文。“声明提供者”则是为这条构建关系提供声明输出的受管源码叶子。

### 先收集具有源码来源的依赖

Native TypeScript 使用编译器实际产生的请求 inventory，保留静态导入、再导出、类型导入、动态导入、隐式 types/lib/JSX 请求及实际编译器模式。JavaScript 的 require 依照编译器行为观察；TypeScript 中普通 require、createRequire 和 require.resolve 仍用于独立的运行时及包治理，但不自动生成 Native 项目引用。导入首先属于其源码叶子的上下文，测试配置中的导入不会仅因同包而变成库配置的引用。

Vue、Astro 和 Svelte 的解析语义确定后，收集基于官方生成的 TypeScript 表示。每条生成依赖必须严格映射回用户源码，才能参与图推导。只有合成来源、无法映射回源码的依赖保留为观察记录，不创建边；损坏或有歧义的映射会使分析失败。

语义表示中的说明符可能不同于源码文本。例如 Vue 的 `<script src="./entry.ts">` 可能被报告为 `./entry.js`，但文件与行号仍指向原始源码。工具链条件见[检查器配置](./config/checkers.md)。

### 再判断是否存在编译关系需求

Native 将三项问题独立记录：是否存在编译义务、真实 reference/redirect 结构是否满足它、所需声明产物是否可用。解析到另一个项目的文件、命中 owner 或获得 TypeEvidence，均不能单独证明编译义务。

| 已有证据                     | 摘要                |
| ---------------------------- | ------------------- |
| 已证明存在义务，结构尚未满足 | `required`          |
| 已证明存在义务，结构已经满足 | `already-satisfied` |
| 已证明不存在该项义务         | `not-required`      |
| 其余证据不足的情况           | `unknown`           |

`already-satisfied` 只说明结构，不意味着声明已经构建。产物还可以是 missing、stale 或 unknown，文件存在也不等于可用。源码和生成声明配置的选项分别参与证明；`noResolve` 或 augmentation 的解析成功不自动产生引用。类型供给是独立按需证明，不能创造或抹除编译义务。

预期的无覆盖边界、解析 miss 或 unknown 只停止对应分支，不自动生成治理诊断或使整个分析失败。配置解析、读取或编译器初始化故障会记录影响范围；独立上下文仍可保留证据，但不可信事务不能发布成功构建计划。真实编译错误由最终 Checker 报告。

### 最后校验目标并生成关系

投影已证明的编译关系时，Limina 检查：

1. 目标是否属于另一个受管源码叶子，且归属唯一。
2. 目标能否提供声明构建输出。
3. 两端最终是否由同一个 `tsc`、`tsgo` 或 `vue-tsc` 检查器负责。

合格关系将源码叶子映射到 `.limina/tsconfig/checkers/<checker>/projects/` 下的声明配置及其生成的 `references`。同一叶子内部的依赖不生成自引用；没有受管源码归属的外部依赖也不因此获得工作区内部引用。

Governance 独立检查图规则。被拒绝的关系仍保留在证据及引用投影中，使违规继续可见，不能通过删除关系把图包装成完整图。未知关系保留未解决状态，不凭空生成 reference。Build Admission 单独决定计划是否可执行，只有可信事务才能发布成功计划。

`package.json` 中的依赖声明负责包导入授权，不能代替以上证据。仅有包依赖、文件存在或运行时解析成功，都不足以生成声明引用。

## 解析到现有声明时，谁负责更新它

假设 `core` 的公开入口同时包含类型和运行时分支：

```json [packages/core/package.json]
{
  "name": "@acme/core",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./src/index.ts"
    }
  }
}
```

检查器选中 `dist/index.d.ts` 时，未选中的 default 源码分支不产生引用，也不能从声明路径反推出生产者。

Native 对每个到达的声明检查 Source Config Coverage：当前激活的配置全集是否完整枚举、该文件是否具有当前有效成员与物理身份。唯一或已确认多成员的声明可以继续；无覆盖或无法确定时记录并停止。相对导入、paths、包入口、标准库、第三方和 Bundler 产物均不自动豁免。声明根仍按原配置保留，types/lib 和原始 references 不删除。

`app → index.d.ts → helper.d.ts → feature.ts` 只有 index 与 helper 都有可用覆盖才继续；到 feature.ts 后停止其内部遍历。只有独立编译义务证明成立时，才产生到 feature 所属项目的引用。声明 membership 本身不标识生产者。

原始引用结构和产物状态分别保留。输出缺失不抹掉真实 reference，reference 存在也不保证输出准备完成。生产实际产物的工作流与最终 Checker 负责构建、诊断及新鲜度。

## 声明引用与框架调度

Limina 分别记录两种执行关系：

| 边类型                               | 用途                               | 是否写入生成的 `references`    |
| ------------------------------------ | ---------------------------------- | ------------------------------ |
| `declaration-provider`（声明提供者） | 上游项目先提供声明供下游构建消费   | 是；两端必须使用同一构建检查器 |
| `framework-schedule`（框架调度）     | 安排受支持框架目标的检查或构建顺序 | 否；可以跨检查器身份           |

例如，Astro 源码导入 Vue 组件，且 Astro 工具链确认目标后，这条关系可以把目标的 Vue 工作安排在消费方之前。它不会给 Astro 叶子制造一个声明项目。Astro 和 Svelte 检查器按叶子运行类型检查，本身不生成声明；如果其中的 TypeScript 代码需要独立声明输出，应拆到可构建的源码配置。

纯框架调度循环可以按一个调度连通分量处理。声明项目引用循环仍然失败，因为它不能作为独立声明项目的先后关系执行。

### 检查器身份为何会传播

在生成路径和执行目标之前，通过已证明的编译关系、聚合成员或 `implicitRefs` 连接，且需要共享声明缓存的可构建配置会组成一组。只有一个已知检查器身份时，它传播到整组；没有已知身份时，使用普通 TypeScript 默认检查器；同时存在不同身份时，图准备失败。成功的声明提供者边记录 `cacheReuse: "reusable"`。

这里的已知身份来自具名检查器约束或已确认的框架等归属证据。普通 TypeScript 的默认值只在整组仍无已知身份时采用：自动发现的 shared 叶子连接 Vue 叶子时，可以一起使用 `vue-tsc`；若把 shared 显式固定为 `tsc`，同一组同时需要 `tsc` 与 `vue-tsc` 就会冲突。

执行身份与解析语义分开确定。普通 TypeScript 项目可以因为与 Vue 项目共享声明缓存而由 `vue-tsc` 构建，其已确定的依赖语义仍然是 TypeScript，不会重新按 Vue 解释。

## 检查器解析失败不能由运行时解析补救

项目的解析语义一旦确定，检查器没有解析目标就是没有目标。Oxc、工作区导出解析、文件存在性、资源后缀或虚拟模块允许清单，都不能在声明推断路径上补出一个新目标。

在最初推断检查器归属、且类型证据为 `missing` 时，Oxc 只用于识别符合条件的物理框架候选。它不为已经确定语义的项目提供后备解析器。独立的物理资源检查与运行时视角的源码检查，也不会代替检查器生成声明引用。

对实际观察到的具名工作区包导入，优先修复类型入口、`moduleResolution`、`paths`、`customConditions` 或检查器工具链。仅有环境声明的语义观察记录属于另一种情况，不能据此断言运行时目标存在。

## 静态分析看不到的关系

代码生成、路由清单或插件装配可能形成静态分析暂时看不到的声明构建关系。这时在源码叶子中添加带原因的 `liminaOptions.implicitRefs`。它补充图关系，但仍须满足目标、检查器和规则约束，不提供缺失的解析能力。

配置示例见[静态导入看不到的边要显式声明](./why-import-is-not-references.md#静态-import-看不到的边要显式声明)。用户仍维护聚合入口的成员 `references`；这里补充的是源码叶子之间的声明关系。

## 为什么没有对引用图做裁剪

**当前实现不分析最终 `.d.ts` 来删除引用。** 生成图依据经过校验的源码编译关系和显式 `implicitRefs`，因此可能比最终声明文件的依赖图更宽。

例如，这条导入只出现在函数实现中：

```ts
import { initCore } from '@acme/core';

export function startApp() {
  initCore();
}
```

最终声明可能只剩：

```ts
export declare function startApp(): void;
```

但生成这份声明之前，检查器仍需理解源码关系。不能仅看导入是否标为 `type` 或是否出现在导出语句，就判断它对声明无影响。类型推断可能把实现中使用的类型带到公开接口：

```ts
import { createClient } from '@acme/core';

export const client = createClient();
```

其声明可能包含 `import('@acme/core').Client`。再导出、类成员、泛型约束和条件类型等也可能保留上游类型。可靠裁剪需要另行分析声明语义、输出来源与新鲜度，并处理框架和声明打包器差异；当前没有提供这项能力。

这个取舍有两个直接影响：上游源码变化可能影响更宽的增量检查范围；跨叶子运行时循环即使没有出现在最终声明中，也可能形成生成引用循环。显式收窄公开 API 类型有助于控制声明泄漏，却不会自动删除仍由源码关系推导的引用。

处理这类循环需要调整源码或声明边界，而不是手动删除 `.limina` 引用。合并包内强耦合范围、抽出共享契约、上移运行时装配等示例见[循环处理](./why-import-is-not-references.md#运行时循环不等于项目引用循环)。

## 图检查如何使用这套判断

图检查会在内存中计算声明构建图，再对照源码导入事实检查是否一致；它不会写出 `.limina` 下的检查器文件。`graph prepare` 和需要生成检查器配置的执行路径才会把同一张图物化到磁盘。

在 `references` 完整性检查中，图检查也使用声明提供者分类：

- 单独的声明目标不要求到其生产配置的引用；合法声明闭包可以在第一个实现终点贡献编译需求。
- 如果依赖具有非空声明关系需求并到达有效源码提供者，图检查会验证对应项目引用。
- 如果 `TypeScript` 不能确认声明提供者，图检查不会根据 `Oxc` 的运行时解析结果补出项目引用。
- 多余引用检查针对可达且含文件的声明项目，跳过生成的检查器根、已预期的边、可达项目集合之外的目标、同一生成检查器命名空间内的引用和允许规则；剩余引用可能被报告为多余。
- 如果生成声明项目之间形成循环，图检查会报告项目引用循环。

同一检查器下的合法生成引用属于上述跳过范围，因此这项“多余引用”检查不证明当前生成图逐边最小。额外引用诊断只针对筛选后剩余的可达声明目标；不要为了触发或消除该诊断去手改生成文件。

不过，图检查不只关心声明提供者。和包入口、运行时解析、依赖声明、边界规则相关的检查，仍可能使用其他解析结果作为证据。这里讨论的是 `references` 推断和 `references` 完整性检查这条主线。

## 常见诊断怎么理解

### 无法解析工作区导入 {#unresolved-workspace-import}

原始诊断消息为 `Unresolved workspace import`。这个诊断适用于实际观察到的具名工作区包导入：消费方检查器没有解析目标。它不报告 Oxc 和 TypeScript 的比较。

优先检查包类型入口、`tsconfig` 的模块解析配置、路径别名和检查器配置。只有环境声明的语义观察记录和未观察到的生成依赖，不按未解析工作区消费处理。

### 工作区源码导入使用的包导出缺少类型入口 {#workspace-source-import-uses-package-export-without-a-type-entry}

原始诊断消息为 `Workspace source import uses package export without a type entry`。这个诊断表示：受治理的工作区源码导入通过 `package.json#exports` 进入包入口，但这个入口没有稳定的 `TypeScript` 类型入口或检查器源码入口。

如果这是面向源码治理的入口，建议补充类型声明分支，或改为导入稳定的公开类型入口。如果它只是运行时资源，应避免把它作为受治理源码的类型依赖入口。

### 工作区导入缺少项目引用 {#missing-project-reference-for-workspace-import}

原始诊断消息为 `Missing project reference for workspace import`。这个诊断表示：静态导入到达了另一个需要声明输出的源码提供者，但当前生成声明配置中没有对应项目引用。

先检查两端是否属于预期的检查器范围，并确认各自的默认 `tsconfig.json` 已被自动发现或具名检查器范围选中。显式 `include` 不是必需条件。`tsconfig.lib.json`、`tsconfig.test.json` 等命名终端配置必须能从已选入口的有效 `references` 闭包到达；将这些叶子配置路径直接放入 `include` 会被拒绝。

例如，根 `tsconfig.json` 被自动发现或显式选中后，可用成员引用纳入命名叶子：

```json [tsconfig.json]
{
  "files": [],
  "references": [
    { "path": "./packages/app/tsconfig.lib.json" },
    { "path": "./packages/app/tsconfig.test.json" }
  ]
}
```

```sh
pnpm exec limina graph prepare
pnpm exec limina graph check
```

也支持经过另一个默认聚合配置的链路（`tsconfig.json → packages/app/tsconfig.json → tsconfig.lib.json`）。中间聚合配置必须使用默认名称 `tsconfig.json`。终端源码配置不要手工维护构建引用；Limina 根据提供者证据推导它们的声明引用。选择与闭包规则见[检查器配置](./config/checkers.md)。如果诊断仍然存在，重新生成不能代替检查实际提供者证据。

### 额外项目引用缺少静态导入证明 {#extra-project-reference-not-proven-by-static-imports}

原始诊断消息为 `Extra project reference not proven by static imports`。这个诊断表示：某条引用经过上述有范围限制的多余引用检查后，仍未获得对应证明。

如果它是真实但源码分析看不到的声明关系，用源码叶子配置的 `implicitRefs` 表达；`graph.rules.<label>.allow.refs` 只解释图中已有的额外引用，不创建引用；否则修正不正确的源码关系并重新生成。`.limina` 中的配置继续由工具维护。

### 生成的项目引用形成循环 {#generated-project-reference-cycle}

原始诊断消息为 `Generated project reference cycle`。这个诊断表示：生成的声明项目 `references` 形成了循环。循环可能来自互相依赖的源码声明关系或显式 `implicitRefs`。成功的 `declaration-provider` 边使用相同的最终检查器身份；相冲突的构建检查器身份会使准备失败。

优先检查循环中的源码边界是否过细、共享类型是否应该下沉、运行时装配是否应该上移。完整修复示例见[运行时循环不等于项目引用循环](./why-import-is-not-references.md#运行时循环不等于项目引用循环)。
