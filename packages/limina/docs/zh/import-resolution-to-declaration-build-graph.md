# 从导入解析到声明构建图

在单体仓库里，一条 `import` 往往不只是“从哪里加载代码”。对 TypeScript 声明构建来说，更关键的问题是：这条导入需要的类型声明从哪里来。

Limina 的 references 推断围绕这个问题展开。它不会把“解析到了某个源码文件”直接等同于“应该生成一条 reference”。它会先在当前检查器和 tsconfig 语义下判断这条导入的声明提供者，再决定这条边应该进入 references、被视为声明文件消费，还是报告为需要修正的配置问题。

这里不展开快速开始、完整配置参考或完整排障手册，只解释一条主线：当一个模块导入另一个模块时，Limina 如何把这条导入转换成可审查的声明构建图关系。

## 为什么不能只看“解析到了哪个文件”

先看一个普通导入：

```ts
import { createClient } from '@acme/core';
```

它看起来只是在使用 `@acme/core`，但在单体仓库中，这个导入可能对应几种不同关系：

- TypeScript 解析到 `packages/core/dist/index.d.ts`，说明当前模块消费的是已经存在的声明文件。
- TypeScript 解析到 `packages/core/src/index.ts`，说明当前模块可能依赖另一个源码范围来产生声明输出。
- TypeScript 解析到外部包声明或 Node 内建模块，通常不属于单体仓库内部的 references 关系。
- TypeScript 无法在当前配置下解析这条导入，说明类型入口、tsconfig 配置或包边界可能需要修正。

所以，“能解析”只是一个事实，不是最终结论。对生成的声明 references 来说，真正要回答的是：

```text
这个 import 在当前检查器和 tsconfig 语义下，由谁提供类型声明？
```

Limina 把这个结果称为声明提供者。只有当声明提供者是另一个由 Limina 管辖的源码 tsconfig 范围，并且这份类型声明需要通过该范围的声明输出获得时，Limina 才会生成对应的 reference。

## 整体流程

可以把流程理解成三步：

```text
源码文件
  -> 收集 import/export 模块标识符
  -> 判断 TypeScript 声明提供者
  -> 映射为 references、声明文件消费或诊断
```

第一步只关心源码里出现了哪些模块标识符。第二步用当前检查器和 tsconfig 下的 TypeScript 解析结果判断声明从哪里来。第三步才进入 Limina 的图模型。

这个分层能避免一个常见误解：Oxc 可以帮助 Limina 快速收集导入，也可以为诊断提供运行时解析线索，但 `.limina` 下生成的声明 references 不由 Oxc 的解析结果决定。

## 第一步：收集导入记录

Limina 会从当前 tsconfig 范围管辖的源码文件中收集导入记录。这里包括静态导入、再导出、动态导入、类型导入，以及源码中可以静态识别的部分 CommonJS 形式。

这一阶段只记录可追踪的源码事实，例如：

```text
哪个文件
哪一行附近
哪种 import/export 形式
哪个模块标识符
```

到这里还不会判断导入是否合法，也不会判断是否需要生成 references。

对于 Vue 文件，Limina 会根据配置从 `<script>` 内容中收集导入记录。这仍然只是导入收集，不等于 Vue 编译，也不替代 Vue 检查器的类型检查。

## 第二步：判断声明提供者

拿到导入记录后，Limina 会在当前检查器和 tsconfig 上下文中解析 TypeScript 看到的类型入口。

常见结果可以这样理解：

| TypeScript 类型解析结果        | Limina 的理解            | 是否生成声明 reference |
| ------------------------------ | ------------------------ | ---------------------- |
| `.d.ts` / `.d.cts` / `.d.mts`  | 已有声明文件             | 不生成                 |
| 当前范围内的源码文件           | 当前范围自己负责         | 不生成                 |
| 其他 Limina 源码范围的源码文件 | 需要其他范围产生声明输出 | 生成                   |
| 外部库声明或外部包入口         | 外部依赖                 | 不生成                 |
| 无法解析                       | 无法确认声明提供者       | 不生成，并进入诊断     |

