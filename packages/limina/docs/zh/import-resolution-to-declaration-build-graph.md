# 从导入解析到声明构建图

在单体仓库里接入 `tsc -b`，最麻烦的通常不是打开 `composite` 或 `declaration`，而是维护 `references`。

一个包导入了另一个包，是否就应该在当前 `tsconfig` 里加一条项目引用？如果工作区包已经通过 `exports.types` 暴露了 `dist/index.d.ts`，还需要引用它的源码项目吗？如果导入只出现在测试配置里，发布源码配置是否也要跟着引用？如果两个包运行时互相调用，但最终 `.d.ts` 没有互相引用，这算不算声明构建依赖？

这些问题靠人工维护很容易漂移。`references` 一旦写错，会影响 `TypeScript` 的构建顺序、增量缓存和上游声明消费。写少了可能缺少声明构建依赖，写多了又可能让图变得臃肿，甚至形成项目引用循环。

Limina 处理的是这类问题：在用户声明的源码类型配置范围内，根据当前检查器和 `tsconfig` 下的 `TypeScript` 解析结果，推断哪些源码范围之间需要声明构建引用。它不会把 `import` 简单复制成 `references`，也不会把 `package.json` 依赖当成构建图。它会先判断一条导入的类型声明由谁提供，再决定这条边应该进入生成的 `references`，还是只属于声明文件消费或诊断问题。

这里不展开快速开始、完整配置参考或完整排障手册，只解释一条主线：当一个模块导入另一个模块时，Limina 如何把这条导入转换成可审查的声明构建图关系，以及为什么当前没有按最终 `.d.ts` 的最小依赖关系对引用图做裁剪。

## 手动维护引用图为什么容易出错

先看一个普通导入：

```ts
import { createClient } from '@acme/core';
```

如果只看源码，这条导入似乎说明当前项目依赖 `@acme/core`。但对 `TypeScript` 声明构建来说，更关键的问题不是“运行时从哪里加载代码”，而是：

```text
当前 tsconfig 的声明构建，需要从哪里获得 createClient 相关的类型声明？
```

在单体仓库里，这条导入可能对应不同关系。

`TypeScript` 可能解析到 `packages/core/dist/index.d.ts`。这说明当前项目消费的是已经存在的声明文件，而不是另一个源码项目。

`TypeScript` 也可能解析到 `packages/core/src/index.ts`。这说明当前项目可能需要另一个源码范围先产生声明输出。

它还可能解析到外部包声明或 `Node` 内建模块。这类关系通常不属于工作区内部的 `references` 关系。

如果 `TypeScript` 在当前配置下无法解析这条导入，则说明类型入口、`tsconfig` 配置或包边界可能需要修正。

所以，“有导入”不是最终结论，“解析到了某个文件”也不是最终结论。真正影响 `references` 的，是这条导入在当前检查器和 `tsconfig` 语义下由谁提供类型声明。

手动维护 `references` 时，用户需要持续判断这些边界。仓库越大，`tsconfig` 越多，越容易出现几类问题：

```text
把 package.json 依赖误写成 TypeScript references
把消费 .d.ts 的关系误写成源码项目引用
忽略测试、脚本、源码配置之间的文件范围差异
遗漏静态 import 看不到但声明构建确实需要的边
把运行时循环带进 TypeScript 项目引用图
```

Limina 的自动引用图生成，就是为了把这些判断放到一个可重复执行的流程里。

## Limina 如何判断一条导入是否需要项目引用

可以把 Limina 的判断过程理解成三步：

```text
源码文件
  -> 收集 import/export 模块标识符
  -> 判断 TypeScript 声明提供者
  -> 映射为项目引用、声明文件消费或诊断
```

第一步只收集源码里可以静态识别的模块标识符，例如静态导入、再导出、类型导入、动态导入中的模块字符串，以及部分可以静态识别的 `CommonJS` 形式。这个阶段只记录源码事实，例如哪个文件、哪种导入形式、哪个模块标识符。到这里还不会判断是否合法，也不会判断是否需要生成 `references`。

如果项目配置了 `Vue` 文件的导入解析，Limina 可以从 `<script>` 内容中收集导入记录。这仍然只是导入收集，不等于 `Vue` 编译，也不替代 `vue-tsc` 这类检查器的类型检查。

第二步会在当前检查器和 `tsconfig` 上下文中，让 `TypeScript` 判断这条导入的类型入口。这里的结果可以粗略分成几类：

