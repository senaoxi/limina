# 内置任务

Limina 根据源码 `tsconfig`、项目引用、导入关系和工作区包生成工程图。内置任务分别检查图、源码边界和覆盖范围，运行类型检查器，并检查配置的发布产物。

本页说明各任务的职责与执行状态。任务名用于流水线，例如 `graph:check`；独立命令写成 `limina graph check`。`limina check graph` 则要求配置了名为 `graph` 的流水线，三种写法不能互换。

具体命令和参数见 [CLI 参考](./cli.md)，团队工作流见[流水线配置](./config/pipelines.md)。

## 默认检查 {#先理解默认检查}

`limina check` 不带流水线名时，会先运行共享准备步骤 `workspace:validate`，并物化本次检查所需的生成图，再调度五个默认任务：

1. `graph:check`
2. `source:check`
3. `proof:check`
4. `checker:build`
5. `checker:typecheck`

这个顺序是结果展示和记录顺序，不表示默认检查按这个顺序串行执行。默认检查会把这些任务作为独立任务调度；在并发额度和资源锁允许时，它们可以同时运行。某个任务失败会让本次检查失败，其他默认任务仍可继续。

`workspace:validate` 由所有依赖拓扑的工作共享。它必须先成功，源码、证明、图、检查器、迁移、包、发布或 Limina 托管的产物生成工作才能开始。它既会记录为准备步骤，也是一个 `LiminaCheckTaskName`，因此可以用 `limina check --issues --task workspace:validate` 查询结构化问题。它由 Limina 自动注入，不是用户可配置的流水线步骤。

命名流水线不同。`limina check <name>` 会按照配置中的流水线步骤顺序执行，用于表达明确的先后关系，例如先构建再检查产物。

内置任务可以直接写成字符串。以下示例假设项目已有生产构建脚本 `pnpm build`，并配置了 `package.entries`；它不执行发布：

```js
export default defineConfig({
  pipelines: {
    release: [
      'checker:build',
      { type: 'command', command: 'pnpm', args: ['build'] },
      'package:check',
      'release:check',
    ],
  },
});
```

也可以写成显式对象：

```js
{ type: 'task', name: 'graph:check' }
```

