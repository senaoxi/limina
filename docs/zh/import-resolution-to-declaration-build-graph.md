# 从导入解析到声明构建图

在多包仓库中，`tsc -b` 通过 `references` 确定项目之间的构建关系。

判断当前 `tsconfig` 是否需要项目引用时，需要区分包导入、通过 `exports.types` 消费的 `dist/index.d.ts`、测试配置中的导入和运行时循环。这些关系对声明构建的影响可能不同。

`references` 配置错误会影响 TypeScript 的构建顺序、增量缓存和上游声明消费。缺少引用可能遗漏声明构建依赖；多余引用可能增加不必要的构建依赖，甚至形成项目引用循环。

在用户声明的源码类型配置范围内，Limina 根据当前检查器和 `tsconfig` 确认每条导入的类型提供者，再校验这条关系应生成 `references`、作为声明文件消费，还是产生诊断。导入和 `package.json` 依赖不会直接成为构建引用。

本页说明导入如何参与声明构建图推断，以及当前实现为什么不按最终 `.d.ts` 的依赖裁剪引用图。

## 手动维护引用图为什么容易出错

先看一个普通导入：

```ts
import { createClient } from '@acme/core';
```

对于 TypeScript 声明构建，需要确认当前 `tsconfig` 使用哪个类型提供者：

```text
当前 tsconfig 的声明构建，需要从哪里获得 createClient 相关的类型声明？
```

在多包仓库里，这条导入可能对应不同关系。

`TypeScript` 可能解析到 `packages/core/dist/index.d.ts`。这说明当前项目消费的是已经存在的声明文件，而不是另一个源码项目。

`TypeScript` 也可能解析到 `packages/core/src/index.ts`。这说明当前项目可能需要另一个源码范围先产生声明输出。

它还可能解析到外部包声明或 `Node` 内建模块。这类关系通常不属于工作区内部的 `references` 关系。

如果 `TypeScript` 在当前配置下无法解析这条导入，则说明类型入口、`tsconfig` 配置或包边界可能需要修正。

生成引用需要当前检查器和 `tsconfig` 语义下的类型提供者证据。仅有导入语句或解析后的文件还不够。

手动维护 `references` 时，用户需要持续判断这些边界。仓库越大，`tsconfig` 越多，越容易出现几类问题：

```text
把 package.json 依赖误写成 TypeScript references
把消费 .d.ts 的关系误写成源码项目引用
忽略测试、脚本、源码配置之间的文件范围差异
遗漏静态 import 看不到但声明构建确实需要的边
把运行时循环带进 TypeScript 项目引用图
```

Limina 在生成引用图时重复执行这些检查。

## Limina 如何判断一条导入是否需要项目引用

推断引用时，Limina 会收集导入、确认提供者并校验关系：

```text
源码文件
  -> 收集 import/export 模块标识符
  -> 判断 TypeScript 声明提供者
  -> 映射为项目引用、声明文件消费或诊断
```

第一步只收集源码里可以静态识别的模块标识符，例如静态导入、再导出、类型导入、动态导入中的模块字符串，以及部分可以静态识别的 `CommonJS` 形式。这个阶段只记录源码事实，例如哪个文件、哪种导入形式、哪个模块标识符。到这里还不会判断是否合法，也不会判断是否需要生成 `references`。

对于 Vue、Astro 与 Svelte 源码，解析源码时确定的语义判定依据（后文简称“语义判定依据”）锁定后，第一步基于官方生成的 TypeScript 表示，而不是轻量框架收集器。Limina 使用所属工具链的 TypeScript 实例枚举生成依赖，通过严格反向映射证明源码来源，并记录生成后的语义写法。例如源码 `<script src="./entry.ts">` 可能报告为 `./entry.js`；文件与行号仍指向原始框架源码。没有源码投影的合成依赖只形成不产生边的观察记录。

第二步记录检查器或工具链的解析目标与现有 `TypeEvidence`，并把编译关系需求保持为独立事实。原生 TypeScript 事实还记录原始目标是否进入有界的 TypeScript `Program`。物理解析、文件纳入 `Program` 与实际类型供给各自独立，任何一项都不能单独作为生成引用的依据。

