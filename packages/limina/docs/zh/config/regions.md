# 治理区域

`regions` 用来定义哪些包作用域属于当前这次 Limina 运行。它是一层结构边界：包归属、检查器发现、源码分析、生成图和依赖授权都只在这层边界内生效。

::: warning
`regions.exclude` 不能替代 `config.source.exclude` 或检查器级 `exclude`。如果只是想从一个已知治理单元里排除部分文件，应该使用文件级选项；只有整个已识别包作用域或工作区边界都不属于当前运行时，才使用 `regions`。
:::

```ts
interface RegionsConfig {
  extendNestedPackageScopes?: boolean;
  exclude?: RegionExcludeConfig[];
}

interface RegionExcludeConfig {
  include: string[];
  reason: string;
}
```

```js
import { defineConfig } from 'limina';

export default defineConfig({
  regions: {
    extendNestedPackageScopes: true,
    exclude: [
      {
        include: ['packages/app/fixtures'],
        reason: 'fixture 由独立的验证流程检查。',
      },
    ],
  },
});
```

## 默认治理区域

Limina 从其工作区根目录最近的 `pnpm-workspace.yaml` 开始，取该文件激活的工作区包作为基础治理单元。每个工作区包根目录的 `package.json` 是它的 owner manifest，用于确定源码归属和依赖授权。

每个基础治理单元内部遵循这些边界规则：

- 默认情况下，遇到嵌套 `package.json` 就从该目录停止治理。
- 嵌套 `pnpm-workspace.yaml` 永远是工作区硬边界，当前区域不会穿过它继续治理。
- 一个目录即使位于工作区根目录下，只要不属于被激活的工作区包，也不会自动进入当前区域。

例如，使用默认配置时：

```text
packages/app/                         受治理，由 packages/app/package.json 归属
packages/app/src/                     受同一个 owner 管辖
packages/app/fixtures/package.json    嵌套包作用域边界
packages/app/fixtures/src/            不属于当前区域
packages/app/vendor/pnpm-workspace.yaml  工作区硬边界
packages/app/vendor/pkg/              不属于当前区域
```

自动检查器发现不会进入这些已停止的边界。如果显式选中的源码配置拥有或包含边界另一侧的文件，Limina 会报告越界，而不是静默扩大治理区域。

## extendNestedPackageScopes

- **类型：** `boolean`
- **默认值：** `false`

当嵌套 `package.json` 只是用于解析包作用域，但其中源码仍应由外层工作区包治理时，可以把 `regions.extendNestedPackageScopes` 设为 `true`。

只有同时满足以下条件，嵌套 `package.json` 才能被扩展：

1. 当前 Limina 根目录下发现的所有 `pnpm-workspace.yaml` 都没有把该目录识别为工作区包。
2. 该清单没有自己的 `name` 字段。
3. 该目录不位于嵌套工作区边界内。

`name` 的判断依据是字段是否存在，而不是值是否有效。例如，`"name": ""` 和 `"name": null` 仍然会阻止扩展。

扩展只发生在当前区域内部。Limina 可以连续穿过多层都满足条件的包作用域，但遇到第一个不满足条件的嵌套清单或嵌套工作区边界就会停止。这个选项不能把被激活工作区包之外的普通目录吸收到当前区域。

被扩展的包作用域不会成为新的源码 owner。它的源码继续使用外层工作区包的 owner manifest 和依赖声明；但这个嵌套清单仍然是相对导入边界和 `package.json#imports` 解析所使用的最近包作用域。

## exclude

- **类型：** `RegionExcludeConfig[]`
- **默认值：** `[]`

Limina 会先识别默认治理单元、可扩展的嵌套包作用域和已经停止的边界，再应用 `regions.exclude`。每个 `include` 使用工作区根目录相对的 `glob`，每条配置都必须带有非空 `reason`。

`exclude` 模式只能命中已识别的根：

- 被激活的工作区包根目录；
- 已扩展的嵌套包作用域根目录；
- 未扩展的嵌套包作用域边界根目录；
- 嵌套工作区根目录。

它不能指向任意普通目录。每条 `exclude` 配置必须至少命中一个已识别根；完全没有命中时属于配置错误。如果多条配置命中同一个根，使用排在最前面的那条 `reason`。

如果工作区根目录本身也是被激活的包，可以使用 `.` 或匹配根 `package.json` 的模式选中它。排除这个根包不会连带排除其他已激活的工作区包。

排除一个治理单元，会让该根目录及其所有后代离开当前运行，包归属、依赖授权、检查器发现和源码分析都不会继续进入其中。排除一个原本就已停止的包或工作区边界，只是记录该边界为什么被有意留在当前运行之外，并不会让它变成可治理区域。

嵌套 `pnpm-workspace.yaml` 在任何情况下都是硬边界；`exclude` 不能把它代表的工作区合并进当前区域。

当前治理源码如果导入被排除或已经停止的区域，Limina 会按跨边界访问处理。诊断会指出边界根目录，并在可用时附上配置的原因。如果本意只是忽略少量文件、同时继续治理其所在的包，应改用源码或检查器的文件级排除配置。