除内置任务外，流水线步骤也可以是外部命令。已执行内置任务失败会让最终结果失败，但不会因此停止后续有序步骤。必要准备步骤不同：`workspace:validate` 或 `graph:materialize` 失败会阻塞依赖任务。外部命令失败会停止剩余步骤，并把它们记为 `skipped`（已跳过）。准备失败本身不会取消后续外部命令，具体例子见[流水线的失败策略](./config/pipelines.md#pipelines)。

## 任务总览

| 任务                | 默认检查 | 主要关注点                                            | 执行内容                                                         |
| ------------------- | -------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| `graph:prepare`     | 否       | 生成 `.limina` 下的工程图、声明构建配置和相关生成文件 | 物化生成图；不等同于检查图是否符合规则                           |
| `graph:check`       | 是       | 项目引用、工作区导入、导出解析、图规则和条件域        | 检查 `TypeScript` 项目引用图是否和源码导入关系、配置规则一致     |
| `source:check`      | 是       | 源码归属、包边界、依赖声明、`Knip` 支持的源码使用分析 | 检查源码依赖关系是否能被包归属和清单文件解释                     |
| `proof:check`       | 是       | 源码覆盖、`tsconfig` 角色和框架投影                   | 检查源码和框架能力是否进入一致、可执行的检查范围                 |
| `checker:build`     | 是       | 构建类检查器                                          | 调用底层检查器的构建模式，通常会产出声明文件和构建信息           |
| `checker:typecheck` | 是       | 框架检查器负责的类型叶子配置                          | 对每个归属叶子配置调用一次 `astro` 或 `svelte-check`，不产出声明 |
| `package:check`     | 否       | 已构建包产物                                          | 对 `outDir` 产物运行打包、类型解析和产物导入边界检查             |
| `release:check`     | 否       | 发布期产物一致性                                      | 发布前补充检查；不应理解为发布系统或安全保证                     |

外部命令把连续内置任务分成不同任务段。每段复用当前分析代次已验证的工作区上下文。包含 `graph:prepare`、`checker:build` 或 `checker:typecheck` 的任务段，还会在内置任务前获得共享准备步骤 `graph:materialize`。必要准备步骤失败时，依赖任务记录为 `blocked`（被阻塞）。工作区问题仍可写入 `.limina/check/last-run.json`；后续快照写入失败不会替换最初的验证错误。

### 任务状态

| 状态       | 含义                                                         |
| ---------- | ------------------------------------------------------------ |
| `passed`   | 任务已执行，其检查范围内未产生失败结果                       |
| `failed`   | 任务执行失败或发现使该任务失败的问题                         |
| `disabled` | 没有适用的已启用工作，例如不存在 Astro / Svelte 类型检查目标 |
| `blocked`  | 必要准备步骤失败，依赖任务无法开始                           |
| `skipped`  | 工作没有执行，例如外部命令失败后的剩余步骤                   |

可选包分析器未安装时也会报告 `skipped`，仅发生这种跳过仍可能正常退出。判断是否覆盖预期检查，需要同时看任务与工具状态；零退出码不等于每项检查都实际运行。

::: details 多个进程共享生成文件时

生成的检查器配置由工作区根的规范路径上的跨进程读写租约保护。托管构建与类型检查进程会在完整消费期间持有读租约；物化会等待读取方退出，并在修改产物前发布进行中标记。如果写入方中途退出，读取方会拒绝继续，不会读取混合状态的文件树。下一个执行物化的写入方会按当前完整计划重写目标、删除不再归属的旧文件，完成后才允许读取方继续。租约等待上限为 30 秒。

:::

## 生成图是后续检查的基础

Limina 的治理建立在生成图之上。生成图来自普通源码 `tsconfig.json` 入口、被这些入口引用到的源码 `tsconfig`、源码文件导入关系，以及少量显式配置。

每个具名检查器的 `include` 选择源码层的普通 `tsconfig.json` 入口。普通叶子配置不应该手写 TypeScript `references`；如果某个目录需要聚合多个类型检查环境，应使用默认 `tsconfig.json` 作为聚合器，让它通过 `references` 指向叶子配置。Limina 再根据这些源码配置生成归属与依赖计划。

`graph:prepare` 会把这些关系写到 `.limina` 目录下，包括：

- 检查器构建入口；
- 生成的声明构建 `tsconfig`；
- 受支持的 `tsconfig.json` 聚合构建配置；
- 生成清单；
- 供源码使用分析使用的生成配置。

生成的声明构建配置会继承对应源码配置，并写入适合声明构建的选项，例如 `composite`、`incremental`、`declaration`、`emitDeclarationOnly`、`noEmit: false`、`rootDir`、`outDir`、`declarationDir` 和 `tsBuildInfoFile`。生成配置中的 `outDir` 与 `declarationDir` 始终是同一个 Limina 受管根目录。

Limina 根据源码导入、配置入口和显式例外推导符合条件的 `references`，再通过检查任务验证生成图。

### 静态导入与显式引用例外

大多数引用边来自源码中的静态导入。假设一个包的源码导入了另一个受管源码项目：

```ts
import { createClient } from '@acme/core';
```

导入到另一受管源码叶子只是候选关系。它还要有声明构建需求、唯一的目标归属、可构建且检查器身份一致的端点，并通过图规则，才能成为生成引用。若当前检查器已经消费具体声明文件，则停在声明边界。完整过程见[从导入解析到声明构建图](./import-resolution-to-declaration-build-graph.md)。

也存在静态导入无法表达的关系，例如生成代码或运行时清单中确实需要的声明构建关系。此时可以在声明该关系的源码 `tsconfig` 中写 `liminaOptions.implicitRefs`：

```jsonc
{
  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../core/tsconfig.json",
        "reason": "本叶子的声明构建需要生成路由清单引用的 core 源码。",
      },
    ],
  },
}
```

`path` 指向另一份普通源码 `tsconfig`。必填的 `reason` 用于解释关系，声明的边仍需通过图检查。

## `graph:check`：让项目引用图和源码关系对齐

`graph:check` 检查生成的项目引用是否与源码导入、工作区包关系和配置的架构规则一致。编译器检查另行执行。

它主要覆盖以下几类问题。

### 项目引用是否有依据

保留的检查器证据要求访问另一个受管项目，且存在符合条件的声明提供者时，生成声明配置应包含该引用。`graph:check` 会报告缺失的必要引用，并检查生成引用是否具有推导依据或显式允许项。`liminaOptions.implicitRefs` 声明静态分析看不到的关系；`allow.refs` 可以解释允许的额外引用，但不会自行创建引用。

语义判定依据与最终负责该配置的检查器各有职责：前者固定源码配置的解释方式，后者选择执行检查器。构建着色或聚合约束可以把普通 TypeScript 配置分配给 `vue-tsc`，但不会改变其已冻结的 TypeScript 语义。

新增静态分析看不见的关系时使用 `liminaOptions.implicitRefs`；图规则中的允许项只解释已有的额外引用。两者都不能替代禁止规则或解析证据。

### 工作区包导出是否适合源码导入

当受管源码通过包名导入工作区包的导出时，Limina 会尝试解析该导出。对于被源码导入的公开入口，解析结果需要能落到稳定的类型入口或检查器支持的源码入口。

这项检查针对实际导入，使用保留的检查器解析结果与类型证据。只有运行时入口、却没有可用类型或受支持源码证据的导出可能产生诊断。Limina 不会预先证明全部公开导出；存在 JavaScript 或环境类型目标也不意味着需要声明引用。依赖收集不完整时，会报告不完整或失败，不能当作已经验证的空图。

这些诊断针对源码依赖的类型依据，不能据此判断包已满足发布要求。

### 跨包引用是否有依赖声明

跨工作区包的项目引用代表源码层依赖。引用方和被引用方都需要有明确的包身份；引用方还需要在自己的 `package.json` 依赖区中声明被引用包。

这样，源码引用和包清单会记录同一份跨包依赖。

### 图规则是否被违反

如果源码 `tsconfig` 通过 `liminaOptions.graphRules` 启用了某个图规则，`graph:check` 会按该标签检查被禁止的引用或依赖。

例如，一个面向浏览器的项目不应依赖 `Node` 运行时模块，可以把这类约束写成图规则，再让对应 `tsconfig` 启用该规则。命中规则时，诊断会带上规则中的原因。

图规则只覆盖源码和配置表达出来的关系。它不是运行时沙箱，也不是发布安全保证。

## `source:check`：让源码导入能被包归属解释

`source:check` 关注源码文件属于哪个工作区包，以及源码里的导入是否能被这个归属关系解释。

`graph:check` 检查项目引用；`source:check` 检查包归属、清单文件和源码导入。

### 相对导入不能跨包边界

相对导入只能在当前最近的 `package.json` 包边界内移动。跨进另一个包目录时，应改用包名导入，并在引用方清单文件中声明依赖。

错误示例：

```ts
import { helper } from '../../core/src/helper';
```

改用包名导入：

```ts
import { helper } from '@acme/core';
```

这样依赖关系会出现在源码导入和 `package.json` 中，而不是隐藏在目录相对路径里。

### 裸包导入需要授权

裸包导入，例如 `import pMap from 'p-map'`，需要能被当前源码归属方的 `package.json` 解释。Limina 还支持通过 `source.importAuthority.allow` 增加有限的授权来源：按源码归属方分组的授权可以让匹配导入读取工作区根清单中的指定依赖声明。

只为需要例外的源码归属方和导入配置授权。

### # 子路径导入遵守包作用域

`#utils/*` 这类包导入映射会匹配导入文件最近包作用域的 `package.json#imports`。如果这个映射使用相对目标，解析结果必须留在声明它的包作用域内。

`imports` 目标也可以写成包名，例如 `{ "imports": { "#dep": "p-map" } }`。这种写法表示外部依赖入口，可以解析到三方包或工作区依赖；但授权仍然来自导入文件所属的激活源码归属方，需要在依赖字段里声明，或命中匹配的工作区根依赖授权。

没有匹配会报告 `Unauthorized package import specifier:`，并指向最近的包作用域。匹配后无法解析会报告 `Unresolved package import specifier:`。相对目标越过声明它的包作用域，会报告 `Package import relative target escapes package scope:`。包名目标未授权时继续使用依赖授权诊断。

### Knip 支持的使用分析是辅助信号

只有在 `source.knip` 明确写为 `true` 或拥有 `root` 或 `workspaces` 的对象时，`source:check` 才会使用 `Knip` 支持的分析结果报告两类问题：

- 已声明但未被源码使用到的工作区依赖；
- 从包入口、二进制入口、脚本、插件入口或显式入口不可达的源码模块。

Knip 的结论取决于分析的入口，不证明完整的运行时可达性。通过生成代码、运行时字符串或外部工具加载的入口，应使用带原因的配置项声明例外。

## `proof:check`：确认源码进入受管检查范围

`proof:check` 检查受治理源码文件是否被检查器入口、生成图项目或允许清单覆盖。

它和 `source:check` 的区别在于：

- `source:check` 关心源码导入和包归属是否清楚；
- `proof:check` 关心源码是否进入受管类型检查范围，以及 `tsconfig` 的角色是否清楚。

在使用 `TypeScript` 项目引用的多包仓库里，遗漏一个源码文件并不一定会立刻表现为项目引用错误。它可能只是没有被任何检查器入口触达。`proof:check` 用来把这类“没人检查”的文件暴露出来。

仍在治理范围内、却有意没有普通覆盖的文件，可以在[允许清单](./config/proof-allowlist.md)中说明原因。允许清单不改变检查器输入，也不表示文件已通过类型检查。

对框架源码，覆盖证明还会检查：每个类型配置恰有一个负责的检查器；每个受治理框架源码实际位于该检查器的有效文件集合；每个框架目标都能从所属叶子包执行；每个聚合配置的叶子配置归属一致；生成声明配置不包含 `.astro` 或 `.svelte` 输入。

其他覆盖证明诊断也会检查源码和 `tsconfig` 的角色，包括同一检查域内重复或冲突的文件归属。

## `checker:build`：调用构建类检查器

`checker:build` 会调用已配置的构建检查器标识：

- `tsc`
- `tsgo`
- `vue-tsc`

这些检查器会以构建模式运行，例如 `tsc -b`、`tsgo -b`、`vue-tsc -b`。运行目标是 Limina 生成的检查器构建入口，而不是用户手写的任意命令。

因为生成的声明构建配置会开启 `emitDeclarationOnly` 并关闭 `noEmit`，所以 `checker:build` 不是无副作用检查。它会运行真实的底层检查器，并可能写出 `.d.ts` 和 `.tsbuildinfo` 等产物。

Limina 准备生成图，再由所选检查器执行类型构建。

运行前，Limina 会检查已配置检查器需要的对等依赖是否可解析。缺失依赖时会在执行检查器前失败，并给出安装提示。

## `checker:typecheck`：执行框架检查器负责的叶子配置 {#checker-typecheck-执行-framework-owned-leaves}

`checker:typecheck` 会按规范化的配置路径去重，执行最终由 `astro` 或 `svelte-check` 负责的每个类型配置。一个叶子配置只会执行 `astro check --noSync --root <leaf> --tsconfig <config>` 或 `svelte-check --workspace <leaf> --tsconfig <config>` 之一，不能同时成为两种检查器目标。聚合配置由 Limina 展开，不会作为依赖框架检查器递归能力的执行目标。这些任务不产出声明文件。

框架目标会从所属叶子包解析依赖。Astro 要求 `astro`、`@astrojs/check`、`typescript` 和已存在的 `.astro/types.d.ts`；Svelte 要求 `svelte-check`、`svelte2tsx`、`svelte` 和 `typescript`。Limina 不会运行 `astro sync`，不会启用 Svelte 检查器缓存，并且这个命令不接受 `--watch`。源码配置、解析器依赖、框架生成类型或框架源码变化后，需要重新运行完整命令。

没有目标的结果产生前仍会执行工作区验证和生成产物物化，并取得校验修订版本的读租约。如果没有受管类型配置归 `astro` 或 `svelte-check` 所有，`checker:typecheck` 会记录 `disabled`（无适用工作）并正常退出，不执行检查器对等依赖预检或检查器；构建型检查器负责的配置仍由 `checker:build` 执行。

## `graph:prepare` 和 `graph export`

`graph:prepare` 会验证工作区与图输入、计算计划并物化文件，但不会运行 `graph:check` 治理规则或调用编译器。消费生成文件的任务会自动准备所需文件；需要单独检查或刷新磁盘文件时，再运行它。

`graph export` 用于导出 Limina 在受管 `tsconfig` 范围内收集到的依赖图。它支持不同视图，例如只看源码边、只看产物边，或同时导出。这个图适合用于架构诊断和外部分析，但不应被当作权威构建顺序来源。

## `package:check`：检查已构建的包产物

`package:check` 不在默认检查中。它面向已构建的包输出目录，而不是源码目录。

可选检查包括：

- `publint`
- `attw`
- `boundary`

在项目构建后运行它，检查包结构、类型解析和产物导入边界。它不执行包构建，检查结果也不能作为发布安全保证。

如果某个项目还没有产物目录或产物清单文件，应该先运行该项目自己的构建流程，再运行 `package:check`。

## `release:check`：发布期补充检查

`release:check` 也不在默认检查中。它面向发布前的产物一致性检查，适合放在发布流水线末尾。

`release:check` 按基线标签、内置忽略集和自定义忽略规则比较依赖产物内容。诊断反映产物差异；发布、版本管理和发布审查仍需单独执行。

如果需要把 `release:check` 放进持续集成，建议把它和项目自己的构建、测试、包产物检查放在同一个命名流水线中，让执行顺序明确。

## 选择下一步 {#推荐理解方式}

日常使用默认 `check`；定位问题时按失败任务运行独立命令。修改源码范围、入口或规则后，仍应回到完整检查。准备发布时，再用项目构建生成消费者产物，并运行已配置的包检查和发布检查。可直接参考[工作流](./workflows.md)。