| `TypeScript` 类型解析结果      | Limina 的理解            | 是否生成声明项目引用 |
| ------------------------------ | ------------------------ | -------------------- |
| `.d.ts` / `.d.cts` / `.d.mts`  | 已有声明文件             | 不生成               |
| 当前范围内的源码文件           | 当前范围自己负责         | 不生成               |
| 其他 Limina 源码范围的源码文件 | 需要其他范围产生声明输出 | 生成                 |
| 外部库声明或外部包入口         | 外部依赖                 | 不生成               |
| 无法解析                       | 无法确认声明提供者       | 不生成，并进入诊断   |

第三步才进入 Limina 的生成图。如果声明提供者是另一个受管源码范围，Limina 会把目标源码 `tsconfig` 映射到对应的生成 `.dts.json`，再把这个 `.dts.json` 加入当前生成声明配置的 `references`。

这也是 Limina 和普通模块解析器的区别。`Oxc` 可以帮助 Limina 收集导入，也可以为诊断提供运行时解析线索，但 `.limina` 下生成的声明 `references` 不由 `Oxc` 的解析结果决定。决定引用图的是当前检查器和 `tsconfig` 下的 `TypeScript` 声明提供者判断。

## 自动生成引用图需要考虑的具体场景

自动生成 `references` 的难点不在于“有没有导入”，而在于这条导入是否真的要求当前声明构建消费另一个源码范围的声明输出。下面这些场景会直接影响引用图的生成结果。

### 只有 package.json 依赖，不代表需要项目引用

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

### import 不属于当前 tsconfig 管辖范围，不影响当前声明图

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

### 解析到另一个受管源码范围时，才生成项目引用

当导入解析到另一个源码范围，并且目标源码文件由另一个 Limina 源码 `tsconfig` 管辖时，这条边才会进入引用图。

例如：

```text
packages/app/src/index.ts
  -> packages/core/src/index.ts

packages/app/tsconfig.lib.json
packages/core/tsconfig.lib.json
```

如果 `packages/app/tsconfig.lib.json` 管辖的源码导入了 `@acme/core`，并且 `TypeScript` 解析到 `packages/core/src/index.ts`，那么 Limina 会把 `core` 的源码配置映射到对应的生成 `.dts.json`，并在 `app` 的生成声明配置中加入这条项目引用。

这条项目引用表达的是声明构建依赖，不是包发布关系，也不是运行时打包关系。

### 静态导入看不到的真实边，需要显式表达

有些依赖关系不会直接出现在源码 `import/export` 里。例如代码生成、路由清单、插件注册、运行时清单或框架约定带来的关系，可能在构建后才变成真实模块连接。

Limina 不会从字符串、清单或项目约定里猜出这些边。因为一旦猜错，生成的 `references` 就会变成不可靠的构建图。

如果这类关系确实属于声明构建图的一部分，应通过 `liminaOptions.implicitRefs` 显式声明。它的含义是：这条边无法从静态导入记录证明，但用户明确声明它是当前源码范围的声明构建依赖。

`implicitRefs` 不是白名单，也不是绕过规则的开关。它补充的是静态导入看不到的真实边，后续图规则仍然可以判断这条边是否允许存在。

### 运行时能解析，不代表 TypeScript 声明提供者成立

有时运行时解析视角能找到文件，但 `TypeScript` 在当前检查器和 `tsconfig` 下无法确认可用的声明提供者。诊断里出现下面的信息时，通常就是这种情况：

```text
Oxc can resolve this specifier, but TypeScript cannot
```

这个诊断不是说 `Oxc` 解析错了，也不是说 Limina 应该用 `Oxc` 的结果补一条项目引用。它说明运行时解析和类型解析没有对齐。

这类问题通常需要检查类型入口、`moduleResolution`、`exports.types`、`paths`、`baseUrl`、`customConditions` 或检查器配置。修复方向是让 `TypeScript` 能确认声明提供者，而不是让 Limina 根据运行时解析结果猜测构建边。

### 跨检查器源码提供者需要保持可消费

单体仓库里可能同时存在普通 `tsc` 项目和框架检查器项目。某个源码范围可能只能由特定检查器处理，例如包含框架文件或特殊扩展名的项目。

在这种情况下，Limina 可以在生成声明图中记录跨检查器的声明提供者关系，并把可用的目标生成声明项目加入实际 `references`。

这里需要区分两类信息：

```text
实际项目引用
  -> 进入 TypeScript 构建图的实际项目引用边

声明提供者边
  -> Limina 记录的跨检查器声明提供者关系，用于解释和调度
```

生成的引用图只以实际写入生成声明配置的 `references` 作为构建排序边。声明提供者边可以帮助解释跨检查器关系，但它不是额外的有向无环图输入。