这里最容易误解的是“已有声明文件”。它不只包括 `dist` 下的声明产物，也包括用户维护的 `.d.ts` 文件。只要 TypeScript 在当前语义下已经解析到 `.d.ts`、`.d.cts` 或 `.d.mts`，Limina 就不会再反推出一个源码 tsconfig reference。

假设一个包这样暴露入口：

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./src/index.ts"
    }
  }
}
```

如果 TypeScript 在当前 tsconfig 语义下解析到 `dist/index.d.ts`，这条边就是声明文件消费关系。Limina 不应该为了让源码图看起来更完整，就反推成对 `src/index.ts` 所属 tsconfig 的 reference。

相反，如果 TypeScript 解析到的是另一个范围的源码文件，例如：

```text
packages/core/src/index.ts
```

并且这个文件由另一个 Limina 源码 tsconfig 管辖，那么这条边才会进入 references 推断。

## 第三步：从源码提供者生成 references

当声明提供者是源码文件时，Limina 会继续判断这个文件属于哪个源码 tsconfig 范围。

如果目标源码文件属于当前范围，不需要生成 reference。如果它属于另一个范围，Limina 会把目标源码 tsconfig 映射到对应的生成 `.dts.json`，再把这个 `.dts.json` 加入当前生成声明配置的 `references`。

简化后的判断规则是：

```text
TypeScript 解析到声明文件
  -> 声明文件消费
  -> 不生成 references

TypeScript 解析到当前范围源码
  -> 当前范围内部依赖
  -> 不生成 references

TypeScript 解析到其他范围源码
  -> 源码提供者依赖
  -> 生成到目标 .dts.json 的 references

TypeScript 无法确认声明提供者
  -> 不生成 references
  -> 输出对应诊断或在图检查中暴露问题
```

如果涉及不同检查器之间的源码提供者，Limina 会记录声明提供者边，并检查这条边在生成声明图中是否可被消费方检查器使用。这个检查只作用于 Limina 的生成声明图，不表示 Limina 可以替代 TypeScript、Vue、Svelte 或其他检查器本身的类型检查能力。

## 图检查如何使用这套判断

生成图负责写出 `.limina` 下的声明构建图。图检查负责对照源码导入事实，检查当前图是否一致。

在 references 完整性检查中，图检查也使用声明提供者分类：

- 如果导入解析到 `.d.ts` / `.d.cts` / `.d.mts`，图检查不会要求源码项目 reference。
- 如果导入解析到另一个源码提供者，图检查会检查预期 reference 是否存在。
- 如果 TypeScript 不能确认声明提供者，图检查不会根据 Oxc 的运行时解析结果补出 reference。
- 如果已有 reference 不能由静态导入、声明提供者边或允许规则证明，图检查可能报告多余 reference。

不过，图检查不只关心声明提供者。和包入口、运行时解析、依赖声明、边界规则相关的检查，仍可能使用其他解析结果作为证据。这里讨论的是 references 推断和 references 完整性检查这条主线。

## 几个常见情况

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

当另一个包导入 `@acme/core`，并且 TypeScript 在当前 tsconfig 语义下解析到 `dist/index.d.ts`，Limina 不会生成到 `@acme/core` 源码 tsconfig 的 reference。

这不表示 Limina 会构建或刷新 `dist/index.d.ts`。如果一个包选择消费构建产物，它仍然需要通过自己的构建流程、监听任务、CI 或发布流程维护这些产物。

### 依赖另一个源码范围

如果 TypeScript 解析到另一个源码范围管辖的源码文件：

```text
packages/core/src/index.ts
```

并且这个文件需要通过目标 tsconfig 的声明输出提供类型声明，那么 Limina 会让当前生成声明配置引用目标生成 `.dts.json`。

这条 reference 表达的是声明构建依赖。它不是包发布关系，也不是运行时打包关系。

### 使用手写声明文件

如果 TypeScript 解析到源码目录中的手写声明文件：

```text
packages/core/src/index.d.ts
```

Limina 会把它视为已有声明文件。即使这个文件位于 `src` 下，Limina 也不会反推出一条源码 tsconfig reference。

## 当诊断里出现 Oxc

Oxc 不参与 references 生成，但它仍然可能出现在诊断里。这通常是为了说明：运行时解析视角能找到一个文件，但 TypeScript 在当前检查器和 tsconfig 下没有确认可用的声明提供者。

典型诊断是：

```text
Oxc can resolve this specifier, but TypeScript cannot
```

这个诊断的意思不是“Oxc 解析错了”，也不是“Limina 应该用 Oxc 结果补一条 reference”。它只是指出运行时解析和类型解析没有对齐。

常见排查方向包括：

- `moduleResolution` 是否符合当前 `package.json#exports` 形式；
- `exports.types` 或类型条件是否存在；
- `paths`、`baseUrl` 或 `customConditions` 是否与当前检查器一致；
- 当前导入是否绕过了包的公开类型入口。