| 解析 / 类型证据                                            | 编译关系与解释结果                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| 物理 `.d.ts` / `.d.cts` / `.d.mts`，或实际的具体声明提供者 | 不新增源码关系，即使原始解析同时保留源码路径。                            |
| 当前配置内的源码                                           | 不生成跨项目引用。                                                        |
| 其他受管配置的源码，且编译关系需求非空                     | 候选声明关系；仍须校验归属、检查器能力、身份与规则。                      |
| 环境声明类型配合尚未被编译器输入覆盖的本地源码             | 可能需要 `compiler-membership`；环境声明证据并不一概阻止引用。            |
| 源码目标没有当前类型提供者                                 | 可以保留 `source-semantic` 需求；`missing` 证据不是类型供给证明。         |
| 没有受管源码归属方的外部依赖                               | 不生成内部工作区项目引用。                                                |
| 目标为空但有环境模块声明证据                               | 带类型的 `semantic-only` 观察记录；不能证明物理运行时资源或虚拟模块存在。 |
| 目标为空且证据为 `missing`                                 | 未解析观察记录；依赖比较变为不完整，并记录诊断。                          |

第三步校验候选关系。允许的声明关系指向具有相同最终构建检查器的其他受管源码配置时，Limina 才将它映射到生成 `.dts.json` 并加入项目引用。Astro/Svelte 关系可以转为框架调度边；指向同一配置的目标不会形成自引用。

这也是 Limina 和普通模块解析器的区别。语义判定依据一旦锁定，检查器解析失败就不能由 Oxc、工作区导出解析、文件存在性、资源扩展名启发或虚拟模块允许清单来补救。分类过程可以继续使用检查器或类型证据，但解析过程不能补出新目标。在这条声明推断路径中，Oxc 只在归属尚未确定、且证据为 `missing` 时参与初始推断。独立的物理资源检查与运行时视角的源码检查不会替已锁定检查器生成新的语义目标。

## 自动生成引用图需要考虑的具体场景

生成引用时，需要判断导入是否要求当前声明构建消费另一个源码范围的声明输出。以下场景会影响这个判断。

### 只有 `package.json` 依赖，不代表需要项目引用

一个包在 `package.json` 里声明了工作区依赖，只说明这个包可以使用另一个包：

```json
{
  "dependencies": {
    "@acme/core": "workspace:*"
  }
}
```

这不能直接推出当前 `tsconfig` 需要引用 `@acme/core`。如果当前 `tsconfig` 管辖的源码没有导入 `@acme/core`，或者导入没有解析到 `@acme/core` 的受管源码范围，就不应该因为包级依赖生成项目引用。

`package.json` 依赖更适合用于检查跨包使用是否有依赖声明；`references` 表达的是声明构建顺序。两者有关联，但不能互相替代。

### 导入不属于当前 `tsconfig` 管辖范围，不影响当前声明图 {#import-不属于当前-tsconfig-管辖范围-不影响当前声明图}

同一个包里可能存在多个 `tsconfig`：

```text
packages/app/
  tsconfig.lib.json
  tsconfig.test.json
  tsconfig.scripts.json
```

如果 `tsconfig.test.json` 管辖的测试文件导入了 `@acme/core`，这不意味着 `tsconfig.lib.json` 也需要引用 `@acme/core`。Limina 生成引用图时只考虑当前源码类型配置实际管辖的文件集合。

判断是否需要项目引用时，第一步应先确认导入发生在哪个 `tsconfig` 的源码范围内。

### 解析到已有声明文件时，不反推源码项目引用

如果 `TypeScript` 解析到的是：

```text
packages/core/dist/index.d.ts
```

或：

```text
packages/core/src/index.d.ts
```

Limina 会把它视为声明文件消费。即使这个包属于当前工作区，Limina 也不会反向推断它背后的源码 `tsconfig`，再补一条源码项目引用。

这条边的含义是：

```text
当前项目消费已有声明文件；
该声明文件的新鲜度由声明提供方自己的构建、监听、CI 或发布流程维护。
```

Limina 不会因为消费 `.d.ts`，就自动构建或刷新这个 `.d.ts`。

### 解析到当前范围源码时，不需要跨项目引用

如果导入解析到当前 `tsconfig` 自己管辖的源码文件，这只是当前范围内部依赖，不需要生成项目引用。

