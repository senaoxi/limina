# 治理区域

`regions` 决定哪些包及嵌套包作用域属于本次治理。先用它确定包范围，再用 `config.source` 选择其中的文件，用 `config.checkers` 选择检查器入口。

::: warning 注意
`regions.exclude` 不能替代 `config.source.exclude`。包类型排除会移除包治理权限，检查器的 `exclude` 只改变入口选择。精确 `tsconfig` 类型用于在读取 `outputs` 声明前隔离配置，同时保留包的激活状态。它不会隐藏源码文件，也不会让残留入边变得合法；迁移还必须修剪这些关系。
:::

```ts
interface RegionsConfig {
  extendNestedPackageScopes?: boolean;
  exclude?: RegionExcludeConfig[];
}

interface RegionExcludeConfig {
  kind: 'workspace-package' | 'package-scope' | 'tsconfig';
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
        kind: 'workspace-package',
        include: ['packages/legacy-app'],
        reason: '这个包由另一套 Limina 运行独立治理。',
      },
    ],
  },
});
```

## 默认治理区域

所选配置最近的 `package.json` 固定治理根。该根有工作区声明时，由对应的包管理器适配器提供原始成员；没有声明时，原始集合为 `[rootPackage]`。详见[配置发现与治理根](./config-file.md#治理根)。它先用完整原始集合验证 `workspace-package` 排除规则并应用这些规则，再建立激活包索引。剩余的每个包都是一个独立的包治理单元（以包根目录为起点、受所属包边界约束的治理范围），包根目录的 `package.json` 是它的归属清单，用于确定源码归属和依赖授权。激活包可以位于 `config.rootDir` 外；报告会保留 `../shared` 这类词法显示路径，归属和冲突判断则使用规范化后的物理目录。

工作区包发现遵循所选包管理器的策略。遍历始终排除以下目录名：

| 包管理器 | 固定忽略目录                         |
| -------- | ------------------------------------ |
| pnpm     | `node_modules`、`bower_components`   |
| npm      | `node_modules`                       |
| Yarn     | `node_modules`、`.git`、`.yarn`      |
| Bun      | `node_modules`、`.git`、`CMakeFiles` |

`test` 和 `tests` 被匹配时是普通候选目录。通配模式的选择语义因包管理器而异：例如 npm 和 Bun 的后续正向模式可以重新包含包，而 pnpm 和 Yarn 保留排除。精确排除一个包不一定排除其后代；需要排除子树时应显式声明。根包清单独立于通配模式加入，包名可以缺省。

Limina 用 `packageManager` 识别包管理器，并应用上表中的选择策略。版本后缀不会启用历史发现行为，包括后来被上游修复的行为。需要与特定历史版本保持工作区成员集合精确一致时，应核对实际发现的原始包集合；Limina 不保证两者一致。

这些受支持的发现规则不证明包管理器的完整配置合法。即使某个包管理器版本允许显式选中元数据目录，Limina 仍保留上表的固定忽略目录。

每个包治理单元内部遵循这些边界规则：

- 默认情况下，遇到嵌套 `package.json` 就从该目录停止治理。
- 嵌套工作区根（`pnpm-workspace.yaml` 或具有自有 `workspaces` 字段的 `package.json`）永远会停止当前包治理单元的遍历。
- 激活的父包不会遍历激活的子包；Limina 会从子包根目录启动独立发现任务。
- 一个目录即使位于工作区根目录下，只要不属于被激活的工作区包，也不会自动进入当前区域。

例如，使用默认配置时：

```text
packages/app/                         受治理，由 packages/app/package.json 归属
packages/app/src/                     受同一个源码所属包管辖
packages/app/fixtures/package.json    嵌套包作用域边界
packages/app/fixtures/src/            不属于当前区域
packages/app/vendor/pnpm-workspace.yaml  工作区硬边界
packages/app/vendor/pkg/              不属于当前区域
```

自动检查器发现不会进入这些已停止的边界。如果显式选中的源码配置拥有或包含边界另一侧的文件，Limina 会报告越界，而不是静默扩大治理区域。

祖先边界不会阻止已激活的后代包启动自己的包治理单元。因此，可见范围按当前源码所属包划定：父包不会读取其嵌套工作区或激活子包边界之后的配置描述文件，单独激活的后代包仍然可以治理自己的文件。默认源码发现和自动检查器发现会针对每个包治理单元独立运行，包括位于 `config.rootDir` 外的激活包。

正常源码、证明、图、检查器、包、发布或产物生成工作开始前，`workspace:validate` 都会先建立这份激活包索引。迁移复用相同的治理权限检查；仅在可恢复的 `outputs` 输入错误后使用受信任的初始候选进行规范化，并在写入前后重新读取完整输入拓扑。它会在归属索引建立前拒绝结构歧义：

- 应用 `workspace-package` 排除后仍处于激活状态的非根包，如果自身又声明另一个工作区根，会报告 `LIMINA_WORKSPACE_REGION_OVERLAP`；
- 两个词法包根目录如果解析到同一个物理目录，会报告 `LIMINA_WORKSPACE_PACKAGE_IDENTITY_CONFLICT`；
- 不安全的输出归属和无法稳定的输出可见性分别报告 `LIMINA_WORKSPACE_OUTPUT_ROOT_INVALID`、`LIMINA_WORKSPACE_OUTPUT_CYCLE`。

这些都是工作区验证错误。无效包区域不会参与归属、源码发现、生成图、迁移、包选择、发布选择或产物生成。

## `extendNestedPackageScopes`

- **类型：** `boolean`
- **默认值：** `false`

当嵌套 `package.json` 只是用于解析包作用域，但其中源码仍应由外层工作区包治理时，可以把 `regions.extendNestedPackageScopes` 设为 `true`。

只有同时满足以下条件，嵌套 `package.json` 才能被扩展：

1. 当前工作区声明没有把该目录识别为工作区包。
2. 该清单没有自己的 `name` 字段。
3. 该目录不位于嵌套工作区边界内。

`name` 的判断依据是字段是否存在，而不是值是否有效。例如，`"name": ""` 和 `"name": null` 仍然会阻止扩展。

扩展只发生在当前区域内部。Limina 可以连续穿过多层都满足条件的包作用域，但遇到第一个不满足条件的嵌套清单或嵌套工作区边界就会停止。这个选项不能把被激活工作区包之外的普通目录吸收到当前区域。

被扩展的包作用域不会成为新的源码归属方。它的源码继续使用外层工作区包的归属清单和依赖声明；但这个嵌套清单仍然是相对导入边界和 `package.json#imports` 解析所使用的最近包作用域。

## `exclude`

- **类型：** `RegionExcludeConfig[]`
- **默认值：** `[]`

每条规则都必须提供 `kind`、非空 `include` 数组和非空 `reason`。Limina 不会推断 `kind`，也不接受省略 `kind` 的旧写法。

对于 `workspace-package` 与 `package-scope`，`include` 只匹配相对于 `config.rootDir` 的词法候选根目录；`config.rootDir` 外的激活包可以使用 `../`。它不匹配包名、`package.json` 路径、`pnpm-workspace.yaml` 路径、规范化后的物理路径或任意普通文件。例如，包或包作用域根目录位于 `packages/app/fixtures/local` 时，应使用 `packages/app/fixtures/local`，也可以使用 `packages/**/fixtures/**` 这类根目录通配模式；`**/package.json` 不会命中。

两种包类型的 `kind` 各自只对应一种候选：

- `workspace-package` 从所选治理根的完整原始成员（包括单包根）中选择精确包根候选。Limina 会在重叠检查前验证这些规则，再让每个被匹配的包退出源码归属、依赖授权、源码与检查器发现以及生成图。匹配父包不会级联删除未匹配的激活后代；需要级联时必须显式匹配每个后代。如果工作区根目录本身也是激活包，可以用 `include: ['.']` 只排除根包；工作区和其他激活包不会因此被排除。显式配置的 `package.entries` 仍是独立产物条目，不会被这类规则删除。
- `package-scope` 选择嵌套 `package.json` 的根目录。它同时覆盖已扩展的包作用域和原本已经停止治理的包作用域。排除后，当前外层包的治理范围在该根目录停止，不再向下发现文件。边界下方若另有已独立激活的工作区包，它仍从自己的包根启动治理；要让它退出本次运行，须另用 `workspace-package` 排除。

规则只与同 `kind` 的候选匹配。因此，同一个目录即使同时是激活包和嵌套包作用域，这两种身份也不会合并。

每条包类型规则都必须至少命中一个同 `kind` 的候选。`workspace-package` 规则会在激活与重叠检查前，使用完整的原始包候选集合验证；`package-scope` 规则则在嵌套描述文件与输出可见性稳定后验证。描述文件路径、`node_modules`、`.git`、`.limina`、明确配置的输出目录等固定发现忽略项，以及只属于其他 `kind` 的路径，都不能让规则通过匹配验证。同一个候选也不能被多条规则命中；应让模式互不重叠，而不是依赖数组顺序。

### 精确 `tsconfig` 排除

`kind: 'tsconfig'` 接受相对于配置根的精确 `tsconfig.json` 或 `tsconfig.*.json` 文件路径，允许 `../`，不接受目录或通配选择器。它在读取 `outputs` 声明和计算描述文件可见性的稳定性之前，按投影后的规范文件身份匹配。只移除匹配的配置描述文件，包的激活状态和源码文件治理权限保持不变。被排除的文件不存在时不会报错，因此删除隔离的坏文件不会让排除规则失效。包类型的候选命中和重叠规则不应用于该类型。

```js
regions: {
  exclude: [{
    kind: 'tsconfig',
    include: ['packages/app/tools/tsconfig.json'],
    reason: '该配置无法解析；指向它的成员引用已被修剪。',
  }],
}
```

示例不会排除 `packages/app`、兄弟配置或 `tools` 内的源码文件。保留下来的聚合配置引用若仍指向被排除文件，依然是输入问题。持久化及动态配置限制见[迁移](../cli.md#limina-migration)。

## 路径坐标与输出安全

每类公共路径字段只使用一套坐标：

- 源码选择器和所有 `regions` 选择器都相对于 `config.rootDir`，可以包含 `../`；
- `package.entries[].outDir` 相对于 `config.rootDir`，可以指向外部激活包的输出；
- `liminaOptions.outputs.outDir` 相对于声明它的源码 `tsconfig`；
- 问题记录中的路径相对于 `config.rootDir`，必要时保留 `../`；
- Limina 持久生成的产物全部位于受信任的 `.limina` 命名空间内。外部包产物使用内部 `external/<stable-id>/...` 段，不会把 `../` 复制到生成路径中。

包条目的输出是无条件输出根目录。`tsconfig` 输出只有在该 `tsconfig` 仍可从所属包治理单元访问、且不位于无条件输出内时才参与计算。Limina 会迭代计算描述文件可见性和输出根目录，直到状态稳定；自输出和互相隐藏的输出循环属于配置错误。

每个声明的输出都必须是专用目录。它可以是 `packages/app/dist`、`packages/app/generated` 或 `../shared/dist` 这样的严格后代目录，但不能等于或包含 `config.rootDir` 或任何激活包根目录，也不能与 `.limina` 发生任一方向的包含。这里的激活包根目录，是应用 `workspace-package` 排除后的有效集合：仅仅属于已排除的原始包不会继续占用输出路径，但任何未被匹配、仍然激活的后代包都会继续保护自己的根目录。Limina 会先校验词法和规范物理身份，合法输出才可以从发现范围移除描述文件。

嵌套工作区根（`pnpm-workspace.yaml` 或具有自有 `workspaces` 字段的 `package.json`）是自动生效、仅对所属包生效的边界，不是公开的排除候选。父包治理单元只记录边界，不读取或校验嵌套工作区上下文；如果原始工作区成员关系激活了边界下方的包，每个包仍会独立启动自己的包治理单元任务。

当前治理源码如果导入被排除或已经停止的区域，Limina 会按跨边界访问处理。检查器入口的 `references` 也遵循同一套结构边界：检查器的 `exclude` 不会让跨区域引用变得有效，也不会隐藏有效入口触达的现有普通源码配置。诊断会指出边界根目录，并在可用时附上配置的原因；如果路径不属于任何已登记边界，诊断会明确说明当前运行没有已激活工作区包拥有它。若需过滤期望纳入治理的源码文件并保留包治理，使用 `config.source.exclude`。检查器入口排除只改变直接入口发现，不过滤源码文件，也不切断已建立的成员引用闭包。
