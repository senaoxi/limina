# 为什么导入不能直接等于引用

在单体仓库里，`import`、`package.json` 依赖和 `TypeScript references` 经常被放在一起讨论。它们确实有关联，但不是同一类信息。

一个包在 `package.json` 里声明了依赖，只说明它可以使用另一个包。源码里写了一条 `import`，只说明某个文件使用了某个入口。`references` 关心的是另一件事：

```text
声明构建时，当前 tsconfig 应该先消费哪个上游声明构建结果？
```

这就是为什么不能简单地说“已经 `import` 了，就应该自动生成 `reference`”。Limina 要处理的不是把导入列表复制到 `references`，而是判断这条导入在 `TypeScript` 声明构建里到底需要什么类型声明，以及这个类型声明由谁提供。

## references 不是普通依赖列表

可以先把几种关系分开看：

```text
package.json 依赖：这个包声明自己依赖另一个包
源码 import：这个文件使用某个模块入口
package.json#exports：这个包对外暴露哪些入口
tsconfig：哪些文件属于某个类型检查范围
references：声明构建时应该先构建并消费哪个上游项目输出
```

它们会互相影响，但不能互相替代。

例如，`dependencies` 里声明了 `@acme/core`，不代表每个导入 `@acme/core` 的 `tsconfig` 都应该引用到 `core` 的源码构建配置。因为 `@acme/core` 的某个入口可能暴露源码，也可能暴露已经生成好的 `.d.ts`，还可能只是运行时资源。对 `references` 来说，真正重要的是 `TypeScript` 在当前 `tsconfig` 和检查器语义下会如何获得这个入口的类型声明。

换句话说，`references` 不是“我依赖谁”，而是“我的声明构建需要哪个上游声明项目”。

## 一个导入可能有不同含义

假设一个单体仓库包这样暴露入口：

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

这里不能只看 `default` 指向了 `./src/index.ts`。对声明构建来说，更关键的是 `TypeScript` 是否已经通过 `types` 得到了 `./dist/index.d.ts`。如果当前检查器和 `tsconfig` 下的 `TypeScript` 类型解析结果已经是 `.d.ts`，这条边更接近“声明文件消费”，不应该为了让图更像源码依赖而强行生成 `project reference`。

再看另一条导入：

```ts
import { createInternalClient } from '@acme/core/internal';
```

如果 `TypeScript` 解析结果落到了 `packages/core/src/internal.ts`，并且这个文件属于另一个被 Limina 管辖的源码 `tsconfig`，那么这才可能变成一条声明构建 `references`。原因不是“包名一样”，也不是“`dependencies` 里有这个包”，而是这条导入的类型声明需要由另一个源码范围通过声明构建提供。

这两个例子说明，同一个包、同一个依赖声明下，不同入口可能对应不同的工程关系。这也是 Limina 现在把问题表述为“声明提供者”判断的原因：先判断类型声明从哪里来，再决定是否需要 `project reference`。

每种解析结果（`.d.ts`、当前范围源码、另一个范围源码、外部依赖、无法解析）具体如何映射为 `references`、声明文件消费或诊断，见[从导入解析到声明构建图](./import-resolution-to-declaration-build-graph.md)。

## Limina 为什么要求先声明边界

`TypeScript` 面对的是整个生态。它不能默认假设所有单体仓库都采用同一种包结构、同一种 `tsconfig` 划分方式、同一种打包方式。

一个包里可能同时存在：

```text
packages/app/
  tsconfig.json
  tsconfig.lib.json
  tsconfig.test.json
  tsconfig.client.json
  tsconfig.server.json
```

这些配置不一定都应该参与声明构建。测试配置、浏览器配置、`Node` 配置、框架检查配置可能有不同的文件集合和编译选项。`TypeScript` 如果默认从 `import` 或 `package.json` 依赖推导 `references`，就必须替用户判断这些配置之间的构建边界。这种判断很难成为对所有项目都安全的默认语义。

Limina 选择把范围收窄。用户先在配置里声明哪些 `tsconfig` 是 Limina 要治理的源码入口：

```js [limina.config.mjs]
export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        include: ['packages/*/tsconfig.json'],
      },
    },
  },
});
```

这个配置不是让 Limina 扫描整个仓库随意猜测，而是告诉 Limina：

```text
这些 tsconfig 是可以进入治理范围的源码入口。
```

