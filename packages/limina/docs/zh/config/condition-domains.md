# 条件域

`graph.conditionDomains` 用来说明：某个真实入口应该按哪一组条件去解析依赖。Limina 会从入口项目自动展开 `references`，并检查所有可达的 `tsconfig*.dts.json` 项目是否都使用配置中声明的 `compilerOptions.customConditions`。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    conditionDomains: [
      {
        name: 'web',
        entry: 'apps/web/tsconfig.dts.json',
        customConditions: ['browser', 'source'],
      },
      {
        name: 'node',
        entry: 'apps/node/tsconfig.dts.json',
        customConditions: ['node', 'source'],
      },
    ],
  },
});
```

## 为什么需要条件域

`compilerOptions.customConditions` 会影响 TypeScript、Limina 的 Oxc 解析器，以及真实打包器在读取包 `exports` 字段时选择哪一个分支。比如 `browser`、`node`、`source` 这些条件，通常就代表不同的运行环境或构建方式。

声明引用树只是 `tsc -b` 的项目图，它不会自动告诉你“这个入口应该按浏览器条件解析，还是按 Node 条件解析”。如果同一棵声明引用树里混用了不同的 `customConditions`，同一个包的 `exports` 可能在不同项目里指向不同文件：类型检查看见一个分支，运行时或图导入分析看见另一个分支。结果就是声明产物、依赖边、工作区包导出分类都可能悄悄分叉。

`graph.conditionDomains` 就是把这件事写清楚：这个入口属于哪个条件域，应该使用哪一组 `customConditions`。它不会替代 tsconfig；真正参与解析的仍然是 tsconfig 里的 `compilerOptions.customConditions`。Limina 只是拿配置里的期望值去检查实际项目图是否一致。

## conditionDomains

- **类型：** `Array<{ name: string; entry: string; customConditions: string[] }>`

`entry` 必须指向启用的检查入口可达的 `tsconfig*.dts.json` 项目。`tsconfig.build.json` 这类构建聚合器不能作为条件域入口，因为条件域描述的是一棵具体的声明引用树。

即使没有显式配置 `conditionDomains`，Limina 也会运行默认检查：每个受治理的声明项目，以及从它的 `references` 可达的所有声明项目，都必须拥有相同的有效 `customConditions`。显式配置 `conditionDomains` 后，你还可以把真实入口期望的条件集合写出来，让 Limina 一起校验。

::: danger 注意

为入口配置 `conditionDomains` 时，你需要确保这里写的 `customConditions` 和真实打包器使用的条件保持一致。Limina 不会读取或改写打包器配置；如果打包器实际使用另一套条件，Limina 检查通过也不能保证运行时一定会走同一个 `exports` 分支。

:::

## 治理方式

Limina 会先从启用的检查入口收集所有受治理的 `tsconfig*.dts.json` 项目。默认检查会从每个声明项目出发，沿 `references` 展开声明子树，并要求整棵子树的有效 `customConditions` 一致。

配置了 `conditionDomains` 后，Limina 还会对每个条件域做额外校验：

- `name` 和 `entry` 必须是非空字符串，`customConditions` 必须是字符串数组。
- `entry` 必须是工作区根相对路径，留在工作区内，指向存在的 `tsconfig*.dts.json`。
- `entry` 必须已经被启用的检查入口管辖；条件域不会把未纳入检查器的项目临时加入图中。
- Limina 会展开 `entry` 的声明引用子树，并复用默认的一致性检查。
- `entry` 项目的有效 `compilerOptions.customConditions` 必须等于条件域声明的 `customConditions`。

换句话说，条件域只负责描述和检查“这棵树应该按什么条件解析”。它不创建引用、不改 tsconfig，也不负责寻找入口外的新项目。

## 能得到什么

显式配置条件域后，“这个入口到底按 `web`、`node` 还是 `source` 条件解析”会变成一条可以检查的规则。配置错了会在图检查阶段失败，而不是等到某个包 `exports` 走错分支后，才表现成缺边、误报或构建顺序异常。

它也适合多入口仓库：比如浏览器入口使用 `['browser', 'source']`，Node 入口使用 `['node', 'source']`。每个入口的声明引用树都必须内部一致，Limina 的 TypeScript/Oxc 解析结果也更容易和真实打包器保持一致。
