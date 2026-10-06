# 为什么导入不能直接等于引用

在多包仓库里，`import`、`package.json` 依赖和 TypeScript 项目引用经常被放在一起讨论。它们确实有关联，但不是同一类信息。

一个包在 `package.json` 里声明了依赖，只说明它可以使用另一个包。源码里写了一条 `import`，只说明某个文件使用了某个入口。`references` 关心的是另一件事：

```text
声明构建时，当前 tsconfig 应该先消费哪个上游声明构建结果？
```

Limina 需要知道当前检查器从哪里获得类型、是否需要上游源码项目参与声明构建。仅有导入列表无法回答这两个问题。本文先解释这种区分为何必要；具体判定过程见[从导入解析到声明构建图](./import-resolution-to-declaration-build-graph.md)。

## 项目引用不是普通依赖列表 {#references-不是普通依赖列表}

这些关系分别表示：

```text
package.json 依赖：这个包声明自己依赖另一个包
源码 import：这个文件使用某个模块入口
package.json#exports：这个包对外暴露哪些入口
tsconfig：哪些文件属于某个类型检查范围
references：声明构建时应该先构建并消费哪个上游项目输出
```

它们会互相影响，但不能互相替代。

例如，`dependencies` 里声明了 `@acme/core`，不代表每个导入 `@acme/core` 的 `tsconfig` 都应该引用到 `core` 的源码构建配置。因为 `@acme/core` 的某个入口可能暴露源码，也可能暴露已经生成好的 `.d.ts`，还可能只是运行时资源。引用推断要结合当前 `tsconfig` 和检查器语义下的解析结果、类型证据和编译关系需求。

## 一个导入可能有不同含义

假设一个多包仓库包这样暴露入口：

```json [packages/core/package.json]
{
  "name": "@acme/core",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./src/index.ts"
    },
    "./internal": "./src/internal.ts"
  }
}
```

另一个包里有一条导入：

```ts
import { createClient } from '@acme/core';
```

当前检查器和 `tsconfig` 决定 TypeScript 解析到哪个入口。如果经 `types` 解析到 `./dist/index.d.ts`，Limina 不会为该目标生成源码项目引用。`default` 分支指向 `./src/index.ts` 不会改变这个结果。

再看另一条导入：

```ts
import { createInternalClient } from '@acme/core/internal';
```

如果 TypeScript 解析到另一个受管源码 `tsconfig` 中的 `packages/core/src/internal.ts`，这条关系可能成为声明构建引用。它需要该源码范围提供声明输出；仅有包身份或依赖声明还不够。

同一个包的不同入口可以使用不同的声明提供者。Limina 先确认提供者，再决定是否需要项目引用。

每种解析结果（`.d.ts`、当前范围源码、另一个范围源码、外部依赖、无法解析）具体如何映射为 `references`、声明文件消费或诊断，见[从导入解析到声明构建图](./import-resolution-to-declaration-build-graph.md)。

## Limina 为什么要求先声明边界

多包仓库可以采用不同的包结构、`tsconfig` 划分和打包方式，这些边界需要在项目配置中声明。

一个包里可能同时存在：

```text
packages/app/
  tsconfig.json
  tsconfig.lib.json
  tsconfig.test.json
  tsconfig.client.json
  tsconfig.server.json
```

这些配置可能使用不同的文件集合和编译选项，也不一定都需要声明构建。仅有导入和 `package.json` 依赖，无法确定哪些配置应该参与构建；这个范围由检查器入口和源码配置边界确定。

