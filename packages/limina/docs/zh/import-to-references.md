# 从 import 到 references

TypeScript 的 `references` 很容易让 monorepo 用户困惑：源码里已经 `import` 了另一个包，`package.json` 里也声明了依赖，为什么还要在 `tsconfig.json` 里再写一遍项目引用？

直觉上看，编译器似乎可以直接从包依赖和源码导入中推导这张图。但真正的问题不是 **能不能扫描 import**，而是：

> 谁有资格定义一个文件属于哪个 TypeScript 项目？
> 谁能保证这条导入关系应该变成声明构建的上游引用？
> 谁来处理推导失败、语义不一致、运行时入口和源码入口不一致的问题？

Limina 能推导 references，不是因为这个问题本身简单，而是因为它把问题收窄到了一个**受约束、可检查、可失败、可修正**的仓库范围里。

它不让 TypeScript 猜整个 monorepo。
它要求用户先声明源码类型边界，然后只在这个边界内生成可验证的声明构建图。

## `references` 不是普通依赖列表

`package.json` 依赖、源码 import、包导出、类型配置和 TypeScript 项目引用之间有关联，但它们不是同一件事。

```text
package.json 说：我依赖这个包
源码 import 说：我使用这个入口
exports 说：这个入口指向源码还是产物
tsconfig 说：哪些文件属于这个类型环境
references 说：声明构建时应该先相信哪个项目的输出
```

`references` 会影响 TypeScript 如何拆分编译单元、如何读取上游声明、如何安排构建顺序、如何进行增量构建。它不是 import 扫描缓存，也不是 `dependencies` 的镜像。

所以，一旦 TypeScript 编译器要原生自动推导 references，它就不是在**少写一段 JSON**，而是在改变编译器和语言服务理解整个仓库的方式。

