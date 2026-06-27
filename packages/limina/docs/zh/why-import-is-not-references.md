# 为什么导入不能直接等于引用

在单体仓库里，`import`、`package.json` 依赖和 TypeScript `references` 经常被放在一起讨论。它们确实有关联，但不是同一类信息。

一个包在 `package.json` 里声明了依赖，只说明它可以使用另一个包。源码里写了一条 `import`，只说明某个文件使用了某个入口。`references` 关心的是另一件事：

```text
声明构建时，当前 tsconfig 应该先消费哪个上游声明构建结果？
```

这就是为什么不能简单地说“已经 import 了，就应该自动生成 reference”。Limina 要处理的不是把导入列表复制到 `references`，而是判断这条导入在 TypeScript 声明构建里到底需要什么类型声明，以及这个类型声明由谁提供。

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

例如，`dependencies` 里声明了 `@acme/core`，不代表每个导入 `@acme/core` 的 tsconfig 都应该 reference `core` 的源码构建配置。因为 `@acme/core` 的某个入口可能暴露源码，也可能暴露已经生成好的 `.d.ts`，还可能只是运行时资源。对 `references` 来说，真正重要的是 TypeScript 在当前 tsconfig 和检查器语义下会如何获得这个入口的类型声明。

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

这里不能只看 `default` 指向了 `./src/index.ts`。对声明构建来说，更关键的是 TypeScript 是否已经通过 `types` 得到了 `./dist/index.d.ts`。如果当前检查器和 tsconfig 下的 TypeScript 类型解析结果已经是 `.d.ts`，这条边更接近“声明文件消费”，不应该为了让图更像源码依赖而强行生成 project reference。

再看另一条导入：

```ts
import { createInternalClient } from '@acme/core/internal';
```

如果 TypeScript 解析结果落到了 `packages/core/src/internal.ts`，并且这个文件属于另一个被 Limina 管辖的源码 tsconfig，那么这才可能变成一条声明构建 `references`。原因不是“包名一样”，也不是“dependencies 里有这个包”，而是这条导入的类型声明需要由另一个源码范围通过声明构建提供。

这两个例子说明，同一个包、同一个依赖声明下，不同入口可能对应不同的工程关系：

| TypeScript 类型解析结果       | 对 references 的含义                               |
| ----------------------------- | -------------------------------------------------- |
| `.d.ts` / `.d.mts` / `.d.cts` | 已经有声明文件可消费，不生成 project reference     |
| 当前 tsconfig 管辖的源码      | 当前范围内部关系，不生成 project reference         |
| 另一个 Limina 管辖的源码      | 可能生成到目标声明构建配置的 reference             |
| 外部依赖声明                  | 作为外部包消费，不生成单体仓库内部 reference       |
| TypeScript 无法解析           | 不能安全生成 reference，应输出诊断或由用户修正配置 |

这也是 Limina 现在把问题表述为“声明提供者”判断的原因：先判断类型声明从哪里来，再决定是否需要 project reference。

## Limina 为什么要求先声明边界

TypeScript 面对的是整个生态。它不能默认假设所有单体仓库都采用同一种包结构、同一种 tsconfig 划分方式、同一种打包方式。

一个包里可能同时存在：

```text
packages/app/
  tsconfig.json
  tsconfig.lib.json
  tsconfig.test.json
  tsconfig.client.json
  tsconfig.server.json
```

这些配置不一定都应该参与声明构建。测试配置、浏览器配置、Node 配置、框架检查配置可能有不同的文件集合和编译选项。TypeScript 如果默认从 import 或 `package.json` 依赖推导 `references`，就必须替用户判断这些配置之间的构建边界。这种判断很难成为对所有项目都安全的默认语义。

Limina 选择把范围收窄。用户先在配置里声明哪些 tsconfig 是 Limina 要治理的源码入口：

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

用户的源码 tsconfig 只需要说清楚：

```text
我管哪些文件；
这些文件按什么 TypeScript 选项检查。
```

声明构建需要的 `declaration`、`emitDeclarationOnly`、`outDir`、`tsBuildInfoFile` 和生成后的 `references`，由 Limina 写入 `.limina/` 下的配置。

这能减少一个常见混乱：普通源码 tsconfig 里到底应该写 TypeScript 原生 solution references，还是写工具为了补全依赖图而生成的边？在 Limina 的模型里，普通源码配置不承担这种隐式补边职责。声明构建图放在 `.limina/` 里，由 Limina 根据可证明的关系生成。

## Limina 实际判断的是 declaration provider

从用户角度，可以把 references 推断理解成下面这条链路：

