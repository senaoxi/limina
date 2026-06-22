# 从解析到架构图

Limina 不需要一个特殊的模块解析器。

对 Limina 来说，只要通用模块解析器能在当前项目配置下，把 `import` 稳定解析到真实文件，它通常就已经完成了自己的职责。

模块解析器回答的是：

```text
这个 import 指向哪个文件？
```

Limina 继续回答的是：

```text
这个文件在当前 monorepo 架构里意味着什么？
```

这才是 Limina 的核心价值。

## 模块解析只是第一步

假设源码里有这样一条导入：

```ts
import { createClient } from '@acme/core';
```

模块解析器只需要给出结果：

```text
@acme/core
  -> packages/core/src/index.ts
```

到这里，模块解析已经完成。

但 Limina 还要继续判断：

```text
packages/core/src/index.ts
  -> 属于哪个包？
  -> 属于哪个源码类型配置？
  -> 是否属于另一个被 Limina 检查的项目？
  -> 是否应该映射到声明构建配置？
  -> 是否应该生成 references？
  -> 是否违反 graph rules？
```

因此，Limina 并不要求模块解析器理解 TypeScript `references`。
它只要求模块解析器提供准确的文件落点。

`references` 的判断由 Limina 自己完成。

## 通用模块解析器通常已经足够

Limina 使用 Oxc Resolver，并不是因为 Oxc Resolver 天然理解 TypeScript project references。

Oxc Resolver 的价值在于：

```text
快速、完整地完成 import -> 文件 的解析
```

它解决第一段：

```text
import specifier -> 解析后的文件
```

Limina 解决后两段：

```text
解析后的文件 -> 所属源码类型配置 -> 声明构建配置
```

完整链路是：

```text
import specifier
  -> 解析后的文件
  -> 所属源码类型配置
  -> 声明构建配置
```

因此，准确性不来自解析器对 `references` 的理解，而来自 Limina 对项目结构的约束：

1. 用户声明源码类型配置入口；
2. Limina 解析每个入口管辖的文件集合；
3. 一个被检查的源码文件能归属于某个源码类型配置；
4. 每个源码类型配置都有对应的声明构建配置；
5. 跨项目源码导入可以映射成声明构建配置之间的 `references`。

在这个模型下，通用模块解析器只要完成“导入到文件”的工作即可。

## 解析成功不等于架构合法

在普通构建流程里，“解析成功”通常意味着流程可以继续。

但在 Limina 中，解析成功只是证据，不是结论。

例如：

```ts
import '@acme/core/internal';
```

如果解析到：

```text
packages/core/src/internal.ts
```

这不代表导入合法。
它可能说明当前包绕过了 `@acme/core` 的公开入口。

再例如：

```ts
import '@acme/core/runtime';
```

如果解析到：

```text
packages/core/dist/runtime.d.ts
```

这也不应该被强行解释成源码 `references`。
它更像是产物消费关系，应该导出为 artifact 边，而不是源码类型项目之间的引用。

再例如：

```ts
import 'node:fs';
```

即使解析器能识别这是 Node 内建模块，也不代表它在浏览器入口中合法。

所以，Limina 的判断链路不是：

```text
能解析 -> 合法
```

而是：

```text
能解析
  -> 判断包归属
  -> 判断源码归属或产物归属
  -> 应用 graph rules、包边界、运行时边界和依赖图导出语义
  -> 合法或失败
```

## 产物不能被偷偷反推成源码

如果一个导入解析到了：

```text
packages/core/dist/index.d.ts
```

Limina 不应该为了生成更完整的源码图，偷偷反推到：

```text
packages/core/src/index.ts
```

因为解析结果已经说明：当前入口暴露的是构建产物。

这条边应该被视为产物消费关系，而不是源码类型项目之间的 `references` 关系。

这点很重要。Limina 要保留 `package.json#exports` 实际暴露出来的契约，而不是为了让图看起来更理想而修正解析事实。

如果一个包对外暴露的是 `dist`，Limina 不应该假装它暴露的是 `src`。否则会掩盖包入口、构建产物和类型声明之间的不一致。

## 静态分析看不到的边要显式声明

不是所有真实依赖都能通过静态 import 发现。

例如：

- 代码生成后的文件才包含 import；
- 路由表、插件表、命令表由构建插件生成；
- 运行时通过 manifest 注册模块；
- 框架宏或编译插件在转换后才产生依赖；
- 虚拟模块在构建阶段映射到真实源码；
- DI 容器通过字符串 token 连接模块。

