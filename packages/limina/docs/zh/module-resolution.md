# 为什么 Limina 不使用已有的模块解析器？

简短回答：Limina 会使用已有解析器，但不会把整个判断交给任何一个解析器。

模块解析只回答一部分问题：从这个文件写 `import "x"`，最终指向哪里？Limina 还要继续回答：这个结果在当前单体仓库里意味着什么？它是源码还是产物？属于哪个包？属于哪个 `tsconfig*.dts.json`？这个导入是否需要 TypeScript 项目引用？是否被最近的 `package.json` 授权？如果 `workspace:*` 导入解析到了 `dist`，是否需要对应的 Nx 构建边？

这些是架构治理问题，不只是文件查找问题。

## Limina 对解析结果的要求

对 Limina 来说，解析结果是一份证据。它会用来证明 CI 中必须稳定成立的边界：

- 导入必须能从源码里静态发现；
- specifier 必须在当前检查器 profile 下解析；
- 解析到的文件必须能映射到包归属方；
- 源码归属下的导入必须匹配 TypeScript 项目引用；
- 产物归属下的导入在需要时必须匹配构建依赖；
- `#imports` 必须留在最近的包归属范围内；
- 诊断必须能指回触发这条边的具体导入。

最后一点很关键。Limina 不应该为了让图看起来方便而“修正”解析结果。比如 `@acme/core` 解析到了 `packages/core/dist/index.d.ts`，Limina 就会把它当作产物结果。它不会偷偷沿 source map 反推，也不会猜测真实源码是 `packages/core/src/index.ts`，因为那样会掩盖这个包通过 `package.json#exports` 实际暴露出来的契约。

## 为什么 Node 原生解析器不够

Node 的原生解析器，例如 `require.resolve` 和 `import.meta.resolve`，很擅长回答运行时问题：Node 到底会加载哪个文件？

Limina 问的是另一个问题：这个 TypeScript 单体仓库在构建和发布之前，应该证明哪些结构事实？

Node 不知道 TypeScript 的 `paths`、`baseUrl`、`rootDirs`、`moduleSuffixes`、`allowArbitraryExtensions`、只输出声明的项目、Vue/Svelte 检查器扩展，也不知道 Limina 的包归属模型。它也无法告诉 Limina：解析到的文件是受治理源码、生成出来的声明输出，还是应该产生 Nx 构建依赖的发布产物。

因此，Node 解析很适合理解 package `exports` 和 `imports` 的运行时语义，但不能成为 Limina 的完整事实来源。

## 为什么 TypeScript 模块解析器不够

TypeScript 的模块解析器最接近 Limina 的很多检查。Limina 必须尊重检查器使用的同一套 `compilerOptions`，尤其是路径别名、package imports、package exports、自定义条件和 TypeScript 独有解析行为。

但 TypeScript 解析本质上面向类型检查。它的价值正在这里，限制也在这里。

例如，TypeScript 可能把一个公开包导出解析到 `dist/index.d.ts`。这对类型检查是正确的。但 Limina 仍然要判断它在结构上代表什么：

- 如果它是构建后的声明输出，可能不需要项目引用；
- 如果它是检查器管辖的源码，则必须有项目引用；
- 如果 `workspace:*` 导入触达了 `dist`，可能需要 Nx 构建边；
- 如果 TypeScript 对某个公开导出只能解析到运行时 JavaScript，这个导出对声明检查来说可能不安全。

TypeScript 也天然工作在 TypeScript program 边界内。Limina 要连接的是多个声明叶子、框架检查器入口、包归属方、源码文件、包清单和构建后的包输出。它会在 TypeScript 解析正好提供正确证据时使用它，但最终判断属于 Limina 的图模型。

## 为什么 bundler 解析器不够

Bundler 天生很灵活。Vite、Webpack、Rollup、esbuild 以及框架自己的构建工具，可能支持插件、虚拟模块、资源后缀、loader、CSS 导入、别名和按环境变化的条件选择。

这种灵活性对构建应用很有用，但不适合作为架构治理的唯一事实来源。

一个 bundler 解析器通常绑定在某条构建流水线上。单体仓库里可能同时存在 Node 工具、浏览器包、测试代码、Vue/Svelte 文件、库包和可发布的 `dist` 输出。某个 bundler 插件也许能让一次构建通过，但这个导入未必是合法的包依赖，未必被检查器入口覆盖，也未必适合另一个运行时。

Limina 想要的是相反的性质：一组小而明确、可以被评审、可以在构建前稳定检查的事实。Bundler 行为可以帮助定义 condition domain，但 Limina 不应该让构建插件成为跨包依赖的唯一证明。

## 为什么 Knip 的解析器不是 Limina 的解析器

Limina 会在 Knip 模型适合的地方使用 Knip：未使用工作区依赖，以及 strict 模式下的源码可达性。Knip 很擅长构建广义依赖图，回答“这个文件、导出或依赖是否仍然可达”这类问题。

Limina 核心解析器的工作更窄，也更严格。它不是为了推断所有可能入口，也不是为了把构建产物反推回源码。它要证明的是：每一个静态发现的导入，是否拥有正确的包权限、源码归属、项目引用、运行时边界和构建边。

这个区别很重要。一个死代码工具可以合理地说：“这个产物大概率来自那个源码，所以把源码算作已使用。”但 Limina 通常应该说：“解析器到达了产物，所以这条边就是产物边。”这样才能保留仓库通过 `package.json#exports` 实际暴露的契约。

## Limina 实际怎么做

Limina 不是用一个解析器替代所有解析器，而是组合它们：

- 它先从源码中静态收集导入记录，包括 ESM、export-from、字面量 dynamic import、TypeScript import type、CommonJS `require`、`require.resolve`、`import = require`、Vue inline script，以及受支持的注释 pragma。
- 当当前 compiler options 需要 TypeScript 独有行为时，它优先使用 TypeScript / checker 解析。
- 它会受控地解析直接相对文件、`paths` 和 `baseUrl`。
- 它用 Oxc resolver 处理 package 风格解析，包括扩展名别名、package `exports` / `imports`、symlink 行为，以及来自当前 compiler options 的 condition names。
- 当 Oxc 不是正确权威时，它会回退到 checker 解析。
- 最后它把解析到的文件映射成 Limina 概念：包归属方、源码归属方、声明项目、产物目录、图规则和 Nx 构建依赖。

因此，解析结果不是判断的终点。它只是 Limina 判断适用哪条架构规则的证据。

## 实用理解

可以把 Limina 的解析过程理解成一条链：

```text
源码导入
  -> 静态导入记录
  -> 在当前检查器 profile 下解析
  -> 判断包 / 源码 / 产物归属
  -> 应用引用、依赖、边界或构建边规则
  -> 诊断指回具体导入
```

已有解析器非常擅长中间那一步。Limina 存在的原因，是中间步骤之前和之后的事情同样重要。

所以 Limina 不会把“Node 解析器”、“TypeScript 解析器”、“bundler 解析器”或“Knip 解析器”当作完整答案。它会把解析结果当作事实，再用单体仓库规则判断这些事实是否足以安全地构建、评审和发布。
