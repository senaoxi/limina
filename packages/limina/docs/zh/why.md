# 为什么需要 Limina

TypeScript 单体仓库往往一开始很简单。一个根 `tsconfig.json`，几个包，再加一个 `typecheck` 脚本，看起来就够了。

仓库变大后，同一批文件会开始承担不同任务：

- 编辑器需要快速拿到本地类型信息；
- `tsc -b` 需要干净的项目引用图；
- 框架文件可能需要 `vue-tsc`、`vue-tsgo` 或 `svelte-check`；
- 包之间可能通过 `workspace:*` 互相依赖；
- 发布产物必须在打包和安装之后仍然可用。

这些任务有关联，但 TypeScript 不会自动证明它们彼此一致。Limina 解决的就是这个空隙。

## Limina 和 Nx / Turborepo 的关系

limina、Nx、Turborepo 都属于单体仓库工具，但它们解决的问题层级不同。

Nx / Turborepo 主要解决 **任务执行层** 问题：哪些项目需要执行任务、任务之间的顺序、哪些任务可以并行、哪些结果可以缓存、CI 怎样跑得更快。limina 解决的是 **架构一致性层** 问题：在这些任务运行之前，仓库结构本身是否可信——TypeScript 源码图、包依赖图、项目引用、包导出、运行时边界和发布产物，是否都表达了同一个事实？

二者并不互斥，一个项目可以同时使用：

```json [package.json]
{
  "scripts": {
    "build": "turbo build",
    "test": "turbo test",
    "typecheck": "limina check typecheck",
    "prepublishOnly": "limina check publish"
  }
}
```

这里 Nx / Turborepo 负责任务编排、受影响任务执行、并行执行、缓存和 CI 加速；limina 负责工作区包导出是否能正确解析、导入是否被最近的 `package.json` 授权、项目引用是否匹配源码归属下的导入、`workspace:*` 产物导入是否体现在 Nx 构建边中、`tsconfig*.dts.json` 是否有严格的配套类型检查配置、源码文件是否被检查器覆盖、客户端 / 共享 / Node 运行时边界是否成立，以及 `dist` 发布产物是否对消费者可用。

Nx 自身也提供模块边界 / 一致性检查能力，例如通过项目标签声明依赖约束，并用 ESLint 规则或 Nx Conformance 检查边界。区别在于：limina 的规则不是通用的标签级项目依赖策略：

```text
Nx 的模块边界更像：
  “带有标签 A 的项目能不能依赖带有标签 B 的项目？”

limina 更像：
  “这个依赖在 package.json、tsconfig 引用、TypeScript 模块解析、
   源码文件归属和 dist 包导出中是否一致？”
```

这也是为什么即便 `tsc`、Nx、Turborepo 都已就位，单体仓库仍然需要一致性检查：大型 TypeScript 工作区有一类问题不属于“执行效率”问题，而是“结构真实性”问题——这个依赖到底是源码还是产物、这个导入是否被 `package.json` 授权、这个项目引用是否反映真实导入、这个声明是否来自被严格检查的源码、这个文件是否被任何检查器覆盖、这个运行时是否越过客户端 / Node 边界、这个 `dist` 是否真的对消费者可安装。

> Nx 让单体仓库的任务更高效地运行；limina 让这些任务所依赖的仓库结构更可信。

::: tip
想看 limina 检查什么的具体实战场景，参见[架构一致性](./architecture-conformance.md)。要把 limina 接入仓库，参见[快速上手](./getting-started.md)。
:::

## 项目图会漂移

项目引用应该描述“哪个项目依赖哪个项目”。但真实导入才是事实来源。一个文件已经导入了另一个工作区包，而声明项目却没有引用对方时，构建图就漂移了。

Limina 会从检查器入口出发，读取可达项目，用 TypeScript 解析真实导入，然后报告缺失或禁止的引用。它也支持基于标签的规则，例如禁止浏览器运行时项目访问仅 Node 项目或仅 Node 依赖。