这些边是真实存在的，但不是静态 import 图可以证明的。

它们不应该写进普通源码类型配置的 TypeScript `references`。
更合适的方式是使用 Limina 专用字段：

```json
{
  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../core/tsconfig.lib.json",
        "reason": "该依赖由构建插件生成的 manifest 连接，源码中没有静态 import。"
      }
    ]
  }
}
```

`implicitRefs` 的含义是：

> 这是一条用户显式声明的隐式依赖边。
> “implicit” 指它在源码静态 import 图中不可见，不是指 Limina 会偷偷添加它。

它只参与 Limina 的 references 图，不改变 TypeScript 对源码类型配置的原生解释。

## Limina 的解析模型

可以把 Limina 的完整流程理解为：

```text
源码导入
  -> 静态导入记录
  -> 模块解析器解析到文件
  -> 判断包归属
  -> 判断源码归属或产物归属
  -> 映射到声明构建配置或导出的 artifact 边
  -> 应用 graph rules、包边界和运行时边界
  -> 生成图或输出诊断
```

模块解析器擅长的是中间这一步：

```text
import specifier -> 文件
```

Limina 的核心在后面：

```text
文件 -> 架构含义
```

## 不同解析结果对应不同架构含义

同样是解析成功，Limina 可能得到完全不同的结论：

| 解析结果               | Limina 的架构含义          |
| ---------------------- | -------------------------- |
| 另一个被检查的源码文件 | 可能生成 `references`      |
| 另一个包的构建产物     | 可能形成导出的 artifact 边 |
| 外部包入口             | 检查包依赖声明             |
| 当前包内部文件         | 检查是否在当前包边界内     |
| 另一个包内部文件       | 可能绕过公开入口           |
| Node 内建模块          | 检查运行时边界             |
| 无法解析               | 暴露入口、路径或配置问题   |

因此，Limina 从不把“能解析”当成“合法”。

它真正关心的是：

```text
解析后的文件属于什么架构对象？
这条边应该由哪条规则解释？
这条边是否可以被审查和复现？
```

## 诊断必须指回具体导入

Limina 不应该偷偷修正解析结果，还有一个原因：诊断必须可审查。

当一条边有问题时，Limina 需要告诉用户：

```text
哪个文件？
哪一行？
哪种 import？
哪个 specifier？
解析到了哪里？
为什么这个结果违反了规则？
应该修正源码、包入口、类型配置，还是补充 implicitRefs？
```

如果工具为了让图看起来更完整，私下把产物反推成源码，把动态依赖当成静态依赖，或者把内部路径当成公开入口，诊断就会失去可信度。

架构治理工具最重要的不是“尽量猜对”，而是：

```text
把可证明的事实说清楚
把不能证明的地方暴露出来
让用户显式修正
```

## 推荐心智模型

不要把 Limina 理解成：

```text
一个更强的模块解析器
```

更准确的理解是：

```text
一个使用模块解析结果作为证据的 monorepo 架构治理器
```

模块解析器负责：

```text
import specifier -> 文件
```

Limina 负责：

```text
文件 -> 包归属
文件 -> 源码类型配置归属
源码类型配置 -> 声明构建配置
导入关系 -> references / artifact 边 / 包依赖 / 边界诊断
```

因此，Limina 不会把 Node 原生解析器、TypeScript 模块解析器、Oxc Resolver、构建工具解析器或 Knip 当作完整答案。

这些工具都可以提供事实，但最终判断属于 Limina 的 monorepo 图模型。

## 结论

通用模块解析器通常可以满足 Limina 的解析需求，因为 Limina 并不要求解析器直接理解 TypeScript `references`。

解析器只需要回答：

```text
这个 import 指向哪个文件？
```

Limina 负责继续回答：

```text
这个文件属于哪个包？
这个文件属于哪个源码类型配置？
这个源码类型配置对应哪个声明构建配置？
这条关系应该生成 references、artifact 边、包依赖检查，还是边界错误？
```

所以，Limina 的核心不是发明一个更特殊的模块解析器，而是建立一套能解释解析结果的 monorepo 图模型。

更准确地说：

> 模块解析器提供文件事实；
> Limina 解释这些事实，并把它们转换成可检查、可构建、可失败后修正的架构关系图。