在这个范围内，Limina 再解析每个入口覆盖的文件集合、检查器能力、编译选项和源码导入。这样生成的 `references` 才有明确前提：它们来自用户已经声明的类型检查边界，而不是来自仓库里所有看起来像源码的文件。

## 源码类型配置和声明构建配置要分开

Limina 的一个重要约束是：用户维护源码类型配置，Limina 生成声明构建配置。

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

这能减少一个常见混乱：普通源码 `tsconfig` 里到底应该写 `TypeScript` 原生 `solution references`，还是写工具为了补全依赖图而生成的边？在 Limina 的模型里，普通源码配置不承担这种隐式补边职责。声明构建图放在 `.limina/` 里，由 Limina 根据可证明的关系生成。

## Limina 实际判断的是 declaration provider

从用户角度，可以把 `references` 推断理解成下面这条链路：

```text
源码里的 import/export
  -> 当前检查器和 tsconfig 下的 TypeScript 类型解析
  -> 判断 declaration provider
  -> 只有 provider 是另一个源码 tsconfig 时，才生成 reference
```

这里的重点是：`references` 只从 `TypeScript` 能确认的声明提供者里产生。`Oxc` 可以帮助 Limina 快速抽取源码里的导入，也可以在诊断中提示运行时视角可能解析到了哪里，但它不替 `TypeScript` 决定 `.limina` 声明构建图。

完整的四分支判定规则、各类解析结果如何映射，以及“`Oxc` 能解析但 `TypeScript` 不能解析”这类诊断的排查方向，见[从导入解析到声明构建图](./import-resolution-to-declaration-build-graph.md)。

## 静态 import 看不到的边要显式声明

有些真实依赖不会直接出现在源码 `import` 里，例如：

- 代码生成后才出现的导入；
- 由路由表、插件表、命令表连接的模块；
- 运行时通过 `manifest` 注册的模块；
- 框架宏或编译插件转换后产生的依赖；
- 构建阶段才映射到真实源码的虚拟模块。

这些关系可能真实存在，但静态 `import` 图无法证明。Limina 不应该把它们猜出来，也不应该把它们写进普通源码 `tsconfig` 的 `TypeScript` 原生 `references`。

这类边应该通过 `liminaOptions.implicitRefs` 显式声明：

```json [packages/app/tsconfig.lib.json]
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],

  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../core/tsconfig.lib.json",
        "reason": "app 的 route manifest 由构建插件生成，生成后会加载 core；源码中没有静态 import。"
      }
    ]
  }
}
```

`implicitRefs` 的含义是：这条边在源码静态导入里看不到，但用户明确声明它是声明构建图的一部分。

它不是白名单，也不是绕过规则的开关。后续图规则仍然可以判断这条边是否允许存在。

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
packages/a/tsconfig.dts.json -> packages/b/tsconfig.dts.json
packages/b/tsconfig.dts.json -> packages/a/tsconfig.dts.json
```

这类关系不能作为 `TypeScript` 项目引用图稳定执行。这里的问题不是 `ESM` 或 `CommonJS` 不允许循环，而是两个源码范围已经强耦合到无法作为独立声明构建单元排序。

修复方向通常不是让 Limina 判断这条导入最终是否贡献 `.d.ts` 产物，也不是用 `paths`、动态字符串导入或忽略规则绕开检查。更稳妥的做法是让源码结构和类型构建边界对齐。

### 合并强耦合源码范围

如果两个源码范围经常互相调用、生命周期一致，通常说明它们不适合作为两个独立声明构建单元。可以把它们放回同一个源码 `tsconfig` 管辖。

不建议把强耦合源码拆成两个互相引用的项目：

```text
packages/a/tsconfig.json
packages/b/tsconfig.json

a -> b
b -> a
```

更合适的做法是让同一个源码配置覆盖这组强耦合文件：

::: code-group

```json [packages/runtime/tsconfig.json]
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/a/**/*.ts", "src/b/**/*.ts"]
}
```

:::

```text
packages/runtime/src/a/index.ts
packages/runtime/src/b/index.ts
packages/runtime/tsconfig.json
```

这样循环仍然可以存在于源码模块内部，但不会跨过 `TypeScript` 项目引用边界。

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

这类拆分能让声明构建图保持单向关系，也能让依赖边界更容易被审查。

### 把运行时装配移动到上层入口

如果循环来自注册、启动、插件装配或运行时装配代码，通常不应该让两个底层模块互相 `import`。更稳妥的做法是让两侧只暴露能力，由更上层的组合入口负责把它们连接起来。

不建议：

::: code-group

```ts [packages/a/src/index.ts]
import { registerB } from '@repo/b';