这也是 TypeScript 社区长期讨论类似方向但很难直接落地的根本原因：[从 monorepo 结构或工具推导 project references](https://github.com/microsoft/TypeScript/issues/25376)。

## `package.json` 依赖不等于项目引用

假设一个 workspace 包这样声明：

```json [packages/core/package.json]
{
  "name": "@acme/core",
  "exports": {
    ".": "./src/index.ts",
    "./runtime": {
      "types": "./dist/runtime.d.ts",
      "import": "./dist/runtime.js"
    }
  }
}
```

另一个包导入：

```ts
import { createClient } from '@acme/core';
```

如果这个入口解析到 `core` 的源码，它表达的是源码层协作。对声明构建来说，当前项目可能应该引用 `core` 对应的声明构建配置。

但如果导入的是：

```ts
import { renderRuntime } from '@acme/core/runtime';
```

而该入口解析到 `dist/runtime.d.ts` 和 `dist/runtime.js`，这就更像是在消费上游构建产物，而不是引用上游源码项目。

同一个 workspace 依赖里，不同入口可能表达不同关系：

| 导入落点           | 更接近的语义                         |
| ------------------ | ------------------------------------ |
| workspace 源码文件 | 源码类型协作，可能需要生成 reference |
| workspace 构建产物 | 产物消费，可能形成限定 artifact 边   |
| 外部包入口         | 普通包依赖                           |
| Node 内建模块      | 运行时能力依赖                       |
| 私有内部路径       | 可能绕过包边界                       |

TypeScript 如果只看 `package.json`，很难安全判断哪一个入口应该变成 project reference。它还必须面对多套 tsconfig、条件导出、框架文件、编辑器模式和 watch 模式。

## TypeScript 需要通用语义，Limina 可以要求仓库先说清楚

TypeScript 是语言和编译器。它的默认行为必须适配大量已有项目，不能轻易假设某一种 monorepo 结构就是标准答案。

例如一个包里可能同时存在：

```text
packages/app/
  tsconfig.json
  tsconfig.lib.json
  tsconfig.test.json
  tsconfig.client.json
  tsconfig.server.json
```

哪些配置代表生产源码？哪些只是测试？浏览器代码和服务端代码能不能互相引用？哪个配置应该参与声明构建？这些问题不是 TypeScript 单看 `package.json` 或 import 就能安全决定的。

Limina 的定位不同。

Limina 不是给整个 TypeScript 生态增加一套隐式规则，而是在一个已经接入 Limina 的仓库里，要求用户先声明源码检查入口：

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

这段配置不是让 Limina 扫描整个仓库乱猜，而是告诉 Limina：

> 这些 `tsconfig.json` 是源码检查入口。

Limina 从这些入口出发，跟随 solution references 找到 `tsconfig.lib.json`、`tsconfig.test.json`、`tsconfig.client.json` 这类具体源码配置，再解析文件集合、编译选项、检查器能力和真实 import，最后生成对应的声明构建配置。

## 源码类型配置和声明构建配置

Limina 能推导 references 的核心前提，是它把两个概念彻底分开：

| 模块         | 位置                                      | 谁维护      | 作用                                 |
| ------------ | ----------------------------------------- | ----------- | ------------------------------------ |
| 源码类型配置 | 用户源码中的 `tsconfig*.json`             | 用户维护    | 描述哪些源码文件属于当前类型检查单元 |
| 声明构建配置 | `.limina/tsconfig/.../tsconfig*.dts.json` | Limina 生成 | 描述声明构建如何输出、引用和增量构建 |

用户维护的是源码层面的类型检查边界。
Limina 生成的是 `.limina/` 下的声明构建配置。

两者职责不同，但文件集合保持一致：

```text
源码类型配置
  -> 它覆盖的源码文件
  -> 声明构建配置
```

例如：

```text
packages/core/tsconfig.lib.json
  -> packages/core/src/**/*.ts
  -> .limina/tsconfig/checkers/tsc/projects/packages/core/tsconfig.lib.dts.json
```

这样一来，Limina 不需要用户在普通源码配置里手写 TypeScript 原生 `references`。源码类型配置只负责描述：

```text
我管哪些文件
这些文件如何类型检查
```

声明构建所需的 `references`、`outDir`、`declaration`、`emitDeclarationOnly`、`tsBuildInfoFile` 等配置，由 Limina 在 `.limina/` 中生成。

这避免了一个常见问题：普通源码 tsconfig 里有些配置写了 `references`，有些没有，开发者很难判断这些 references 是 TypeScript solution graph，还是工具为了补边写进去的隐式规则。

在 Limina 的模型里：

> TypeScript 原生 `references` 应该留给 solution config。
> 普通源码配置不应该承担隐性补边职责。

## Limina 如何从 import 推导 references

Limina 并不要求模块解析器理解 TypeScript `references`。

模块解析器只需要回答：

```text
这个 import 指向哪个文件？
```

Limina 继续回答：

```text
这个文件属于哪个源码类型配置？
这个源码类型配置对应哪个声明构建配置？
```

完整链路是：

```text
import specifier
  -> 解析后的源码文件
  -> 所属源码类型配置
  -> 声明构建配置
```

假设有一条导入：

```ts
import { createClient } from '@acme/core';
```

如果解析结果是：

```text
@acme/core
  -> packages/core/src/index.ts
```

而该文件归属于：

```text
packages/core/tsconfig.lib.json
```

同时 Limina 已经为该源码类型配置生成了：

```text
.limina/tsconfig/checkers/tsc/projects/packages/core/tsconfig.lib.dts.json
```

那么当前项目就可以生成一条 reference：

```text
当前声明构建配置
  -> core 声明构建配置
```

这条边不是从包名猜出来的，也不是从 `dependencies` 复制出来的，而是从真实 import 落点和文件归属推导出来的。

## Limina 推导的是被证明的源码关系

Limina 推导关系时，核心证据不是：

```text
两个包在同一个 workspace
```

也不是：

```text
package.json 里声明了依赖
```

而是：

```text
某个被 Limina 检查的源码文件中的 import，实际解析到了另一个源码类型配置里的文件
```

可以把过程理解成：

```text
用户声明源码类型配置入口
  │
  ▼
检查器解析每个入口覆盖的文件集合
  │
  ▼
Limina 建立源码文件 -> 所属源码类型配置的归属关系
  │
  ▼
Limina 扫描源码中的 import/export/import()/require()
  │
  ▼
模块解析器将 specifier 解析到具体文件
  │
  ▼
如果目标文件属于另一个被 Limina 检查的源码类型配置
  │
  ▼
把目标源码类型配置对应的声明构建配置加入 references
```

因此，Limina 的推导比**从依赖名补 references**更谨慎。它要求：

1. 导入真实存在；
2. 导入能解析到具体文件；
3. 目标文件在 Limina 检查范围内；
4. 目标文件能归属于唯一的源码类型配置；
5. 当前源码类型配置和目标源码类型配置不同；
6. 目标源码类型配置有对应的声明构建配置；
7. 这条边没有违反图规则。

只有这些条件成立，Limina 才应该生成 reference。

## 静态分析看不到的边要显式声明

并不是所有真实依赖都能通过静态 import 分析发现。

例如：

- 代码生成后的文件才包含 import；
- 路由表、插件表、命令表由构建插件生成；
- 运行时通过 manifest 注册模块；
- 框架宏或编译插件在转换后才产生依赖；
- 虚拟模块在构建阶段映射到真实源码；
- DI 容器通过字符串 token 连接模块。

这些边是真实存在的，但不是静态 import 图可以证明的。

这类关系不应该写进普通源码类型配置的 TypeScript `references`。因为那会把 TypeScript 原生 project references 和 Limina 的隐性补边语义混在一起。

更合适的方式是使用 Limina 专用字段：

```json [packages/app/tsconfig.lib.json]
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],

  "liminaOptions": {
    "graphRules": ["app"],
    "implicitRefs": [
      {
        "path": "../core/tsconfig.lib.json",
        "reason": "app 的 route manifest 由构建插件生成，生成后会加载 core；源码中没有静态 import。"
      }
    ]
  }
}
```

`implicitRefs` 的含义是：

> 这是一条用户显式声明的隐式依赖边。
> “implicit” 指它在源码静态 import 图中不可见，不是指 Limina 会偷偷添加它。

它只参与 Limina 生成的 references 图，不改变 TypeScript 对源码类型配置的原生解释。

## `implicitRefs` 不是白名单

`implicitRefs` 只是补充**静态分析无法证明，但工程上真实存在**的源码边。它不应该绕过架构规则。

如果某个项目被标记为 browser：

```json
{
  "liminaOptions": {
    "graphRules": ["browser"],
    "implicitRefs": [
      {
        "path": "../node-runtime/tsconfig.lib.json",
        "reason": "运行时通过插件加载。"
      }
    ]
  }
}
```

而 `browser` 规则禁止引用 `node-runtime`，这条补边仍然应该失败。

也就是说：

```text
自动推导边 + implicitRefs 补边
  -> 一起进入生成 references 图
  -> 一起接受 deny.refs / deny.deps / condition domains 等规则检查
```

`implicitRefs` 不是**允许违规**，而是**声明静态分析看不到的事实**。
是否允许这条事实存在，仍然由图规则决定。

## Limina 可以失败，所以能治理

编译器默认推导如果猜错，代价很高。编辑器、watch、构建缓存和大量已有项目都会受到影响。

Limina 作为架构治理工具，可以选择另一种方式：发现不确定、不一致或越界时直接失败，让用户修正结构。

这些情况都不应该被静默猜过去：

| 现象                              | Limina 的判断方向                  |
| --------------------------------- | ---------------------------------- |
| 入口没有被 `checker.include` 选中 | 这不是已声明的源码检查入口         |
| import 解析不到                   | 入口、路径或构建约定需要修正       |
| import 落到另一个包内部文件       | 可能绕过包边界                     |
| import 落到构建产物               | 更像产物消费，而不是源码 reference |
| 一个文件被多个源码类型配置管辖    | 文件归属不清楚                     |
| 一个配置覆盖多个包的源码          | 类型检查边界过粗                   |
| 浏览器入口导入 Node 能力          | 运行时边界被破坏                   |
| 生成图和 package exports 不一致   | 源码关系没有被包入口兑现           |
| 源码图能过但发布包坏掉            | 产物没有兑现源码里的关系           |
| 动态依赖没有声明 `implicitRefs`   | 静态图无法证明这条边               |

TypeScript 要稳定服务所有项目。
Limina 可以对一个仓库说：

> 你的结构还不够清楚，我不能安全生成这条关系。

这种失败不是缺陷，而是治理工具的价值。

## 什么时候该相信这套推导

当仓库满足这些条件时，Limina 的 references 推导通常是可靠的工程收益：

- workspace 包有清楚的 `package.json#name`；
- 源码类型配置职责明确；
- 每个被检查的源码文件都能归属于唯一源码类型配置；
- 跨包访问尽量走包名和公开导出；
- TypeScript、Vue、Svelte 等入口都有对应检查器；
- 构建产物和 package exports 能兑现源码关系；
- 静态分析看不到的真实边通过 `implicitRefs` 显式声明；
- CI 会运行 Limina，让图检查、源码检查、证明检查和检查器构建一起通过。

如果一个仓库还大量依赖跨包相对路径、混用 tsconfig、公开入口不稳定、构建产物与源码入口不一致，Limina 不会把它自动变健康。它更可能先暴露一批结构问题。

这个过程不是接入失败，而是在把**以前靠经验维持的关系**变成仓库可以检查的事实。

## 结论

Limina 能推导 references，不是因为 TypeScript 漏掉了一个简单功能。

更准确地说：

> TypeScript 很难把 monorepo references 推导做成默认语言能力；
> Limina 则可以把它做成一个仓库内的工程治理能力。

TypeScript 必须为整个生态设计稳定语义。
Limina 可以要求一个仓库先声明源码类型配置入口、检查器能力、包边界和运行时规则。

模块解析器提供的是 `import -> 文件` 的解析能力；Limina 继续判断文件归属，并生成 references 图。两者结合后，Limina 才能把：

```text
import specifier
  -> 解析后的源码文件
  -> 所属源码类型配置
  -> 声明构建配置
```

这条链路变成可检查、可构建、可失败后修正的 references 图。

因此，Limina 的优势不在于替 TypeScript 猜整个 monorepo，而在于：

> 它只在用户已经声明的治理范围内，把真实源码关系和显式隐式边，转换成 TypeScript 声明构建可以消费的 references 图。