```text
源码里的 import/export
  -> 当前检查器和 tsconfig 下的 TypeScript 类型解析
  -> 判断 declaration provider
  -> 只有 provider 是另一个源码 tsconfig 时，才生成 reference
```

更具体一点：

```text
TypeScript 解析到 .d.ts
  -> 已有声明文件
  -> 不生成 reference

TypeScript 解析到当前 tsconfig 内源码
  -> 当前范围内部关系
  -> 不生成 reference

TypeScript 解析到另一个 Limina 管辖的源码文件
  -> 该源码文件的声明需要由另一个 tsconfig scope 提供
  -> 生成到目标 .limina/*.dts.json 的 reference

TypeScript 无法解析
  -> Limina 不能确认 declaration provider
  -> 不用 Oxc 结果补生成 reference
```

这里的重点是：`references` 只从 TypeScript 能确认的声明提供者里产生。Oxc 可以帮助 Limina快速抽取源码里的导入，也可以在诊断中提示“运行时视角可能解析到了哪里”，但它不替 TypeScript 决定 `.limina` 声明构建图。

如果你看到类似“Oxc 能解析但 TypeScript 不能解析”的诊断，含义不是 Oxc 错了，也不是 Limina 忽略了一个可用结果。它通常是在提醒：运行时解析和 TypeScript 类型解析没有对齐。修复方向应该放在 `package.json#exports` 的类型入口、`moduleResolution`、`paths`、`customConditions` 或包边界上，而不是让 Limina 用 Oxc 结果补出一条 reference。

## 静态 import 看不到的边要显式声明

有些真实依赖不会直接出现在源码 import 里，例如：

- 代码生成后才出现的导入；
- 由路由表、插件表、命令表连接的模块；
- 运行时通过 manifest 注册的模块；
- 框架宏或编译插件转换后产生的依赖；
- 构建阶段才映射到真实源码的虚拟模块。

这些关系可能真实存在，但静态 import 图无法证明。Limina 不应该把它们猜出来，也不应该把它们写进普通源码 tsconfig 的 TypeScript 原生 `references`。

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

## 为什么失败是必要的

如果 TypeScript 无法确认 declaration provider，或者一个源码文件被多个 tsconfig 同时管辖，Limina 不应该继续猜。

这些情况都应该暴露出来：

| 现象                             | 更可能说明什么                                 |
| -------------------------------- | ---------------------------------------------- |
| TypeScript 解析不到导入          | 类型入口、路径别名或 tsconfig 解析配置需要修正 |
| Oxc 能解析但 TypeScript 不能解析 | 运行时解析和类型解析没有对齐                   |
| 导入落到另一个包的内部源码       | 可能绕过公开入口                               |
| 导入落到 `.d.ts`                 | 更接近声明文件消费，不应强行生成源码 reference |
| 一个源码文件被多个 tsconfig 管辖 | 文件归属不清楚                                 |
| 静态导入看不到真实边             | 需要 `implicitRefs` 显式声明                   |
| 生成的 reference 违反图规则      | 源码关系存在，但架构规则不允许                 |

这类失败不是为了让接入变复杂，而是为了避免把不确定的关系写进声明构建图。`references` 一旦生成，就会影响 TypeScript 的构建顺序、增量缓存和上游声明消费。对这种关系，保守比猜测更可靠。

## 什么时候应该相信这套推断

当仓库满足下面这些条件时，Limina 的 references 推断会更稳定：

- 源码 tsconfig 边界清楚；
- 每个被检查的源码文件尽量只归属于一个源码类型配置；
- 跨包导入优先经过包名和公开入口；
- package exports 的类型入口和运行时入口有清楚约定；
- Vue、Svelte 等框架文件交给对应检查器处理；
- 静态分析看不到的真实边通过 `implicitRefs` 显式声明；
- CI 中运行 Limina，让生成图、图检查和检查器构建保持一致。

如果一个仓库大量依赖跨包相对路径、混用 tsconfig、公开入口不稳定，或者构建产物和类型入口长期不一致，Limina 不会把这些问题自动变健康。它更可能先把问题暴露出来，让用户决定是修正入口、调整 tsconfig 边界，还是显式声明例外。

::: tip 结论

Limina 能生成 `references`，不是因为它把 `import` 简单翻译成项目引用。

更准确地说，Limina 做的是：

```text
在用户声明的治理范围内，
用当前检查器和 tsconfig 下的 TypeScript 类型解析确定 declaration provider，
再把确认为另一个源码 tsconfig 提供的声明关系，
转换成 .limina 下的声明构建 references。
```

这让 `references` 不再依赖手写补边，也不会退化成对 `dependencies` 的复制。它只表达那些 TypeScript 声明构建确实需要、并且 Limina 能够在当前仓库边界内证明的源码关系。

:::
