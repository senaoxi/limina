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
  kind: 'workspace-package' | 'package-scope' | 'pnpm-workspace';
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
        kind: 'pnpm-workspace',
        include: ['packages/app/fixtures/workspace-a'],
        reason: '这个 fixture 工作区由独立流程验证。',
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

每条规则都必须提供 `kind`、非空 `include` 数组和非空 `reason`。Limina 不会推断 `kind`，也不接受省略 `kind` 的旧写法。

`include` 只匹配相对于工作区根目录的 candidate 根目录，不匹配包名、`package.json` 路径、`pnpm-workspace.yaml` 路径或任意普通文件。例如，清单位于 `packages/app/fixtures/workspace-a/pnpm-workspace.yaml` 时，应使用 `packages/app/fixtures/workspace-a`，也可以使用 `packages/**/fixtures/**` 这类根目录 glob；`**/pnpm-workspace.yaml` 不会命中。

三种 `kind` 各自只对应一种 candidate：

- `workspace-package` 选择根 `pnpm-workspace.yaml` 激活的工作区包。命中后，该包不再参与源码归属、依赖授权、检查器发现和生成图。如果工作区根目录本身也是被激活的包，可以用 `include: ['.']` 只排除根包；根工作区和其他已激活包不会因此被排除。
- `package-scope` 选择嵌套 `package.json` 的根目录。它同时覆盖已扩展的包作用域和原本已经停止治理的包作用域。排除后，该根目录及其后代都位于当前运行之外。
- `pnpm-workspace` 选择包含嵌套 `pnpm-workspace.yaml` 的目录。Limina 会在读取该清单和发现其中包之前应用排除；被排除目录仍然是硬边界。根 `pnpm-workspace.yaml` 定义当前治理起点，不能被排除。

规则只与同 `kind` 的 candidate 匹配。因此，同一个目录可以同时是 `workspace-package` 和 `pnpm-workspace` candidate，两种 identity 不会合并。

发现完成后，每条规则都必须至少命中一个同 `kind` candidate。descriptor 路径、`node_modules`、`.git`、`.limina`、明确配置的输出目录等固定 discovery ignore，以及只属于其他 `kind` 的路径，都不能让规则通过匹配验证。同一个 candidate 也不能被多条规则命中；应让模式互不重叠，而不是依赖数组顺序。

没有被排除的嵌套工作区会接受严格检查。YAML 错误、pnpm 工作区或 catalog 配置错误、包清单读取失败、包发现失败或无法建立包 identity，都会终止当前运行。应修复嵌套工作区，或为它的根目录配置明确的 `pnpm-workspace` 排除规则。

当前治理源码如果导入被排除或已经停止的区域，Limina 会按跨边界访问处理。诊断会指出边界根目录，并在可用时附上配置的原因。如果本意只是忽略少量文件、同时继续治理其所在的包，应改用源码或检查器的文件级排除配置。