例如：

```text
packages/app/src/index.ts
packages/app/src/client.ts
packages/app/tsconfig.lib.json
```

如果 `index.ts` 导入 `client.ts`，并且二者都属于 `tsconfig.lib.json`，那么不需要生成任何跨项目引用。这类关系由当前 `tsconfig` 自己处理。

### 解析到另一个受治理源码范围，可能需要项目引用

另一个受治理源码范围中的目标只是候选。生成声明引用还需要非空的编译关系需求、可构建的声明提供者、相同的最终检查器身份，以及图规则允许。即使记录了源码目标，具体声明证据仍可能终止源码关系。

例如：

```text
packages/app/src/index.ts
  -> packages/core/src/index.ts

packages/app/tsconfig.lib.json
packages/core/tsconfig.lib.json
```

如果 `packages/app/tsconfig.lib.json` 管辖的源码导入 `@acme/core`，`TypeScript` 把它解析到 `packages/core/src/index.ts`，并且这条关系满足上述条件，Limina 才把 `core` 的源码配置映射到生成的 `.dts.json`，再从 `app` 的生成声明配置添加项目引用。

这条项目引用表达的是声明构建依赖，不是包发布关系，也不是运行时打包关系。

### 静态导入看不到的真实边，需要显式表达

有些依赖关系不会直接出现在源码 `import/export` 里。例如代码生成、路由清单、插件注册、运行时清单或框架约定带来的关系，可能在构建后才变成真实模块连接。

Limina 不从字符串、清单或项目约定推断这些声明构建边。

如果这类关系确实属于声明构建图的一部分，应通过 `liminaOptions.implicitRefs` 显式声明。它的含义是：这条边无法从静态导入记录证明，但用户明确声明它是当前源码范围的声明构建依赖。

`implicitRefs` 声明静态导入看不到的关系，每条关系仍须接受图规则检查。它不是导入允许清单，也不能绕过规则。

### 运行时能解析，不代表检查器提供者成立

运行时解析器找到文件，不代表当前检查器和 `tsconfig` 下存在类型提供者。对于实际观察到的具名工作区包导入，消费方检查器没有解析目标时，`graph check` 报告 `Unresolved workspace import`。只有环境声明的 `semantic-only` 观察记录是另一种情况，并不证明物理运行时目标存在。

检查类型入口、`moduleResolution`、`exports.types`、`paths`、`baseUrl`、`customConditions` 和检查器配置。修复方向是提供所需检查器证据；仅有运行时解析结果不能修复已锁定语义下的解析失败。

### 声明提供者必须使用同一检查器身份

生成路径和执行目标前，Limina 会把通过允许的编译关系、聚合配置闭包或 `implicitRefs` 连接、且能生成声明的配置组成连通分量。已有的唯一检查器身份会传播到整个连通分量；尚未确定身份的连通分量使用普通 TypeScript 默认检查器。`tsc`、`tsgo` 或 `vue-tsc` 身份冲突会使准备失败；成功的 `declaration-provider` 边两端检查器必须相同，且 `cacheReuse: "reusable"`。

语义判定依据在构建检查器身份传播前已经冻结。因此普通 TypeScript 项目可以由 `vue-tsc` 执行，而不把依赖重新解释为 Vue 语义。

执行关系须分别理解：

```text
declaration-provider（声明提供者）
  -> 生成 TypeScript 项目引用，两端构建检查器身份相同

framework-schedule（框架调度）
  -> 执行排序，可跨检查器身份，不生成项目引用
```

Astro 与 Svelte 叶子配置不生成声明项目。提供方被调度不代表它能供应可消费声明。已有的具体 `.d.ts` 仍是声明消费边界，不会因输出归因而获得新的源码引用。

### 生成的 `references` 不能形成项目引用循环

运行时模块系统允许一定形式的循环依赖，但 `TypeScript` 项目引用是构建排序关系。生成的声明 `references` 需要能够被构建类检查器排序执行。

如果两个源码范围互相导入，Limina 可能生成这样的关系：

```text
packages/a/tsconfig.dts.json -> packages/b/tsconfig.dts.json
packages/b/tsconfig.dts.json -> packages/a/tsconfig.dts.json
```

