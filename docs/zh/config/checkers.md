# 检查器配置

`config.checkers` 选择已激活的默认 `tsconfig.json` 入口。Limina 随后为完整引用闭包中的每个受管类型配置分配恰好一个负责的检查器。检查器名称就是固定的身份标识：

| 键名           | 执行方式                     | 生成声明 |
| -------------- | ---------------------------- | -------- |
| `tsc`          | 生成 TypeScript 构建目标     | 是       |
| `tsgo`         | 生成原生 TypeScript 构建目标 | 是       |
| `vue-tsc`      | 生成 Vue/TypeScript 构建目标 | 是       |
| `svelte-check` | 按叶子配置执行框架类型检查   | 否       |
| `astro`        | 按叶子配置执行框架类型检查   | 否       |

源码归属、生成路径、执行工具和缓存都用键名标识检查器，不支持 `preset` 字段或自定义检查器别名。

`vue-tsc`、`svelte-check` 与 `@typescript/native-preview` 是可选的外部检查器对等依赖。它们的对等依赖版本范围表达 Limina 支持的检查器版本，每个检查器都从其目标实际执行的包作用域解析。`svelte2tsx` 是独立的可选检查器工具链对等依赖：请在每个 Svelte 叶子包中与 `svelte-check` 一并安装；Limina 不会把它作为生产依赖发布。`typescript` 仍是 Limina 必需的运行时对等依赖，从运行 Limina 的工作区安装环境解析。

