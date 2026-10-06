# 条件域

`graph.conditionDomains` 记录某个源码入口期望的 `compilerOptions.customConditions`。Limina 将这个期望与入口的有效配置比较，并沿声明引用检查条件集合是否一致。实际解析仍读取各自的 `tsconfig`；这个字段不会改写解析条件。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    conditionDomains: [
      {
        name: 'web',
        entry: 'apps/web/tsconfig.client.json',
        customConditions: ['browser', 'source'],
      },
      {
        name: 'node',
        entry: 'apps/node/tsconfig.server.json',
        customConditions: ['node', 'source'],
      },
    ],
  },
});
```

## 为什么需要条件域

`compilerOptions.customConditions` 会影响检查器读取包 `exports` 时可选的条件分支。`browser`、`node`、`source` 等名称可以表达运行环境或源码消费方式，具体含义由包的导出配置决定。

声明引用树描述 `tsc -b` 使用的项目关系，解析条件则来自各项目的配置。如果同一棵树混用了不同的 `customConditions`，同一个包的 `exports` 可能在不同项目中指向不同文件。类型检查、运行时解析和图导入分析因此可能使用不同文件，影响声明产物、依赖边和工作区包导出分类。

`graph.conditionDomains` 记录入口期望的条件集合，Limina 将它与实际项目图比较。解析器仍从 `tsconfig` 读取 `compilerOptions.customConditions`。

## `conditionDomains`

- **类型：** `Array<{ name: string; entry: string; customConditions: string[] }>`

`entry` 应该指向能映射到生成声明项目、且从启用检查器入口可达的普通源码叶子。上例要求已选中的 `apps/*/tsconfig.json` 聚合配置分别引用命名的客户端或服务端叶子配置。直接拥有源码的默认 `tsconfig.json` 也可以使用；聚合配置、`tsconfig.build.json` 等构建聚合配置，以及 Astro/Svelte 类型检查叶子配置都没有所需的声明项目映射。

即使没有显式配置 `conditionDomains`，Limina 也会运行默认检查：每个受检查的声明项目，以及从它的 `references` 可达的所有声明项目，都必须拥有相同的有效 `customConditions`。显式配置 `conditionDomains` 后，你还可以把真实入口期望的条件集合写出来，让 Limina 一起校验。

::: danger 注意

为入口配置 `conditionDomains` 时，你需要确保这里写的 `customConditions` 符合这个入口真实想使用的运行时条件。Limina 不会读取或改写其他解析器配置；如果另一个解析器使用全局唯一条件集合，而 Limina 检查的是多个 `tsconfig` 域，那么 Limina 检查通过也不能保证所有运行时路径都会走同一个 `exports` 分支。

:::

## 治理方式

Limina 会先准备生成图，并从启用的检查器入口收集所有声明项目。默认检查会从每个声明项目出发，沿 `references` 展开引用子树，并要求整棵子树的有效 `customConditions` 一致。

配置了 `conditionDomains` 后，Limina 还会对每个条件域做额外校验：

- `name` 和 `entry` 必须是非空字符串，`customConditions` 必须是字符串数组。
- `entry` 必须相对于 `config.rootDir`，并指向已激活包的治理范围内的现有源码 `tsconfig`。外部激活包可以使用 `../`。
- `entry` 必须已经被启用的检查入口管辖；条件域不会把未纳入检查器的项目临时加入图中。
- Limina 会展开 `entry` 的声明引用子树，并复用默认的一致性检查。
- `entry` 项目的有效 `compilerOptions.customConditions` 在排序、去重后必须等于条件域声明的 `customConditions`；顺序和重复字符串不形成不同条件集合。

条件域只检查期望的解析条件，不创建引用、不改 `tsconfig`，也不寻找检查器图之外的项目。

## 能得到什么

入口的有效条件与配置的条件域不一致时，图检查会报告差异。这有助于定位可能影响 `exports` 解析、依赖边或产物分类的条件配置问题。

多入口仓库可以为各入口分别声明条件域。例如，浏览器入口使用 `['browser', 'source']`，`Node` 入口使用 `['node', 'source']`。每个入口的声明引用树都必须在 Limina 检查的条件域内保持一致。

如果上例的两个入口通过声明引用共享同一个叶子项目，该叶子只有一套有效条件，无法同时满足两套不同的期望。应重新划分对应的源码与声明消费边界；添加两个条件域不会为共享项目复制出两份解析配置。