这类图无法作为稳定的声明构建顺序。Limina 的图检查会把生成声明项目的实际 `references` 当成有向图，并在存在多节点强连通分量或自引用时报告循环问题。

源码模块仍可在同一个项目内存在循环。生成声明引用之间的循环需要处理，例如合并强耦合源码范围、抽出共享契约、将运行时装配移到上层入口，或使用明确维护的声明边界。

## 为什么没有对引用图做裁剪

两个模块可能在运行时互相调用，但最终 `.d.ts` 并不互相引用。Limina 仍可能根据它们的源码关系生成引用循环。

这里讨论的是通过 TypeScript `references` 生成的声明项目引用图。按最终 `.d.ts` 的依赖裁剪，需要在源码提供者关系之外另做分析。

未来若分析已生成的声明，可能移除只用于运行时实现的边，以及部分由实现耦合引起的项目引用循环。这需要确认哪些依赖仍保留在最终声明产物中。

例如：

```ts
import { initCore } from '@acme/core';

export function startApp() {
  initCore();
}
```

最终声明可能只是：

```ts
export declare function startApp(): void;
```

这里 `@acme/core` 没有出现在导出声明中。一个以最终 `.d.ts` 为目标的最小化算法，理论上可以剪掉这条边。

再看一个显式收窄导出类型的例子：

```ts
import { createClient } from '@acme/core';

export interface ClientInfo {
  id: string;
}

export function createInfo(): ClientInfo {
  const client = createClient();
  return { id: client.id };
}
```

如果最终 `.d.ts` 只暴露 `ClientInfo`，不引用 `@acme/core` 的类型，那么这条源码依赖也可能不需要出现在最小引用图中。

可靠的裁剪需要分析当前 `tsconfig` 生成的 `.d.ts` 是否仍引用目标声明提供者，不能只依据源码中的 `import` 形态。

很多类型关系只有在声明生成后才会显现。

例如，导出值可能通过类型推断泄漏上游类型：

```ts
import { createClient } from '@acme/core';

export const client = createClient();
```

最终声明可能变成：

```ts
export declare const client: import('@acme/core').Client;
```

这种情况下，`@acme/core` 仍然属于最终声明产物，不能剪掉。

导出函数也有类似问题：

```ts
import { createClient } from '@acme/core';

export function createAppClient() {
  return createClient();
}
```

如果返回类型没有显式收窄，`TypeScript` 可能在 `.d.ts` 中暴露来自 `@acme/core` 的类型。源码里看起来只是实现依赖，但最终声明仍然需要上游类型。

再导出、`class` 的公开或受保护成员、泛型约束、条件类型、映射类型和入口文件转发，也可能把上游类型带进声明产物。因此，移除引用需要分析声明产物的语义，不能只把源码导入归类为实现依赖。

当前引用推断读取源码依赖事实和显式 `implicitRefs`，不会分析已生成的 `.d.ts` 来删除边。这里讨论的声明产物分析是一种可能的未来设计，不是已实现行为或性能保证。

如果在这种模型下默认执行引用图裁剪，Limina 需要额外处理几类问题：

- 如何高效获得或推导每个源码 `tsconfig` 的最终声明产物；
- 如何区分 `TypeScript` 原始 `.d.ts`、框架检查器输出、声明打包器产物和包公开 API 形态；
- 如何避免根据过期 `.d.ts` 产物剪掉真实需要的项目引用；
- 如何在源码频繁变化时复用上一次声明产物分析结果，而不是每次检测都重新做完整语义分析；
- 如何解释被剪掉的边，尤其是当它们仍然存在于源码 `import` 图中时。

这些问题超出了当前引用生成路径。Limina 从实际管辖的源码输入收集冻结语义判定依据下的事实，验证编译关系需求和检查器归属，加入显式补充边，生成 `references`，再检查声明图。

这个取舍会让引用图比最终声明产物更宽。某些运行时实现依赖即使不会出现在最终 `.d.ts` 中，也可能参与生成的 `references`。

最直接的影响是增量声明构建的依赖范围可能更宽。只要 A 的源码导入解析到 B 的受管源码范围，Limina 就可能生成 A -> B 的声明构建引用。即使 A 最终 `.d.ts` 没有引用 B，B 的变化也可能影响 A 的构建排序和增量检查路径。这是一个更保守的构建图，而不是最终声明产物的最小依赖图。