### 生成的 references 不能形成项目引用循环

运行时模块系统允许一定形式的循环依赖，但 `TypeScript` 项目引用是构建排序关系。生成的声明 `references` 需要能够被构建类检查器排序执行。

如果两个源码范围互相导入，Limina 可能生成这样的关系：

```text
packages/a/tsconfig.dts.json -> packages/b/tsconfig.dts.json
packages/b/tsconfig.dts.json -> packages/a/tsconfig.dts.json
```

这类图无法作为稳定的声明构建顺序。Limina 的图检查会把生成声明项目的实际 `references` 当成有向图，并在存在多节点强连通分量或自引用时报告循环问题。

这不是说源码中绝对不能存在循环依赖，而是说明这类循环不适合跨过 `TypeScript` 项目引用边界。更稳妥的修复方向通常是合并强耦合源码范围、抽出共享契约、把运行时装配移动到上层入口，或使用明确维护的声明边界。

## 为什么没有对引用图做裁剪

上一节提到，运行时循环如果跨过 `TypeScript` 项目引用边界，可能会让生成的声明 `references` 形成循环。对用户来说，这里最自然的问题是：如果两个模块只是运行时互相调用，最终 `.d.ts` 没有互相引用，为什么 Limina 不直接把这类边从引用图里剪掉？

这里的引用图，指 Limina 根据 `TypeScript` `references` 生成的声明项目引用关系图。这个问题本质上是在问：引用图应该跟随源码里的声明提供者关系，还是应该进一步按照最终 `.d.ts` 的最小依赖关系做裁剪。

引用图裁剪是一个合理的优化方向。它可以让生成的引用图更接近最终声明产物，减少只服务于运行时实现的边，也可能减少某些由实现细节引起的项目引用循环。

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

这类优化的难点不在于“能不能剪枝”，而在于剪枝依据必须可靠。引用图裁剪不能只根据源码里的 `import` 形态判断，它需要分析最终声明产物：当前 `tsconfig` 生成的 `.d.ts` 是否仍然引用目标声明提供者。

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

再导出、`class` 的公开或受保护成员、泛型约束、条件类型、映射类型、入口文件转发，也可能把上游类型带进最终声明产物。也就是说，引用图裁剪不是简单删除“看起来只在实现里使用”的导入，而是需要一套面向声明产物的语义分析。

这和打包器里的无用代码消除类似：它是有效的优化手段，但通常会增加分析成本。很多打包器在开发阶段会优先选择更快的构建反馈，而不是默认执行完整的无用代码消除。Limina 当前也处在类似取舍下：它现阶段更偏向一次性检测和生成，尚未实现围绕声明产物的增量分析能力。

如果在这种模型下默认执行引用图裁剪，Limina 需要额外处理几类问题：

- 如何高效获得或模拟每个源码 `tsconfig` 的最终声明产物；
- 如何区分 `TypeScript` 原始 `.d.ts`、框架检查器输出、声明打包器产物和包公开 API 形态；
- 如何避免根据过期 `.d.ts` 产物剪掉真实需要的项目引用；
- 如何在源码频繁变化时复用上一次声明产物分析结果，而不是每次检测都重新做完整语义分析；
- 如何解释被剪掉的边，尤其是当它们仍然存在于源码 `import` 图中时。

这些问题不是不能解决，但它们已经超出了当前默认引用图生成路径。Limina 现阶段选择先生成保守的声明构建图：根据当前 `tsconfig` 管辖源码中的导入记录和 `TypeScript` 声明提供者生成 `references`，再检查生成的 `references` 是否完整、合规且可排序。

这个取舍会让引用图比最终声明产物更宽。某些运行时实现依赖即使不会出现在最终 `.d.ts` 中，也可能参与生成的 `references`。

最直接的影响是增量声明构建的依赖范围可能更宽。只要 A 的源码导入解析到 B 的受管源码范围，Limina 就可能生成 A -> B 的声明构建引用。即使 A 最终 `.d.ts` 没有引用 B，B 的变化也可能影响 A 的构建排序和增量检查路径。这是一个更保守的构建图，而不是最终声明产物的最小依赖图。

另一个影响是循环依赖会更早暴露。两个源码范围如果只是运行时互相调用，最终声明产物未必互相引用；但在 Limina 当前的生成图里，这组源码导入仍然可能形成生成项目引用循环。这个诊断不一定说明最终 `.d.ts` 会循环引用，而是说明源码层面的声明提供者关系已经跨过了独立的 `tsconfig` 边界，无法作为 `TypeScript` 项目引用图稳定排序。