修正方向通常是补齐类型入口或调整 tsconfig 配置，而不是让 Limina 猜测一条 reference。

## `implicitRefs` 的位置

静态导入分析只能证明源码中可见的边。生成代码、框架约定、运行时清单或插件机制带来的依赖，源码中没有直接的 import/export 记录，Limina 不会自动猜测，需要时由用户通过 `liminaOptions.implicitRefs` 显式补边。

`implicitRefs` 的完整含义、配置方式以及它为什么不替代声明提供者推断，见[为什么导入不能直接等于引用](./why-import-is-not-references.md)。

## 常见诊断怎么理解

### Oxc can resolve this specifier, but TypeScript cannot

这个诊断表示：通用或运行时解析视角能找到文件，但当前检查器的 TypeScript 声明提供者无法确定。Limina 不会基于 Oxc 结果生成 references。

优先检查包入口中的类型条件、tsconfig 的模块解析配置、路径别名和检查器配置。

### Workspace source import uses package export without a type entry

这个诊断表示：受治理的工作区源码导入通过 `package.json#exports` 进入包入口，但这个入口没有稳定的 TypeScript 类型入口或检查器源码入口。

如果这是面向源码治理的入口，建议补充类型声明分支，或改为导入稳定的公开类型入口。如果它只是运行时资源，应避免把它作为受治理源码的类型依赖入口。

### Missing project reference for workspace import

这个诊断表示：静态导入到达了另一个需要声明输出的源码提供者，但当前生成声明配置中没有对应 reference。

通常需要确认两个源码 tsconfig 都被检查器 `include` 选中，然后重新生成图。

### Extra project reference not proven by static imports

这个诊断表示：某个生成声明 reference 没有被静态导入、声明提供者边或允许规则证明。

如果这条边确实来自静态分析不可见的依赖，应通过规则或显式补边表达；否则应移除多余 reference。

## 推荐理解方式

不要把 Limina 理解成一个更强的模块解析器。更准确地说，Limina 是把导入记录和解析结果作为证据，建立单体仓库中的声明构建图和架构检查图。

几类工具各自负责不同部分：

```text
oxc-parser
  -> 快速收集源码里的 import/export 模块标识符

TypeScript 解析器
  -> 在当前检查器和 tsconfig 下确定声明提供者

Oxc 解析器
  -> 用于普通源码图、运行时解析线索和诊断提示

Limina 图模型
  -> 将声明提供者映射为 references、声明文件消费或诊断
```

这条边界可以避免两个常见误解。

第一，运行时能解析到源码文件，不代表声明构建应该 reference 这个源码文件所在的 tsconfig。

第二，解析到 `.d.ts` 不代表 Limina 会自动构建这个声明文件；它只说明当前 references 推断不需要把这条边当作源码提供者 reference。