另一个影响是循环依赖会更早暴露。两个源码范围如果只是运行时互相调用，最终声明产物未必互相引用；但在 Limina 当前的生成图里，这组源码导入仍然可能形成生成项目引用循环。这个诊断不一定说明最终 `.d.ts` 会循环引用，而是说明源码层面的声明提供者关系已经跨过了独立的 `tsconfig` 边界，无法作为 `TypeScript` 项目引用图稳定排序。

当前实现中，管辖源码导入具有通过验证的编译关系需求时，即使它的类型不出现在最终声明产物中，也可能生成声明引用。用户不应该通过手动删除生成的项目引用来处理这类问题；如果这条边来自真实源码 `import`，删除生成的项目引用只会让生成图和源码事实不一致。

可根据源码关系选择以下处理方式：

- 为导出值或导出函数标注公开 API 类型，控制声明类型泄漏；这一步本身不会删除仍由源码导入推断出的引用；
- 如果两个源码范围强耦合，把它们放进同一个源码 `tsconfig`，让循环留在项目内部；
- 如果循环来自共享类型、协议或抽象，抽到更低层的 `contracts` / `shared` 模块；
- 如果循环来自启动、注册或插件装配，把装配代码移动到更上层入口；
- 如果一侧本来就是声明边界，通过明确维护的 `.d.ts` 暴露类型，并由用户自己的构建流程维护新鲜度。

这些处理调整的是源码关系或声明边界。Limina 会根据调整后的源码事实生成引用，仍不按最终 `.d.ts` 的依赖裁剪图。

## 图检查如何使用这套判断

图检查会在内存中计算声明构建图，再对照源码导入事实检查是否一致；它不会写出 `.limina` 下的检查器文件。`graph prepare` 和需要生成检查器配置的执行路径才会把同一张图物化到磁盘。

在 `references` 完整性检查中，图检查也使用声明提供者分类：

- 如果导入解析到 `.d.ts` / `.d.cts` / `.d.mts`，图检查不会要求源码项目引用。
- 如果依赖具有非空声明关系需求并到达有效源码提供者，图检查会验证对应项目引用。
- 如果 `TypeScript` 不能确认声明提供者，图检查不会根据 `Oxc` 的运行时解析结果补出项目引用。
- 多余引用检查针对可达且含文件的声明项目，跳过生成的检查器根、已预期的边、可达项目集合之外的目标、同一生成检查器命名空间内的引用和允许规则；剩余引用可能被报告为多余。
- 如果生成声明项目之间形成循环，图检查会报告项目引用循环。

不过，图检查不只关心声明提供者。和包入口、运行时解析、依赖声明、边界规则相关的检查，仍可能使用其他解析结果作为证据。这里讨论的是 `references` 推断和 `references` 完整性检查这条主线。

## 常见情况

### 消费已存在的声明文件

如果工作区包通过 `exports.types` 暴露声明文件：