export function startA() {
  registerB();
}
```

```ts [packages/b/src/index.ts]
import { registerA } from '@repo/a';

export function startB() {
  registerA();
}
```

:::

可以改成：

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

这保留了运行时装配能力，同时避免把装配关系变成项目引用循环。

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

如果导入方在当前 `TypeScript` 配置下解析到的是 `packages/b/dist/index.d.ts`，这更接近声明文件消费。它不需要通过 `TypeScript` 项目引用约束 `packages/b` 的源码声明构建。

这种做法适合 `packages/b` 的声明文件由打包器、声明打包器或手写声明维护的场景。它不适合用来掩盖本应由源码项目引用表达的真实源码依赖。

Limina 不把最终 `.d.ts` 产物最小化作为生成项目引用的目标。它更关注检查图是否可靠、声明构建顺序是否可执行、源码关系是否能被当前 `TypeScript` 配置解释。最终声明打包、去除未暴露类型和入口优化，更适合放在声明打包器或发布构建流程里处理。

## 为什么失败是必要的

如果 `TypeScript` 无法确认 `declaration provider`，或者一个源码文件被多个 `tsconfig` 同时管辖，Limina 不应该继续猜。

这些情况都应该暴露出来：

| 现象                                 | 更可能说明什么                                   |
| ------------------------------------ | ------------------------------------------------ |
| `TypeScript` 解析不到导入            | 类型入口、路径别名或 `tsconfig` 解析配置需要修正 |
| `Oxc` 能解析但 `TypeScript` 不能解析 | 运行时解析和类型解析没有对齐                     |
| 导入落到另一个包的内部源码           | 可能绕过公开入口                                 |
| 导入落到 `.d.ts`                     | 更接近声明文件消费，不应强行生成源码 `reference` |
| 一个源码文件被多个 `tsconfig` 管辖   | 文件归属不清楚                                   |
| 静态导入看不到真实边                 | 需要 `implicitRefs` 显式声明                     |
| 生成的 `reference` 违反图规则        | 源码关系存在，但架构规则不允许                   |
| 生成的引用关系形成循环               | 源码循环跨过了需要独立排序的类型构建边界         |

这类失败不是为了让接入变复杂，而是为了避免把不确定的关系写进声明构建图。`references` 一旦生成，就会影响 `TypeScript` 的构建顺序、增量缓存和上游声明消费。对这种关系，保守比猜测更可靠。

## 什么时候应该相信这套推断

当仓库满足下面这些条件时，Limina 的 `references` 推断会更稳定：

- 源码 `tsconfig` 边界清楚；
- 每个被检查的源码文件尽量只归属于一个源码类型配置；
- 跨包导入优先经过包名和公开入口；
- `package exports` 的类型入口和运行时入口有清楚约定；
- `Vue`、`Svelte` 等框架文件交给对应检查器处理；
- 静态分析看不到的真实边通过 `implicitRefs` 显式声明；
- 运行时循环依赖尽量留在同一个源码类型配置内部，跨源码配置的依赖关系保持可排序；
- `CI` 中运行 Limina，让生成图、图检查和检查器构建保持一致。

如果一个仓库大量依赖跨包相对路径、混用 `tsconfig`、公开入口不稳定，或者构建产物和类型入口长期不一致，Limina 不会把这些问题自动变健康。它更可能先把问题暴露出来，让用户决定是修正入口、调整 `tsconfig` 边界，还是显式声明例外。

::: tip 结论

Limina 能生成 `references`，不是因为它把 `import` 简单翻译成项目引用。

更准确地说，Limina 做的是：

```text
在用户声明的治理范围内，
用当前检查器和 tsconfig 下的 TypeScript 类型解析确定 declaration provider，
再把确认为另一个源码 tsconfig 提供的声明关系，
转换成 .limina 下的声明构建 references。
```

这让 `references` 不再依赖手写补边，也不会退化成对 `dependencies` 的复制。它只表达那些 `TypeScript` 声明构建确实需要、并且 Limina 能够在当前仓库边界内证明的源码关系。

:::
