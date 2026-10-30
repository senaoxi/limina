# 检查器配置

当 Limina 检查或构建项目时，需要知道每份 TypeScript 配置由哪个检查器处理。`scope.checkers` 用来选择项目的 `tsconfig.json` 入口，并在需要时指定检查器。

大多数项目**不需要配置这个字段**。Limina 会在已激活的[治理区域](./regions.md)中自动寻找入口，根据项目使用的文件和框架选择检查器。只有想要修改默认检查器、排除自动发现的入口，或明确指定某个入口使用的检查器时，才需要填写它。

Limina 支持以下固定名称：

| 配置键         | 适用场景                 | 生成内部声明文件 |
| -------------- | ------------------------ | ---------------- |
| `tsc`          | TypeScript 项目          | 是               |
| `tsgo`         | 使用原生 TypeScript 构建 | 是               |
| `vue-tsc`      | Vue 和 TypeScript 项目   | 是               |
| `svelte-check` | Svelte 项目的类型检查    | 否               |
| `astro`        | Astro 项目的类型检查     | 否               |

这些键名同时标识检查器、执行工具和相关缓存。这里的声明文件是 Limina 内部构建使用的产物。关于命令的用途，见 [CLI 参考](../cli.md)。

## 自动发现模式 {#auto-模式}

自动发现始终启用，即使你同时配置了具名检查器也是如此。没有其他检查器要求时，普通 TypeScript 项目默认使用 `tsc`。Limina 也会根据项目中的框架配置、实际文件和依赖关系识别 Vue、Astro 或 Svelte 项目。

| 项目中的情况             | 通常使用的检查器 |
| ------------------------ | ---------------- |
| 普通 TypeScript 项目     | `tsc`            |
| 需要 Vue 检查器的项目    | `vue-tsc`        |
| 需要 Astro 检查器的项目  | `astro`          |
| 需要 Svelte 检查器的项目 | `svelte-check`   |

如果希望普通 TypeScript 项目默认使用 `tsgo`，可以单独设置：

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  scope: { checkers: { auto: { useTsgo: true } } },
});
```

`useTsgo` 默认为 `false`。设为 `true` 后，尚未因框架或声明构建关系确定检查器的普通 TypeScript 项目默认使用 `tsgo`。它不会把 Astro 或 Svelte 项目改成 `tsgo`。使用前需要在检查器的执行作用域安装受支持的 `@typescript/native-preview`。

如果只想从自动发现的入口中排除 `packages/playground/tsconfig.json`，则可以单独使用 `exclude`：

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  scope: {
    checkers: {
      auto: { exclude: ['packages/playground/tsconfig.json'] },
    },
  },
});
```

路径和模式相对于 `config.rootDir`。这只排除**自动发现入口**：具名检查器仍可选择该入口，其他已选入口的项目引用也仍可到达它。这不等同于从期望覆盖的源码中排除文件。排除源码文件的方法见[源码边界](./source-boundary.md)。

如果没有其他已选入口覆盖 playground 的源码，`proof:check` 可能报告这些文件未被覆盖。可以为它们选择合适的检查器入口。如果这些文件不应属于本次治理，也可以调整源码范围。调整时还要检查其他已选配置是否仍包含这些文件。

Vue 项目使用了自定义组件扩展时，仅有 `vueCompilerOptions` 提示还不够：Limina 还会检查这些配置实际解析出的文件。只有确实存在匹配的 Vue 文件时，自定义扩展才会促使项目使用 `vue-tsc`。

## 为入口指定检查器 {#named-入口约束与-solution-closure}