这也会让图检查更偏向暴露源码边界问题，而不是替用户隐藏实现依赖。某些边从最终声明产物看可能可以剪掉，但只要它来自当前受管源码范围内的真实导入，Limina 就会把它作为可审查的声明提供者关系处理。用户不应该通过手动删除生成的项目引用来处理这类问题；如果这条边来自真实源码 `import`，删除生成的项目引用只会让生成图和源码事实不一致。

更稳妥的处理方向包括：

- 如果上游类型只是被推断泄漏，给导出的值或函数补充显式公开 API 类型；
- 如果两个源码范围强耦合，把它们放进同一个源码 `tsconfig`，让循环留在项目内部；
- 如果循环来自共享类型、协议或抽象，抽到更低层的 `contracts` / `shared` 模块；
- 如果循环来自启动、注册或插件装配，把装配代码移动到更上层入口；
- 如果一侧本来就是声明边界，通过明确维护的 `.d.ts` 暴露类型，并由用户自己的构建流程维护新鲜度。

这些处理不会让 Limina 执行引用图裁剪，但能减少引用图里的偶然实现耦合，也能让 `tsc -b` 需要的项目引用边界更清楚。

## 图检查如何使用这套判断

生成图负责写出 `.limina` 下的声明构建图。图检查负责对照源码导入事实，检查当前图是否一致。

在 `references` 完整性检查中，图检查也使用声明提供者分类：

- 如果导入解析到 `.d.ts` / `.d.cts` / `.d.mts`，图检查不会要求源码项目引用。
- 如果导入解析到另一个源码提供者，图检查会检查预期项目引用是否存在。
- 如果 `TypeScript` 不能确认声明提供者，图检查不会根据 `Oxc` 的运行时解析结果补出项目引用。
- 如果已有项目引用不能由静态导入、声明提供者边或允许规则证明，图检查可能报告多余项目引用。
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

### Oxc can resolve this specifier, but TypeScript cannot

这个诊断表示：通用或运行时解析视角能找到文件，但当前检查器的 `TypeScript` 声明提供者无法确定。Limina 不会基于 `Oxc` 结果生成项目引用。

优先检查包入口中的类型条件、`tsconfig` 的模块解析配置、路径别名和检查器配置。

### Workspace source import uses package export without a type entry

这个诊断表示：受治理的工作区源码导入通过 `package.json#exports` 进入包入口，但这个入口没有稳定的 `TypeScript` 类型入口或检查器源码入口。

如果这是面向源码治理的入口，建议补充类型声明分支，或改为导入稳定的公开类型入口。如果它只是运行时资源，应避免把它作为受治理源码的类型依赖入口。

### Missing project reference for workspace import

这个诊断表示：静态导入到达了另一个需要声明输出的源码提供者，但当前生成声明配置中没有对应项目引用。

通常需要确认两个源码 `tsconfig` 都被检查器 `include` 选中，然后重新生成图。

### Extra project reference not proven by static imports

这个诊断表示：某个生成声明项目引用没有被静态导入、声明提供者边或允许规则证明。

如果这条边确实来自静态分析不可见的依赖，应通过规则或显式补边表达；否则应移除多余项目引用。

### Generated project reference cycle

这个诊断表示：生成的声明项目 `references` 形成了循环。循环可能来自互相导入、隐式补边或跨检查器声明提供者关系。

优先检查循环中的源码边界是否过细、共享类型是否应该下沉、运行时装配是否应该上移，或某一侧是否应该改成明确维护的声明边界。

## 推荐理解方式

不要把 Limina 理解成一个更强的模块解析器。更准确地说，Limina 是把导入记录和解析结果作为证据，建立单体仓库中的声明构建图和架构检查图。

几类工具各自负责不同部分：

```text
oxc-parser
  -> 收集源码里的 import/export 模块标识符

TypeScript 解析器
  -> 在当前检查器和 tsconfig 下确定声明提供者

Oxc 解析器
  -> 用于普通源码图、运行时解析线索和诊断提示

Limina 图模型
  -> 将声明提供者映射为项目引用、声明文件消费或诊断
```

这条边界可以避免几个常见误解。

第一，运行时能解析到源码文件，不代表声明构建应该引用这个源码文件所在的 `tsconfig`。

第二，解析到 `.d.ts` 不代表 Limina 会自动构建这个声明文件；它只说明当前项目引用推断不需要把这条边当作源码提供者项目引用。

第三，源码 `import` 可能比最终 `.d.ts` 的最小依赖关系更保守。Limina 当前默认信任源码声明提供者关系，而不是对最终声明产物做引用图裁剪。