例如：`@acme/app` 在源码里导入了 `@acme/core`，但 `packages/app/tsconfig.lib.dts.json` 没有引用 `packages/core/tsconfig.lib.dts.json`。Limina 会指出导入文件、当前引用和应该补上的边。修完后，`tsc -b`、编辑器和 CI 看到的是同一张依赖图。

## 工作区依赖需要明确语义

`workspace:*` 表示“这个包来自同一个工作区”。这个关系可以通过 `package.json#exports` 暴露源码入口、构建产物入口，或有意混合两者。

这个区别很重要，因为 TypeScript 项目引用不会改写包导出。即使 A 引用了 B，只要 A 写的是 `import '@scope/b'`，TypeScript 仍然会按 B 的包导出解析。因此 Limina 会先解析公开导出，并把解析到的入口作为后续检查的事实来源。

如果导入解析到检查器管辖的源码文件，消费方声明叶子必须引用入口归属方所在的叶子。如果导入解析到 `dist/*.d.ts` 这类构建声明产物，图引用不要求项目引用。如果 `workspace:*` 导入解析到 `dist`，Nx 检查会要求消费方构建目标通过 `dependsOn` 指向生产方构建目标。

例如：`@acme/app` 用 `workspace:*` 依赖 `@acme/core`。如果它导入 `@acme/core`，并且这个导出解析到 `./src/index.ts`，图检查要求补上对应项目引用。如果它导入 `@acme/core/runtime`，并且这个导出解析到 `./dist/runtime.d.ts` 或 `./dist/runtime.js`，Nx 检查会要求 app 的 `project.json` 包含对 core 的构建依赖。

## 源码归属应该清楚

在单体仓库里，跨包相对导入会让归属变得含糊。一个包也可能导入了某个裸包依赖，却忘了写进最近的 `package.json`。

Limina 的源码检查把规则说清楚：

- 源码文件必须属于最近的包归属方；
- 非聚合 tsconfig 不应该混合多个包归属方；
- 相对导入不能逃出同一个包归属范围；
- 裸包导入必须写在最近 `package.json` 的依赖声明里——`dependencies`、`devDependencies`、`peerDependencies` 或 `optionalDependencies`；
- `#imports` 必须匹配最近包的 `imports` 字段，不能指向其他工作区包，并且必须解析到这个包内部。

例如：`packages/app/src/main.ts` 通过 `../core/src/index` 读取另一个包的源码。Limina 会把它报告为跨包相对导入，提示改用 `@acme/core` 的包导出。修完后，包边界会出现在清单文件和导出里，评审者不需要追相对路径才能理解依赖关系。

## 源码通过不等于发布可用

源码图通过，只能说明源码层比较一致。消费者安装的是构建后的产物，不是你的源码 tsconfig。

Limina 的包检查会在构建后运行。它会在需要时打包产物，并检查消费者视角的包元数据、类型解析、运行时导入、依赖声明和自引用导入。发布检查随后校验 README/license、源码映射禁令、打包后清单一致性和基于 registry 的工作区发布顺序等发布卫生问题。这类问题通常不是 `tsc` 能单独发现的。

例如：源码类型检查通过了，但 `dist/package.json` 的 `types` 指向不存在的文件，或者浏览器产物里残留了 `node:fs`。`limina package check` 会在发布前失败。修完后，你确认的是消费者实际安装到的包，而不只是仓库里的源码能不能通过类型检查。

## 设计目标

Limina 希望规则保持可见。它不会把策略藏在预设里，而是把检查器入口、图规则、包条目、允许清单和流水线都放在 `limina.config.mjs`。

这样架构变更就是代码审查可以读到的内容，而不是合并后才由 CI 报出来的惊喜。

例如：要让浏览器运行时禁止访问仅 Node 包，就在对应声明叶子的 `liminaOptions` 下写 `"graphRules": ["runtime-client"]`，再在 `graph.rules.runtime-client` 里写拒绝规则。之后每次有人改边界，改动都会落在配置或 tsconfig 上，评审者可以直接讨论这条规则是否合理。