自动发现始终启用。具名检查器范围先接管命中的入口；未被具名范围接管的入口仍然自动分析：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      tsc: {
        include: ['packages/shared/tsconfig.json'],
      },
      tsgo: {
        include: ['packages/native/**/tsconfig.json'],
      },
      'vue-tsc': {
        include: ['apps/web/tsconfig.json'],
      },
      'svelte-check': {
        include: ['apps/svelte/tsconfig.json'],
        exclude: ['apps/legacy/tsconfig.json'],
      },
    },
  },
});
```

每个具名检查器范围的 `include` 都必须是非空数组，`exclude` 可省略。只配置框架检查器也合法。同一个入口不能同时匹配两个具名检查器范围。

## 自动发现模式 {#auto-模式}

- **类型：** `{ exclude?: string[]; useTsgo?: boolean }`
- **默认值：** 无论是否存在具名检查器范围都启用

默认情况下，普通 TypeScript 项目由 `tsc` 负责；框架证据会在采用默认检查器前确定对应的框架检查器归属：

```text
普通 TypeScript -> tsc
Vue             -> vue-tsc
Astro           -> astro
Svelte          -> svelte-check
```

设置 `useTsgo: true` 后，只有普通 TypeScript 项目默认改由 `tsgo` 负责，框架检查器归属不变。

```js
export default defineConfig({
  config: {
    checkers: {
      auto: {
        useTsgo: true,
        exclude: ['packages/playground/tsconfig.json'],
      },
    },
  },
});
```

`useTsgo` 只改变框架分析后仍未确定检查器身份的构建连通分量（必须共享声明缓存的一组相连配置）所使用的默认检查器。在生成检查器路径之前，Limina 会合并必须共享声明缓存、且能生成声明的叶子配置：同一聚合配置下的叶子配置，以及被有效源码导入或 `liminaOptions.implicitRefs` 连接的配置。连通分量中只有一个已知的 `tsc`、`tsgo` 或 `vue-tsc` 身份时，该身份会传播到整个连通分量；尚无身份时使用默认检查器；存在两个不同身份时，`graph prepare` 失败。

Vue 能力由检查器实际解析出的文件集合确认，不能只看 `vueCompilerOptions`。Limina 会先遍历入口、聚合配置、被引用的叶子配置和有效 `extends`，再让 Vue 解析器解析真实扩展名和文件。只有确实存在匹配文件时，自定义 Vue 扩展才会切到 `vue-tsc`；只有配置提示而没有实际模块时，不会改变归属。

`auto.exclude` 只过滤已激活[治理区域](./regions.md)中的入口选择，不会裁剪从已选入口到达的有效项目引用，也不同于控制源码覆盖的 `config.source.exclude`。

旧 `{ mode: 'auto' }` 结构会被拒绝。请把 `exclude` 与 `useTsgo` 移到 `auto` 下。

## 具名入口约束与聚合配置闭包 {#named-入口约束与-solution-closure}

所有具名检查器范围使用同一个结构：

```ts
interface CheckerScope {
  include: string[];
  exclude?: string[];
}
```

`include` 只选择相对 `config.rootDir` 的直接默认 `tsconfig.json` 入口，不能直接选择 `tsconfig.lib.json`、`tsconfig.test.json` 或其他命名配置；这些配置只能通过受管引用闭包进入。外部激活包可以使用 `../`，但选择器不能把未激活路径或工作区边界后的路径拉入图中。`exclude` 在 `include` 之后移除直接入口，不会截断正常的项目引用闭包。

Limina 区分聚合配置与终端类型配置。聚合配置只组织引用，本身不是 Astro、Svelte 或 Vue 的执行目标。Limina 会递归展开嵌套聚合配置，用规范化路径对终端类型配置去重，并对每个叶子配置执行一次选定的检查器。

具名检查器选择决定完整终端叶子闭包的检查器归属。配置提示、有效根文件、依赖需求与 Vue 检查器提升都不会改写这个范围。同一检查器的重叠具名范围会合并证据；不同检查器身份覆盖同一终端叶子配置时，`graph prepare` 失败。

默认聚合配置可以直接引用命名终端配置，例如 `tsconfig.json -> tsconfig.node.json`。嵌套聚合配置自身必须使用默认名称，例如 `tsconfig.json -> packages/lib/tsconfig.json -> packages/lib/tsconfig.lib.json`。声明了引用的命名配置不能作为中间聚合配置。

`tsconfig.lib.json`、`tsconfig.test.json` 等非入口配置，只有被已选 `tsconfig.json` 入口引用时才会进入治理图。生成配置都位于 Limina 的 `.limina` 命名空间；用户配置和诊断继续使用源码配置路径。

## 框架检查器归属与依赖边界 {#framework-ownership-与-dependency-boundary}

Limina 为每个项目分别记录：

- **解析源码时确定的语义判定依据**（后文简称“语义判定依据”）决定使用哪一种与检查器兼容的模块语义解释项目依赖。
- **最终负责该配置的检查器**决定由哪个检查器执行构建或类型检查目标。

只有显式检查器选择、检查器专属配置证据、有效根文件证据，以及已确认的待定框架依赖可以锁定语义判定依据。Limina 收集完待定依赖需求后会冻结该依据。Vue 检查器提升、聚合配置约束、声明连通分量的检查器身份传播、TypeScript 默认选择与 `finalOwner` 可以选择或传播构建检查器归属，但不能重新解释项目依赖。因此，采用 TypeScript 语义的项目可以在构建检查器身份传播后由 `vue-tsc` 构建，同时继续使用 TypeScript 模块语义。

检查器归属尚未确定的自动范围先使用 TypeScript 语义。Limina 从已解析的 TypeScript 项目及其 TypeScript AST 枚举依赖，再对每条源于用户源码的依赖执行检查器类型证据校验。`ambient`、`concrete-declaration` 与 `checker-source` 证据都停在 TypeScript 边界；不受支持的语义证据会使分析失败并停止。只有 `missing` 证据可以调用 Oxc，而且 Oxc 在这里仅用于在归属推断时识别物理框架源码候选。候选必须恰好属于一个受治理配置的有效文件集合，并且只属于一个框架语义域。普通 TypeScript 文件、资源、被排除文件与有歧义的目标都不能用来确定检查器身份。Limina 会先收集完整需求集合，再确定待定的检查器归属，因此 Astro/Svelte/Vue 冲突是确定性的，不受导入顺序影响。

语义判定依据一旦锁定，所有依赖项目上下文的分析方都使用对应的 TypeScript、Vue、Astro 或 Svelte 语义数据提供组件。检查器语义解析失败的最终结果仍是 `missing`；工具链、物化、源码映射、歧义与解析宿主故障都会使分析失败并停止。已锁定项目的依赖解析不会把 Oxc 或轻量收集器当作后备方案。

`SourceEvidence` 继续提供仅来自源码的语法、诊断与源码坐标，但不能作为图或检查器的判定依据。架构分析方只接受源于用户源码、且具有 `direct-source` 或严格 `mapped-source` 来源证明的 `ProjectDependency`。无法唯一映射到源码依赖的生成依赖只能成为观察记录，绝不会创建源码推导边；有歧义的反向映射会直接报错。

显式选定 Astro 检查器时会观测 TypeScript 文件与 `.astro`；显式选定 Svelte 检查器时会观测 TypeScript 文件与 `.svelte`；显式选定 `vue-tsc` 时会观测 TypeScript 文件与检查器实际解析出的 Vue 扩展。一个框架名称不会顺带加入其他框架扩展。位于覆盖证明源码边界内、但最终负责该配置的检查器无法观测的文件，不会仅因存在就阻断 `graph prepare`；`proof check` 会以 `LIMINA_PROOF_UNCOVERED_SOURCE_FILE` 报告。

Astro/Svelte 检查器不生成声明项目、包装配置或透明构建聚合配置。`checker:typecheck` 会对其完整类型配置按叶子执行一次。需要生成声明的 TypeScript 源码必须拆到独立的 `tsc`、`tsgo` 或 `vue-tsc` 配置中。

如果 `checker:typecheck` 没有由框架检查器负责的叶子配置，它会被记录为 `disabled` 并正常退出，不运行目标对等依赖预检或检查器进程。命令仍先验证工作区并物化生成图，之后才判断是否存在目标；图准备或物化也可能先失败。`disabled` 结果不能证明执行过框架类型检查。

### 框架前置条件

框架检查器命令及其运行时都从拥有源码配置的叶子包解析：

- Astro 需要 `astro`、`@astrojs/check` 和 `typescript`，以及叶子包已生成的 `.astro/types.d.ts`。Limina 执行 `astro check --noSync --root <leaf> --tsconfig <source-config>`，不会运行 `astro sync`。
- Svelte 需要 `svelte-check`、`svelte2tsx`、`svelte` 和 `typescript`。Limina 执行 `svelte-check --workspace <leaf> --tsconfig <source-config>`，不会运行 SvelteKit 同步、启用增量模式、写入 `.svelte-check` 缓存或覆盖输出格式。

`@astrojs/check` 是 Limina 的可选对等依赖。请在每个由 Astro 检查器负责的叶子包中主动安装受支持版本；安装 Limina 不会替该叶子包安装它。

框架依赖收集使用所属检查器生成的 TypeScript 表示。Astro 只从已安装的 `@astrojs/check` → `@astrojs/language-server` 工具链解析编译器；Limina 不再直接依赖 `@astrojs/compiler`，也不再将其声明为对等依赖，不会回退到工作区安装，叶子包中其他编译器实例无法覆盖语言服务器所属的实例。Svelte 语义分析从所属叶子包解析公共 `svelte/compiler`、`svelte2tsx` 与 TypeScript。框架检查器依赖缺失时，预检仍会在启动检查器进程前失败。

`checker typecheck` 是完整重跑，不是框架监听模式。稳定的目标 ID 只表示多次运行之间的目标身份稳定，不提供增量失效能力。

## Astro 语义导入解析 {#astro-语义-import-解析}

对于语义判定依据已锁定的 Astro 项目，Limina 从官方 Astro/Volar 上下文物化主 TypeScript 服务脚本及附加服务脚本，并使用该工具链的 TypeScript 实例枚举依赖。每条生成依赖必须先严格反向映射到唯一用户源码范围，随后才由 Astro 增强的 TypeScript 宿主解析。这里不再使用独立 Astro 收集器，也不再往返于源码优先的解析流程。

只有严格的源码映射才能形成已映射依赖。Limina 先尝试完整的生成字面量词元；只有该严格查询没有结果时才尝试字面量内部内容，两次查询都不允许后备匹配。生成的合成导入即使解析到受治理工作区源码，也只能成为 `unmapped-generated` 观察记录，绝不会创建图边。损坏、歧义或相互冲突的映射、工具链不兼容、服务脚本故障与解析宿主故障都会使分析失败并停止。已锁定的解析路径不会调用 Oxc，也不会回退到工作区 TypeScript 导出解析。

Astro 适配器支持以下组件版本：

| 组件                                        | 支持契约                                    |
| ------------------------------------------- | ------------------------------------------- |
| Astro                                       | `>=7.0.0 <8.0.0`                            |
| `@astrojs/check`                            | `>=0.9.6 <0.10.0`                           |
| `@astrojs/language-server`                  | `2.16.13`                                   |
| 语言服务器所属的 `@astrojs/compiler`        | `2.13.1`                                    |
| `@volar/language-core`                      | `2.4.28`                                    |
| `@volar/kit`                                | `2.4.28`                                    |
| `@volar/typescript`                         | `2.4.28`                                    |
| 叶子包与 `@astrojs/check` 可见的 TypeScript | Limina 已声明的 TypeScript 对等依赖版本范围 |

TypeScript 对等依赖版本范围是 `>=5.4.0 <5.10.0 || >=6.0.0 <6.1.0`。Astro `7.0.0` 是受支持版本的下限，不是唯一可接受版本。适配器还会检查内部 API 结构，因此版本字符串匹配但导出不兼容时，仍然会失败并停止。

`@astrojs/check` 版本范围准入还要求表中其他组件和受支持的内部 API 结构全部满足。Limina 运行时的 `@astrojs/check` 版本准入使用 `includePrerelease: true`，因此 `0.9.7-beta.1`、`0.10.0-beta.1` 可以满足该范围。运行时准入不验证每个已安装包自身的对等依赖声明；实际消费方的安装环境仍须满足这些声明。

依赖解析遵循包归属。Limina 依次从所属叶子包、`@astrojs/check`、语言服务器、`@volar/kit` 创建解析作用域。依赖必须由所属作用域声明；按归属作用域解析失败后，不会改从工作区根目录重试。解析出的文件可以位于 pnpm 存储目录、提升安装目录或其他符号链接布局。路径只记录为来源信息，并用于隔离不同模块实例；物理路径相等永远不是兼容条件。因此，两份受支持的 TypeScript 可以来自不同的真实路径，甚至可以是范围内不同版本。

语义数据提供组件只确认源于用户源码的依赖与目标；源码归属、提供者选择、调度与图策略仍由 Limina 决定：

| Astro 源码目标 | 图策略                                                      |
| -------------- | ----------------------------------------------------------- |
| `.astro`       | 框架调度                                                    |
| `.svelte`      | 框架调度                                                    |
| `.vue`         | Astro 确认物理目标，再记录到负责目标的 Vue 检查器的框架调度 |
| `.ts` / `.tsx` | 到负责目标构建的检查器的框架调度                            |

对于 `A.astro -> B.vue -> C.ts`，`A -> B` 始终由 Astro 分析流程负责。只有独立分析 `B.vue` 源码时才使用 Vue 语义解析，因此 Vue 不会重新解释写在 `A.astro` 中的导入。`.astro` 与 `.svelte` 仍不会进入生成声明的 `files`；它们真实的跨检查器导入仍可形成框架调度，而 `declaration-provider`（声明提供者）边始终位于同一个构建检查器身份内。

## Vue 语义导入分析 {#vue-语义-import-分析}

Vue 导入收集不再提供配置字段。独立导入 API 不接受框架文件：`.vue` 依赖语义必须使用带项目上下文的 `vue-tsc` 分析环境。源码特征配置只作为适配器内部输入，用于选择官方服务脚本表示，不形成第二套依赖判定依据。

对于语义判定依据已锁定的 Vue 项目，Limina 先从检查器执行作用域解析 `vue-tsc`，再从这份已安装 `vue-tsc` 的依赖环境解析 Vue Language Core、Volar TypeScript 和工具链使用的 TypeScript。它会物化 Vue 服务脚本，全程使用同一工具链的 TypeScript 枚举生成依赖，严格反投影每条依赖，再通过支持 Volar 的宿主解析生成的语义字面量。语义身份由生成的 `semanticSpecifier`、解析模式、检查器目标、解析器、依赖种类与规范类型证据构成；源码中的原始写法不再是第二套判定依据。因此源码 `<script src="./entry.ts">` 的 `ImportRecord.specifier` 与报告中的 `importedSpecifier` 可能显示为 `./entry.js`，但文件与行号仍指向 `.vue` 源码。合成的服务脚本导入只能成为观察记录，绝不会形成图边，也不会由 Oxc 或工作区解析器补救。仅适用于 TypeScript 的源码指令保留有界的直接源码 TypeScript 语义。

Vue 适配器支持以下组件组合：

| `vue-tsc` 版本系列 | 对应 `@vue/language-core` | `@volar/typescript` | TypeScript           |
| ------------------ | ------------------------- | ------------------- | -------------------- |
| 2.2.0–2.2.12       | 与 `vue-tsc` 版本相同     | 2.4.11–2.4.28       | 5.4.x–5.9.x 或 6.0.x |
| 3.2.0–3.2.4        | 与 `vue-tsc` 版本相同     | 2.4.27              | 5.4.x–5.9.x 或 6.0.x |

发布包只将 `vue-tsc` 声明为 Vue 可选检查器对等依赖。`@vue/language-core` 与 `@volar/typescript` 是检查器内部工具链包：应用无需为 Limina 安装它们，Limina 也不再将它们发布为对等依赖。`vue-tsc` 对等依赖版本范围表达受支持的外部检查器版本；Limina 仍按上表校验实际安装的完整组件版本组合。顶层检查器缺失或版本越界时分别报告 `Missing external checker` 或 `Unsupported external checker`；内部组件组合不完整或不兼容时报告 `Unsupported vue-tsc toolchain`，修复方式是在对应检查器作用域升级、降级或重装 `vue-tsc`，而不是直接安装内部包。

该 Vue 组件组合使用的 TypeScript 属于检查器工具链，通过 `vue-tsc` 解析；它不要求与 Limina 自身必需的 TypeScript 运行时是同一个物理安装。

不受支持的组件组合会使带项目上下文的 Vue 依赖准备失败并停止。独立 API 不会回退到轻量 Vue 收集器或近似的 Vue 扩展解析器。

## Svelte 语义依赖分析 {#svelte-语义-dependency-分析}

对于语义判定依据已锁定的 Svelte 项目，Limina 从所属叶子包解析公共 `svelte/compiler`、受支持的公共 `svelte2tsx` 对等依赖与 TypeScript。适配器把原始组件转成生成的 TSX 与 Source Map v3 源码映射；Limina 不会为非 Svelte 消费方打包或安装这个 Svelte 专用适配器。依赖由同一 TypeScript 实例枚举。只有解码后的映射段显式覆盖生成依赖范围内每个 UTF-16 偏移，并且单调、连续地映射到当前源码时，来源证明才成立；稀疏、部分、未映射、跨源码、倒退或跳跃的范围会使分析失败并停止，不会用最近的较小或相等偏移处的映射段补齐缺口。

这条有界路径不会加载 `svelte.config.js`，不会执行预处理或默认语言钩子，不会导入 `svelte-check` 或语言服务器的私有子路径，也不会复刻快照与语言服务生命周期。它只用一个极小的检测器识别显式 `lang="ts"` 或 `lang="typescript"`，为公共 `svelte2tsx.isTsFile` 提供输入；依赖图策略不区分实例脚本与模块脚本。有界 TypeScript `Program` 的叠加层只能为已枚举字面量查询环境声明的类型检查器证据，不能成为第二套 `.svelte` 模块解析器。生成的合成依赖只能成为观察记录，已锁定的 Svelte 解析永不回退到 Oxc。

对所有语义判定依据已锁定的框架，准备阶段会同时记录检查器目标与现有 `TypeEvidence`。受管源码目标形成项目依赖，具体声明停在声明边界，`target = null` 且具有环境声明证据时形成有类型的非源码观察记录，`target = null` 且证据为 `missing` 时仍为缺失。文件是否存在、资源扩展名、虚拟模块允许清单、工作区导出解析与 Oxc 都不能把检查器解析失败变成新目标。

### 从 `config.imports.vue` 迁移的破坏性变更 {#从-config-imports-vue-迁移的-breaking-change}

删除 `config.imports.vue`，不需要添加替代字段。仍包含 `config.imports` 的配置会在加载时直接报告这项迁移。公共 `VueImportParser` 类型以及 Limina 对 `@vue/compiler-sfc` 的直接/可选依赖也已删除。

Limina 不再提供 `compiler-sfc` 专属的重复脚本块或 `<script setup src>` 结构诊断；单文件组件是否有效由 Vue 检查器与编辑器工具负责。Limina 只在自身分析边界内报告源码来源、解析与图错误。

## 声明依赖与检查器身份 {#声明依赖与检查器-identity}

Limina 会区分声明依赖和框架调度依赖：

- `declaration-provider` 表示真实的编译器声明关系，可以成为生成的 TypeScript 项目引用。
- `framework-schedule` 只用于排列框架检查或构建顺序，绝不会写成生成的 `tsconfig` 项目引用。

提供方会先于消费方运行。纯框架调度循环会作为一个调度连通分量执行；声明循环仍然失败。

每条成功生成的 `declaration-provider`（声明提供者）边两端都具有完全相同的 `tsc`、`tsgo` 或 `vue-tsc` 身份，并在版本 5 的生成清单中记录 `cacheReuse: "reusable"`。因此，规范声明关系会在生成配置与目标物化前，把检查器身份传播到整个构建连通分量。连通分量已包含不同构建检查器身份时，`graph prepare` 会失败，不再保留跨检查器引用，也不再发出缓存反复失效警告。`framework-schedule` 不是编译器项目引用，因此仍可跨检查器身份。

## 从别名与 `preset` 迁移 {#从-alias-与-preset-迁移}

把旧条目移到与其 `preset` 同名的固定键名下，再删除 `preset`：

```js
// 修改前
checkers: {
  typescript: {
    preset: 'tsgo',
    include: ['packages/**/tsconfig.json'],
  },
  vue: {
    preset: 'vue-tsc',
    include: ['apps/web/tsconfig.json'],
  },
}

// 修改后
checkers: {
  tsgo: {
    include: ['packages/**/tsconfig.json'],
  },
  'vue-tsc': {
    include: ['apps/web/tsconfig.json'],
  },
}
```

如果多个别名以前使用同一个 `preset`，需要把不重叠的选择器合并到一个固定键名下。需要显式处理重叠的选择器或冲突的策略；Limina 不为旧别名分配优先级。配置文件是 TypeScript/MTS，因此 Limina 会给出确定的配置结构诊断，但不会自动改写。

## 生成图与生成清单 {#生成图与-manifest}

运行 `limina graph prepare` 会物化 `.limina/manifest.json` 和生成的检查器配置。受管构建和类型检查命令与流水线会按需物化；只读的图检查、源码检查和覆盖证明检查只在内存中计算图。

当前生成清单为版本 5。它同时持久化归属计划（配置角色、最终负责该配置的检查器与聚合配置叶子闭包）、稳定排序的带类型 `dependencyEdges`，以及构建和框架执行目标。版本 1 到 4 只作为旧生成产物的归属台账，用于安全清理后写入版本 5。未来版本或格式错误的生成清单会导致处理失败并停止。