```json
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

当另一个包导入 `@acme/core`，并且 `TypeScript` 在当前 `tsconfig` 语义下解析到 `dist/index.d.ts`，Limina 不会生成到 `@acme/core` 源码 `tsconfig` 的项目引用。

这不表示 Limina 会构建或刷新 `dist/index.d.ts`。如果一个包选择消费构建产物，它仍然需要通过自己的构建流程、监听任务、`CI` 或发布流程维护这些产物。

### 依赖另一个源码范围

如果 `TypeScript` 解析到另一个源码范围管辖的源码文件：

```text
packages/core/src/index.ts
```

并且这个文件需要通过目标 `tsconfig` 的声明输出提供类型声明，那么 Limina 会让当前生成声明配置引用目标生成 `.dts.json`。

这条项目引用表达的是声明构建依赖。它不是包发布关系，也不是运行时打包关系。

### 使用手写声明文件

如果 `TypeScript` 解析到源码目录中的手写声明文件：

```text
packages/core/src/index.d.ts
```

Limina 会把它视为已有声明文件。即使这个文件位于 `src` 下，Limina 也不会反推出一条源码项目引用。

### 只有运行时依赖

如果导入只服务于运行时实现，并且最终声明产物没有引用目标包类型，理论上它可能不属于最小引用图。但 Limina 当前不会根据最终 `.d.ts` 裁剪这条边。

这类边如果导致项目引用循环，通常说明源码实现关系跨过了类型构建边界。修复方向不是手动删除生成的项目引用，而是重新审视源码边界、导出类型和运行时装配位置。

## 常见诊断怎么理解

### 无法解析工作区导入 {#unresolved-workspace-import}

原始诊断消息为 `Unresolved workspace import`。这个诊断适用于实际观察到的具名工作区包导入：消费方检查器没有解析目标。它不报告 Oxc 和 TypeScript 的比较。

优先检查包类型入口、`tsconfig` 的模块解析配置、路径别名和检查器配置。只有环境声明的语义观察记录和未观察到的生成依赖，不按未解析工作区消费处理。

### 工作区源码导入使用的包导出缺少类型入口 {#workspace-source-import-uses-package-export-without-a-type-entry}

原始诊断消息为 `Workspace source import uses package export without a type entry`。这个诊断表示：受治理的工作区源码导入通过 `package.json#exports` 进入包入口，但这个入口没有稳定的 `TypeScript` 类型入口或检查器源码入口。

如果这是面向源码治理的入口，建议补充类型声明分支，或改为导入稳定的公开类型入口。如果它只是运行时资源，应避免把它作为受治理源码的类型依赖入口。

### 工作区导入缺少项目引用 {#missing-project-reference-for-workspace-import}

原始诊断消息为 `Missing project reference for workspace import`。这个诊断表示：静态导入到达了另一个需要声明输出的源码提供者，但当前生成声明配置中没有对应项目引用。

先检查两端是否属于预期的检查器域，并确认各自的默认 `tsconfig.json` 入口被 `checker.include` 选中。`tsconfig.lib.json`、`tsconfig.test.json` 等命名终端配置必须能从已选入口的有效 `references` 闭包到达；将这些叶子配置路径直接放入 `include` 会被拒绝。

例如，以 `include: ['tsconfig.json']` 选择根入口，由它纳入命名叶子配置：

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

如果它是真实但源码分析看不到的声明关系，用源码叶子配置的 `implicitRefs` 表达，或通过 `graph.rules.<label>.allow.refs` 记录允许原因；否则修正不正确的源码关系并重新生成。`.limina` 中的配置继续由工具维护。

### 生成的项目引用形成循环 {#generated-project-reference-cycle}

原始诊断消息为 `Generated project reference cycle`。这个诊断表示：生成的声明项目 `references` 形成了循环。循环可能来自互相依赖的源码声明关系或显式 `implicitRefs`。成功的 `declaration-provider` 边使用相同的最终检查器身份；相冲突的构建检查器身份会使准备失败。

优先检查循环中的源码边界是否过细、共享类型是否应该下沉、运行时装配是否应该上移，或某一侧是否应该改成明确维护的声明边界。

## 推荐理解方式

Limina 以导入记录和解析结果为证据，建立多包仓库中的声明构建图和架构检查图。

几类工具各自负责不同部分：

```text
TypeScript 语法 AST 与扫描器
  -> 收集源码中的导入、导出、导入类型与 CommonJS 证据

检查器语义下的 TypeScript 解析器
  -> 在当前检查器和 tsconfig 下确定声明提供者

Oxc 解析器
  -> 仅在待定归属发现过程中限定物理框架候选

Limina 图模型
  -> 将声明提供者映射为项目引用、声明文件消费或诊断
```

使用这些结果时，还需区分以下情况。

第一，运行时能解析到源码文件，不代表声明构建应该引用这个源码文件所在的 `tsconfig`。

第二，解析到 `.d.ts` 不代表 Limina 会自动构建这个声明文件；它只说明当前项目引用推断不需要把这条边当作源码提供者项目引用。

一旦项目的语义判定依据已锁定，检查器语义下的导入解析失败就保持失败。Oxc 不为该导入提供后备目标或声明提供者证据。

第三，源码 `import` 可能比最终 `.d.ts` 的最小依赖关系更保守。Limina 当前根据通过校验的源码提供者关系生成引用，不按最终声明产物裁剪引用。