Limina 在已激活的包范围内发现默认 `tsconfig.json`，再从聚合入口到达各个源码叶子。自动发现已经启用，需要固定检查器时才添加具名范围。关键是让每个实现文件有唯一归属，而不是让所有配置重复包含整个包。入口和成员规则见[核心概念](./concepts.md#聚合器配置)。

## 源码类型配置和声明构建配置要分开

用户维护源码类型配置，Limina 生成声明构建配置。

| 配置         | 位置                              | 维护方 | 作用                                   |
| ------------ | --------------------------------- | ------ | -------------------------------------- |
| 源码类型配置 | 用户源码里的 `tsconfig*.json`     | 用户   | 描述哪些文件属于当前类型检查范围       |
| 声明构建配置 | `.limina/tsconfig/.../*.dts.json` | Limina | 描述声明构建的输出、引用和增量构建关系 |

用户的源码 `tsconfig` 只需要说清楚：

```text
我管哪些文件；
这些文件按什么 TypeScript 选项检查。
```

声明构建需要的 `declaration`、`emitDeclarationOnly`、`outDir`、`tsBuildInfoFile` 和生成后的 `references`，由 Limina 写入 `.limina/` 下的配置。

这里需要区分两种 `references`：

- **聚合成员引用**：由用户在默认 `tsconfig.json` 中维护，将多个叶子纳入入口；聚合配置解析后的文件集合必须为空。
- **叶子间声明构建引用**：由 Limina 写入生成配置。用户的源码叶子不能直接声明原生 `references`，空数组也不允许。

## Limina 实际判断的是声明提供者 {#limina-实际判断的是-declaration-provider}

假设 `app` 需要 `core` 的类型。类型可能已经由 `core/dist/index.d.ts` 提供，也可能需要 `core` 的源码叶子先生成声明。后一种情况下，这个叶子才是候选的声明提供者。

Limina 还要检查：目标源码归谁所有、该配置能否生成声明、两侧能否使用同一构建检查器，以及图规则是否允许这条关系。只有符合这些条件的声明构建关系才进入生成的 `references`。

Astro / Svelte 的受支持依赖还可能只需要安排检查顺序。这类框架调度关系不提供声明项目，也不写成 TypeScript 引用。具体的类型证据与调度区别见[判定过程](./import-resolution-to-declaration-build-graph.md#limina-如何判断一条导入是否需要项目引用)。

## 静态导入看不到的边要显式声明 {#静态-import-看不到的边要显式声明}

代码生成后的导入、路由清单或插件注册表，可能包含源码分析暂时看不到的连接。只有这些连接确实构成声明构建依赖时，才需要补充关系；普通运行时依赖不必一律变成项目引用。字面量动态导入 `import('./module.js')` 已参与分析，不属于这种遗漏。

这类边应该通过 `liminaOptions.implicitRefs` 显式声明：

```json [packages/app/tsconfig.lib.json]
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],

  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../core/tsconfig.lib.json",
        "reason": "app 的声明构建需要生成路由清单引用的 core 源码；当前被分析的源码中没有这条导入。"
      }
    ]
  }
}
```

`implicitRefs` 的含义是：这条边在源码静态导入里看不到，但用户明确声明它是声明构建图的一部分。

它不是导入允许清单，也不能绕过规则。路径相对声明它的源码配置，必须映射到受治理的声明叶子配置；它不提供缺失的解析器语义，也不能让不支持的虚拟模块变得可消费。后续图规则仍然可以判断这条边是否允许存在。

## 运行时循环不等于项目引用循环

`ESM` 和 `CommonJS` 都允许模块之间存在循环依赖。这个能力属于运行时模块系统：代码可以在执行阶段互相加载，只要双方能接受循环加载带来的初始化顺序约束。

`TypeScript` 项目引用解决的是另一类问题。`references` 描述的是声明构建时应该先消费哪个上游项目输出。进入 `.limina` 生成图后，跨源码配置的引用关系需要能被构建类检查器排序执行。运行时允许循环，不代表这条循环适合穿过 `TypeScript` 项目引用边界。

例如下面的源码关系在运行时可能成立：

::: code-group

```ts [packages/a/src/index.ts]
import { initB } from '@repo/b';

export interface AOptions {
  value: string;
}

export function initA(options: AOptions) {
  initB();
  return options.value;
}
```

```ts [packages/b/src/index.ts]
import { initA } from '@repo/a';

export interface BOptions {
  count: number;
}

export function initB(options?: BOptions) {
  if (options) {
    initA({ value: String(options.count) });
  }
}
```

:::

如果 `packages/a` 和 `packages/b` 由两个独立源码 `tsconfig` 管辖，`TypeScript` 在检查源码时会解析这两条导入。Limina 生成的声明构建图面向检测和增量构建，会按 `TypeScript` 能确认的声明提供者保守生成引用。即使最终 `.d.ts` 产物表面上没有互相导入，这组源码关系仍然可能变成：

```text
a 的生成声明配置 -> b 的生成声明配置
b 的生成声明配置 -> a 的生成声明配置
```

这组跨配置引用形成声明构建循环，不能作为独立构建单元排序执行。

处理循环时，应调整源码结构和类型构建边界。不要仅为绕过检查而使用 `paths`、计算后的运行时导入或忽略规则；Limina 不会通过分析已生成的 `.d.ts` 来移除边。

### 合并强耦合源码范围

如果两个源码范围经常互相调用，无法独立构建，可以考虑让同一个源码 `tsconfig` 管辖它们。

不建议把强耦合源码拆成两个互相引用的项目：

```text
packages/a/tsconfig.json
packages/b/tsconfig.json

a -> b
b -> a
```

如果包职责也适合合并，可以把两组实现移入同一个包，再由该包的一个源码叶子覆盖。不能只扩大一个配置的 `include`，让它跨越两个仍然独立的包：

```json [packages/runtime/tsconfig.json]
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/a/**/*.ts", "src/b/**/*.ts"]
}
```

```text
packages/runtime/src/a/index.ts
packages/runtime/src/b/index.ts
packages/runtime/tsconfig.json
```

这两个源码模块归属于同一个项目后，互相依赖的关系留在项目内部。

### 抽出更低层的共享契约

如果循环来自共享类型、协议、常量或抽象，应该把这些内容下沉到更低层的 `contracts` / `shared` 模块，让两侧共同依赖它，而不是互相依赖对方实现。

不建议：

```text
@repo/a -> @repo/b
@repo/b -> @repo/a
```

可以改成：

```text
@repo/a -> @repo/contracts
@repo/b -> @repo/contracts
```

例如：

::: code-group

```ts [packages/contracts/src/metrics.ts]
export interface MetricsSink {
  record(name: string, value: number): void;
}
```

```ts [packages/a/src/app.ts]
import type { MetricsSink } from '@repo/contracts';

export function createApp(metrics: MetricsSink) {
  metrics.record('app.start', 1);
}
```

```ts [packages/b/src/metrics.ts]
import type { MetricsSink } from '@repo/contracts';

export const metrics: MetricsSink = {
  record(name, value) {
    // ...
  },
};
```

:::

在这个例子中，两侧源码范围依赖 `contracts`，而不再互相依赖；其他导入和显式边仍需检查循环。

### 把运行时装配移动到上层入口

如果循环来自注册、启动、插件装配或运行时装配代码，可以把装配移到上层入口，由它导入两侧模块并调用各自导出的函数。

原本 `a` 与 `b` 为了互相注册而形成双向关系，可以把注册动作交给 `app`：

::: code-group

```ts [packages/a/src/index.ts]
export function registerA() {
  // ...
}
```

```ts [packages/b/src/index.ts]
export function registerB() {
  // ...
}
```

```ts [packages/app/src/main.ts]
import { registerA } from '@repo/a';
import { registerB } from '@repo/b';

registerA();
registerB();
```

:::

此时构建关系会变成：

```text
app -> a
app -> b
```

而不是：

```text
a -> b
b -> a
```

本例由 `app` 完成注册，`a` 和 `b` 不再因这段注册代码互相依赖。

### 使用明确维护的声明边界

如果一侧本来就是外部声明边界，可以让它通过明确维护的 `.d.ts` 暴露类型。此时声明文件的生成和新鲜度由用户自己的构建流程负责，Limina 不会把它反向还原成源码项目引用。

例如：

```json [packages/b/package.json]
{
  "name": "@repo/b",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  }
}
```

如果导入方在当前 `TypeScript` 配置下解析到的是 `packages/b/dist/index.d.ts`，这就是已有声明文件消费。它不需要通过 `TypeScript` 项目引用约束 `packages/b` 的源码声明构建。

这种做法适合 `packages/b` 的声明文件由打包器、声明打包器或手写声明维护的场景。它不适合用来掩盖本应由源码项目引用表达的真实源码依赖。

当前引用生成器不会最小化已生成的 `.d.ts` 依赖。最终声明打包和入口优化是独立的构建步骤。显式公开类型可以控制声明泄漏，但只要源码推断的编译关系仍存在，就不会删除该项目引用。

## 为什么失败是必要的

从导入推断引用时，检查器没有解析目标或源码归属存在歧义，需要先核查这些问题。

常见情况及其含义如下：

| 现象                                     | 更可能说明什么                                   |
| ---------------------------------------- | ------------------------------------------------ |
| `TypeScript` 解析不到导入                | 类型入口、路径别名或 `tsconfig` 解析配置需要修正 |
| 实际工作区导入的消费方检查器没有解析目标 | 当前检查器选项下无法解析该工作区入口             |
| 导入落到另一个包的内部源码               | 可能绕过公开入口                                 |
| 导入落到 `.d.ts`                         | 已有声明文件消费，不反推源码项目引用             |
| 一个源码文件被多个 `tsconfig` 管辖       | 文件归属不清楚                                   |
| 静态导入看不到真实边                     | 需要 `implicitRefs` 显式声明                     |
| 生成的 `reference` 违反图规则            | 源码关系存在，但架构规则不允许                   |
| 生成的引用关系形成循环                   | 源码循环跨过了需要独立排序的类型构建边界         |

生成声明引用需要有效的源码归属和图规则许可。生成的 `references` 会影响 TypeScript 的构建顺序、增量缓存和上游声明消费，因此需要检查对应证据与边界。

## 什么时候应该相信这套推断

接入时应核对以下仓库条件，以便理解引用来源并排查失败原因：

- 源码 `tsconfig` 边界清楚；
- 每个受管实现文件只归属于一个源码叶子配置；声明文件另按声明规则处理；
- 跨包导入优先经过包名和公开入口；
- 包导出的类型入口和运行时入口有清楚约定；
- `Vue`、`Svelte` 等框架文件交给对应检查器处理；
- 静态分析看不到的真实边通过 `implicitRefs` 显式声明；
- 运行时循环依赖尽量留在同一个源码类型配置内部，跨源码配置的依赖关系保持可排序；
- `CI` 中运行 Limina，让生成图、图检查和检查器构建保持一致。

跨包相对路径、重叠的 `tsconfig` 范围、不稳定的公开入口，以及不一致的构建产物或类型入口，需要分别处理。可结合诊断修正入口、调整 `tsconfig` 边界或显式声明例外；生成图本身不会修复这些输入问题。

观察到的编译关系和显式 `implicitRefs` 共同组成生成图。它们不会复制 `dependencies`，也不承诺是最终 `.d.ts` 的最小依赖图。下一篇会展开[解析目标、类型证据与编译关系需求](./import-resolution-to-declaration-build-graph.md)如何共同决定结果。