如果需要明确指定某个入口，可以使用检查器名称作为键。下面假设 `apps/web` 是已纳入治理的工作区包，且已在检查器执行作用域安装受支持的 `vue-tsc`。以下配置让它的入口使用 `vue-tsc`：

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  scope: {
    source: {
      include: ['...', 'apps/web/**/*.vue'],
    },
    checkers: {
      'vue-tsc': {
        include: ['apps/web/tsconfig.json'],
      },
    },
  },
});
```

`apps/web/tsconfig.json` 会按指定的 `vue-tsc` 处理。其他没有被具名规则选中的入口仍由自动发现处理。如果 Web 入口是聚合配置，这项指定也适用于它引用到的所有终端源码配置。

示例还把 `apps/web` 的 Vue 组件加入 `scope.source`，同时保留默认的 TypeScript 范围。它不会改变 `tsconfig` 的文件列表：负责 Vue 的源码配置仍需包含这些组件。如果检查器包含了组件，但源码范围没有包含，覆盖检查可能报告范围不一致。已有配置时，请合并这两个字段，并按项目实际范围调整匹配模式。

每个具名检查器都使用相同的字段：

| 字段      | 作用                                                      |
| --------- | --------------------------------------------------------- |
| `include` | 必填的非空字符串数组，选择要交给该检查器的入口。          |
| `exclude` | 可选的字符串数组，从该检查器的 `include` 结果中移除入口。 |

例如，`include: ['apps/*/tsconfig.json']` 可以选择多个应用入口，再用 `exclude: ['apps/playground/tsconfig.json']` 将其中一个从该检查器的范围移除。移除后，这个入口仍可能被自动发现或其他具名规则选中。这与 `auto.exclude` 的作用不同。两种排除方式都不会截断已选入口的有效引用。

选择器的路径相对于 `config.rootDir`。它们只直接选择默认名称的 `tsconfig.json`，不能直接选择 `tsconfig.lib.json` 或 `tsconfig.test.json` 等其他名称。后者需要由已选入口通过项目引用纳入。对于已激活的外部包，路径可以使用 `../`。选择器不能激活区域或跨越工作区边界。

同一个直接入口不能同时由两个不同的具名检查器选中。即使入口不同，如果它们最终引用了同一份源码配置，也不能对那份配置指定不同的检查器。出现冲突时，图准备会失败。只配置框架检查器是允许的，无需为了补齐配置而为其他项目指定 `tsc`。

### 聚合配置如何影响选择

有些 `tsconfig.json` 不直接检查源码，只通过 `references` 组织其他配置。本文称它为**聚合配置**，被最终找到并负责源码的配置称为**源码配置**。例如：

```text
apps/web/tsconfig.json          聚合入口
├── tsconfig.app.json           Vue 源码配置
└── tsconfig.node.json          普通 TypeScript 源码配置
```

如果这个入口由自动发现选中，Limina 会分别确定两个源码配置的检查器。假设它们没有需要共享声明构建缓存的依赖，前者可以使用 `vue-tsc`，后者可以使用 `tsc`。它们属于同一个聚合配置，本身不会要求它们使用同一个检查器。

如果你像前面的例子一样，通过 `vue-tsc.include` 显式选择这个聚合入口，则两个源码配置都必须使用 `vue-tsc`。显式选择会约束整个引用链，不会被框架配置、实际文件或自动发现改写。

Limina 会递归展开嵌套的聚合配置，并对重复到达的源码配置去重。默认 `tsconfig.json` 可以直接引用 `tsconfig.node.json` 这样的源码配置。如果引用链中还有一层聚合配置，中间那层也必须叫 `tsconfig.json`，例如 `tsconfig.json → packages/lib/tsconfig.json → packages/lib/tsconfig.lib.json`。声明了引用的命名配置不能充当中间聚合配置。

合法的空聚合配置可以保留，但它没有检查器归属或构建目标。对它运行 `limina checker build <config>` 不会启动检查器。

## 框架前置条件

使用框架检查器前，除了安装 Limina，还需要在对应的执行作用域提供检查器及其依赖。这里的执行作用域是 Limina 查找检查器依赖的包范围。缺少依赖时，可以参考错误信息给出的作用域。版本需要落在 Limina 支持的范围内。安装 Limina 不会替每个框架项目安装这些依赖。

- **Vue：**在 `vue-tsc` 的构建执行作用域安装受支持的 `vue-tsc`。如果遇到工具链兼容问题，参见下方的 [Vue 说明](#vue-语义-import-分析)。
- **Astro：**每个由 Astro 检查器负责的包需要 `astro`、`@astrojs/check` 和 `typescript`，以及事先生成好的 `.astro/types.d.ts`。Limina 运行的是 `astro check --noSync --root <leaf> --tsconfig <source-config>`，不会替项目执行 `astro sync`。如果缺少生成文件，请先在对应的 Astro 项目中运行项目使用的同步步骤。
- **Svelte：**每个由 Svelte 检查器负责的包需要 `svelte-check`、`svelte2tsx`、`svelte` 和 `typescript`。Limina 运行 `svelte-check --workspace <leaf> --tsconfig <source-config>`，不会替项目执行 SvelteKit 同步，也不会启用增量模式、写入 `.svelte-check` 缓存或覆盖输出格式。

`@astrojs/check`、`vue-tsc`、`svelte-check`、`svelte2tsx` 和 `@typescript/native-preview` 都是 Limina 的可选对等依赖。`typescript` 是必需的运行时对等依赖。框架依赖缺失时，Limina 会在启动对应检查器进程前报错。Astro 与 Svelte 的命令和运行时从负责源码配置的包解析。其他外部检查器从目标实际执行的作用域解析。

Astro 和 Svelte 检查器负责类型检查，不生成声明项目。如果某些 TypeScript 源码还需要生成声明，应将这部分源码放入由 `tsc`、`tsgo` 或 `vue-tsc` 负责的独立配置。更多执行方式见[工作流](../workflows.md)。

`limina checker typecheck` 有适用目标且准备成功时，每次都会重新运行 Astro 和 Svelte 检查，不是监听模式。如果没有这两类检查目标，它会记录 `disabled` 并正常退出。这表示没有适用工作，不代表框架检查已经执行。命令在判断是否有目标之前仍会检查工作区并准备生成图，因此这些步骤也可能先报错。

## 框架检查器归属与依赖边界 {#framework-ownership-与-dependency-boundary}

理解检查器归属时，可以把两个问题分开看：

1. **如何理解源码中的导入？** Limina 根据项目的 TypeScript 或框架语义分析依赖。
2. **最终由哪个检查器执行构建或类型检查？** 这还会受到声明构建关系的影响。

例如，一个普通 TypeScript 项目与 Vue 项目需要共享声明构建缓存时，两者可能都由 `vue-tsc` 构建。普通 TypeScript 项目的导入仍按其原本确定的 TypeScript 语义分析。

显式选择 `astro` 时，检查器覆盖 TypeScript 和 `.astro` 文件；`svelte-check` 覆盖 TypeScript 和 `.svelte` 文件；`vue-tsc` 覆盖 TypeScript 和检查器实际识别的 Vue 扩展。选择一种框架检查器不会让它自动覆盖其他框架的文件。若源码位于覆盖证明的源码范围内，但负责该配置的检查器无法处理它，`limina proof check` 会报告 `LIMINA_PROOF_UNCOVERED_SOURCE_FILE`；文件的存在本身不会使 `graph prepare` 直接失败。

::: details 依赖分析遇到不确定情况时

Limina 根据显式选择、配置、实际文件和已确认的框架依赖确定分析语义。语义一旦确定，后续为共享声明缓存而调整构建检查器，不会改变已经确定的导入解释方式。

对于尚未确定框架的项目，Limina 先使用 TypeScript 分析依赖。只有 TypeScript 明确未找到类型证据（`missing`）时，才可能借助 Oxc 寻找实际的框架源码，以辅助判断检查器。普通文件、资源、排除的文件或归属不明确的文件不能据此指定框架。框架要求存在冲突时，Limina 会报错，而不是按导入顺序选择。

确定框架后，依赖解析使用对应框架的工具链。无法可靠解析依赖、确认源码位置或使用工具链时，Limina 会报告失败，不会用近似结果补出项目依赖。框架工具生成但无法唯一对应到用户源码的导入不会凭空创建源码依赖关系。

:::

想进一步了解导入、声明构建和执行顺序之间的关系，可以阅读[从导入解析到声明构建图](../import-resolution-to-declaration-build-graph.md)。

## Astro 语义导入解析 {#astro-语义-import-解析}

Limina 使用 Astro 工具链理解 `.astro` 文件中的导入，再根据真实源码依赖安排其他项目的检查或构建。比如 `A.astro` 导入 `B.vue` 时，`A.astro` 中的导入由 Astro 工具链分析。只有继续分析 `B.vue` 自身时才使用 Vue 工具链。

Astro 检查器不生成声明文件，但跨项目导入仍可能影响执行顺序。生成文件中的导入必须能够可靠对应到用户源码，才能用于建立源码依赖。映射有误、存在歧义或工具链不兼容时，Limina 会停止并报告问题。

Astro 适配器要求以下版本组合：

| 组件                                      | 支持的版本                            |
| ----------------------------------------- | ------------------------------------- |
| Astro                                     | `>=7.0.0 <8.0.0`                      |
| `@astrojs/check`                          | `>=0.9.6 <0.10.0`                     |
| `@astrojs/language-server`                | `2.16.13`                             |
| 语言服务器使用的 `@astrojs/compiler`      | `2.13.1`                              |
| `@volar/language-core`                    | `2.4.28`                              |
| `@volar/kit`                              | `2.4.28`                              |
| `@volar/typescript`                       | `2.4.28`                              |
| 项目和 `@astrojs/check` 可见的 TypeScript | `>=5.4.0 <5.10.0` 或 `>=6.0.0 <6.1.0` |

Astro `7.0.0` 是支持范围的下限，不是唯一支持的版本。Limina 也会检查实际工具链的 API。即使版本号符合表格，导出不兼容时仍会报错。对 `@astrojs/check`，运行时版本判断允许满足范围的预发布版本，例如 `0.9.7-beta.1` 和 `0.10.0-beta.1`。安装时还需满足各依赖包自身的对等依赖要求。

Astro 编译器由 `@astrojs/check` 所使用的语言服务器提供，Limina 不直接依赖它，也不会用工作区根目录或项目中另一份编译器替代。依赖按所属包的作用域解析，不要求所有依赖位于相同的物理路径。不同位置的 TypeScript 版本只要各自在支持范围内即可。

## Vue 语义导入分析 {#vue-语义-import-分析}

Limina 使用项目的 `vue-tsc` 工具链分析 `.vue` 文件中的依赖。由于 Vue 工具链会转换组件中的代码，报告里的导入路径有时可能与源码写法不同。例如，源码写的是 `<script src="./entry.ts">`，报告可能显示 `./entry.js`，但文件和行号仍指向原来的 `.vue` 文件。

Vue 适配器支持以下工具链组合：

| `vue-tsc` 版本系列 | 对应 `@vue/language-core` | `@volar/typescript` | TypeScript           |
| ------------------ | ------------------------- | ------------------- | -------------------- |
| 2.2.0–2.2.12       | 与 `vue-tsc` 版本相同     | 2.4.11–2.4.28       | 5.4.x–5.9.x 或 6.0.x |
| 3.2.0–3.2.4        | 与 `vue-tsc` 版本相同     | 2.4.27              | 5.4.x–5.9.x 或 6.0.x |

`@vue/language-core` 和 `@volar/typescript` 是 `vue-tsc` 的内部工具链依赖，不需要为了 Limina 单独安装。Limina 会检查实际安装的完整组合：

- 遇到 `Missing external checker` 或 `Unsupported external checker`，请检查执行作用域中的 `vue-tsc` 是否存在、版本是否受支持。
- 遇到 `Unsupported vue-tsc toolchain`，请在该作用域升级、降级或重新安装受支持的 `vue-tsc`，以修复不完整或不兼容的内部依赖组合。

Vue 工具链使用的 TypeScript 从 `vue-tsc` 解析，不要求与 Limina 自身使用的 TypeScript 是同一份物理安装。工具链不受支持时，项目的 Vue 依赖分析会失败，不会改用近似解析。独立导入 API 也不能脱离项目上下文处理 `.vue` 文件。

重复脚本块或 `<script setup src>` 等 Vue 单文件组件结构问题由 Vue 检查器和编辑器工具负责。Limina 负责自身依赖分析中的源码位置、解析和图问题。

## Svelte 语义依赖分析 {#svelte-语义-dependency-分析}

Limina 从 Svelte 项目所在包解析 `svelte/compiler`、`svelte2tsx` 和 TypeScript，并使用转换后的 TypeScript 表示分析组件依赖。只有能可靠对应到原始组件源码的依赖才用于建立项目关系。源码映射不完整或不明确时，分析会报错。

这一步不会加载 `svelte.config.js`，也不会运行预处理或默认语言钩子。它只识别显式的 `lang="ts"` 或 `lang="typescript"` 作为转换输入。如果项目依赖其他预处理行为，不应假设这一步会执行它们。Svelte 类型检查命令本身仍按上文所述运行。

## 声明依赖与检查器身份 {#声明依赖与检查器-identity}

当 Limina 确定两个受管项目存在需要共享缓存的声明构建关系时，提供声明的一方需要先于使用它的一方运行，并且两者必须使用相同的构建检查器：`tsc`、`tsgo` 或 `vue-tsc`。这样它们才能共享对应的声明构建缓存。只是消费已有的声明产物，并不一定会形成这样的构建关系，应以 Limina 识别出的关系为准。

例如，如果库项目已经确定使用 `vue-tsc`，而依赖它的项目也需要共享同一声明缓存，Limina 可以让后者使用 `vue-tsc`。但如果两个需要共享缓存的项目被显式指定为不同检查器，`limina graph prepare` 会报错。应检查具名规则和项目间的声明关系，消除冲突，而不是为每个项目机械地指定检查器。

合格的声明依赖、已选定的声明上下文和有效的 `liminaOptions.implicitRefs` 都可能形成这种要求。对于一组需要共享缓存的相连配置：已有一个确定的构建检查器时，Limina 会将它用于整组；尚未确定时，使用 `tsc` 或 `auto.useTsgo` 选定的默认检查器；存在不同的已确定检查器时则报错。聚合关系本身不会产生这种要求。

框架检查或构建之间也可能需要确定先后顺序，但这类**框架调度关系**可以跨检查器，并不会变成 TypeScript 项目引用。只有框架调度关系构成循环时，相关目标会作为一组调度。声明依赖构成循环仍会报错。

## 生成图与生成清单 {#生成图与-manifest}

通常无需手动生成检查器配置：受 Limina 管理的构建、类型检查和流水线会在需要时准备它们。如果需要单独刷新磁盘上的文件，可以在项目中运行 `limina graph prepare`。该命令会生成 `.limina/manifest.json` 和检查器配置。图检查、源码检查与覆盖证明检查只在内存中计算图。

生成清单记录源码配置的检查器归属、聚合配置引用到的源码配置，以及依赖和执行目标。格式错误或不受支持的清单会报错。配置文件和诊断使用项目中的源码配置路径。

生成声明或输出配置时，Limina 保留源码配置实际选中的 `compilerOptions.types`，包括相对路径和继承得到的 `typeRoots`。源码和输出可以使用不同的 `target`，包括由 `vue-tsc` 负责的项目。默认库也可能不同。但输出实际需要的受治理依赖必须已被输出关系覆盖。无法完整分析或发现依赖未被覆盖时，Limina 会报告限制和来源，不会自动扩大源码图或添加源码引用。

明确的项目引用所需的预期声明文件可以在有序构建开始前尚不存在，由后续构建按引用顺序生成，例如通过 `tsc -b`。这不适用于任意缺失的声明文件，也不会使用过期输出代替源码发现。Limina 也不会仅凭一个 `.d.ts` 文件推断生成它的项目、构建工具或任务。额外的产物依赖关系需要明确声明。
