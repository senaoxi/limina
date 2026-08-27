# 检查器配置

`config.checkers` 选择 active default `tsconfig.json` 入口。Limina 随后为完整 references closure 中的每个 managed type config 分配恰好一个 checker owner。检查器名称是固定 identity：

| key            | 执行方式                         | 生成声明 |
| -------------- | -------------------------------- | -------- |
| `tsc`          | 生成 TypeScript build target     | 是       |
| `tsgo`         | 生成 native TypeScript target    | 是       |
| `vue-tsc`      | 生成 Vue/TypeScript build target | 是       |
| `svelte-check` | 按 leaf 执行 framework typecheck | 否       |
| `astro`        | 按 leaf 执行 framework typecheck | 否       |

key 本身就是检查器 identity，不再有 `preset` 字段，也不再支持自定义检查器 alias。这样，源码归属、生成路径、执行工具和缓存行为只使用同一个名字。

`vue-tsc`、`svelte-check` 与 `@typescript/native-preview` 是 optional external-checker peer。它们的 peer range 表达 Limina 支持的 checker 版本，每个 checker 都从其 target 实际执行的 scope 解析。`svelte2tsx` 是独立的 optional checker-toolchain peer：请在每个 Svelte leaf 中与 `svelte-check` 一并安装；Limina 不会把它作为 production dependency 发布。`typescript` 仍是 Limina 必需的 runtime peer，从运行 Limina 的 workspace 安装环境解析。

Auto discovery 始终启用。Named scope 先接管命中的入口；未被 named scope 接管的入口仍然自动分析：

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

每个 named `include` 都必须是非空数组，`exclude` 可省略。只配置 framework checker 也合法。同一个入口不能同时匹配两个 named checker scope。

## Auto 模式

- **类型：** `{ exclude?: string[]; useTsgo?: boolean }`
- **默认值：** 无论是否存在 named scope 都启用

默认情况下，普通 TypeScript fallback 由 `tsc` 负责；framework evidence 会在 fallback 前解析出对应 framework owner：

```text
普通 TypeScript -> tsc
Vue             -> vue-tsc
Astro           -> astro
Svelte          -> svelte-check
```

设置 `useTsgo: true` 后，只有普通 TypeScript fallback 改由 `tsgo` 负责，framework ownership 不变。

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

`useTsgo` 只改变 framework analysis 后仍未染色的 build component 的 fallback。在生成 checker 路径之前，Limina 会合并必须共享声明缓存的 build-capable leaf：同一 solution 的 leaf，以及被有效源码 import 或 `liminaOptions.implicitRefs` 连接的 config。component 中只有一个已知 `tsc`、`tsgo` 或 `vue-tsc` identity 时，它会染色整个 component；没有颜色时使用 fallback；存在两个不同 identity 时 graph prepare 失败。

Vue 能力由检查器实际解析出的文件集合确认，不能只看 `vueCompilerOptions`。Limina 会先遍历入口、solution、被引用 leaf 和有效 `extends`，再让 Vue parser 解析真实扩展名和文件。只有确实存在匹配文件时，自定义 Vue 扩展才会切到 `vue-tsc`；只有配置提示而没有实际模块时，不会改变归属。

Auto `exclude` 只过滤已激活[治理区域](./regions.md)中的入口选择，不会裁剪从已选入口到达的有效 project reference，也不同于控制源码覆盖的 `config.source.exclude`。

旧 `{ mode: 'auto' }` 结构会被拒绝。请把 `exclude` 与 `useTsgo` 移到 `auto` 下。

## Named 入口约束与 solution closure

所有 named checker scope 使用同一个结构：

```ts
interface CheckerScope {
  include: string[];
  exclude?: string[];
}
```

`include` 只选择相对 `config.rootDir` 的直接 default `tsconfig.json` 入口，不能直接选择 `tsconfig.lib.json`、`tsconfig.test.json` 或其他 named config；这些 config 只能通过 managed references closure 进入。外部激活包可以使用 `../`，但 selector 不能把未激活路径或工作区边界后的路径拉入图中。`exclude` 在 include 之后移除直接入口，不会截断正常的 project-reference closure。

Limina 区分 solution config 与 terminal type config。Solution 只组织 references，本身不是 Astro、Svelte 或 Vue execution target。Limina 会递归展开 nested solution，用规范化路径对 terminal type config 去重，并对每个 leaf 执行一次选定 checker。

Named checker 对完整 terminal-leaf closure 具有权威性。Config hint、effective root file、dependency requirement 与 Vue promotion 都不会改写这个域。相同 checker 的 overlapping named scope 会合并 evidence；不同 checker identity 覆盖同一 terminal leaf 时 graph prepare 失败。

Default solution 可以直接引用 named terminal config，例如 `tsconfig.json -> tsconfig.node.json`。Nested solution 自身必须使用默认名称，例如 `tsconfig.json -> packages/lib/tsconfig.json -> packages/lib/tsconfig.lib.json`。声明 references 的 named config 不能作为中间 solution。

`tsconfig.lib.json`、`tsconfig.test.json` 等非入口配置，只有被已选 `tsconfig.json` 入口引用时才会进入治理图。生成配置都位于 Limina 的 `.limina` namespace；用户配置和诊断继续使用源码配置路径。

## Framework ownership 与 dependency boundary

Limina 为每个 project 记录两个回答不同问题的 identity：

- **Semantic authority** 决定使用哪一种 checker-compatible module semantics 解释 project dependency。
- **Final owner** 决定由哪个 checker 执行 build 或 typecheck target。

只有显式 checker selection、checker-specific config evidence、effective root-file evidence，以及已确认的 pending framework dependency 可以锁定 semantic authority。Limina 收集完 pending dependency requirement 后会冻结该 authority。Vue promotion、solution constraint、declaration-component coloring、TypeScript fallback 与 `finalOwner` 可以选择或传播 build owner，但不能重新解释 project dependency。因此，TypeScript-semantic project 可以在 build coloring 后由 `vue-tsc` 构建，同时继续使用 TypeScript module semantics。

仍处于 pending 的自动 scope 以 TypeScript 作为中立语义基线。Limina 从已解析的 TypeScript project 及其 TypeScript AST 枚举 dependency，再对每条 source-authored dependency 执行 checker type-evidence gate。`ambient`、`concrete-declaration` 与 `checker-source` evidence 都停在 TypeScript boundary；不受支持的 semantic evidence 会 fail closed。只有 `missing` evidence 可以调用 Oxc，而且 Oxc 在这里仅用于为 ownership inference 识别物理 framework-source candidate。Candidate 必须是恰好一个 governed config 的 effective member，并且只属于一个 framework semantic domain。普通 TypeScript file、resource、excluded file 与 ambiguous target 都不能给 checker 染色。Limina 会先收集完整 requirement set，再解析 pending owner，因此 Astro/Svelte/Vue 冲突是确定性的，不受 import 顺序影响。

Semantic authority 一旦锁定，所有 project-aware consumer 都使用对应的 TypeScript、Vue、Astro 或 Svelte semantic provider。Checker-semantic miss 的最终结果仍是 missing；toolchain、materialization、source-map、ambiguity 与 resolution-host failure 都会 fail closed。Locked project dependency resolution 不会把 Oxc 或轻量 collector 当作 fallback。

`SourceEvidence` 继续提供 source-only syntax、diagnostic 与源码坐标，但不是 graph 或 checker authority。Architecture consumer 只接受具有 `direct-source` 或严格 `mapped-source` provenance 的 source-authored `ProjectDependency`。无法唯一映射到源码 dependency 的 generated dependency 只能成为 observation，绝不会创建 source-derived edge；ambiguous reverse mapping 会直接报错。

显式 Astro owner 观测 TypeScript 文件与 `.astro`；显式 Svelte owner 观测 TypeScript 文件与 `.svelte`；显式 `vue-tsc` owner 观测 TypeScript 与 checker 实际解析出的 Vue 扩展。一个 framework 名称不会顺带加入其他 framework 扩展。位于 proof source boundary 内、但 final owner 无法观测的文件，不会仅因存在就阻断 graph prepare；`proof check` 会以 `LIMINA_PROOF_UNCOVERED_SOURCE_FILE` 报告。

Astro/Svelte owner 不生成 declaration project、wrapper 或 transparent build solution。`checker:typecheck` 会对其完整 type config 按 leaf 执行一次。需要 emit declaration 的 TypeScript 必须拆到独立 `tsc`、`tsgo` 或 `vue-tsc` config。

如果 `checker:typecheck` 没有 framework-owned leaf，它会被记录为 `disabled`，正常退出，不运行 peer preflight，也不物化生成的 checker artifact。

### 框架前置条件

框架 checker 命令及其执行 runtime 都从拥有源码配置的叶子包解析：

- Astro 需要 `astro`、`@astrojs/check` 和 `typescript`，以及叶子包已生成的 `.astro/types.d.ts`。Limina 执行 `astro check --noSync --root <leaf> --tsconfig <source-config>`，不会运行 `astro sync`。
- Svelte 需要 `svelte-check`、`svelte2tsx`、`svelte` 和 `typescript`。Limina 执行 `svelte-check --workspace <leaf> --tsconfig <source-config>`，不会运行 SvelteKit sync、启用增量模式、写入 `.svelte-check` cache 或覆盖输出格式。

`@astrojs/check` 是 Limina 的可选 peer dependency。请在每个由 Astro 拥有的 leaf 中主动安装受支持版本；安装 Limina 不会替该 leaf 安装它。

Framework dependency 收集使用所属 checker 生成的 TypeScript representation。Astro 只从已安装的 `@astrojs/check` → `@astrojs/language-server` toolchain 解析 compiler；Limina 不再直接依赖或 peer `@astrojs/compiler`，也不会回退到 workspace 安装，leaf 中竞争性的 compiler 无法 shadow Language Server 所属实例。Svelte semantic analysis 从所属 leaf 解析公共 `svelte/compiler`、`svelte2tsx` 与 TypeScript。框架 checker 依赖缺失时，预检仍会在启动检查器进程前失败。

`checker typecheck` 是完整重跑，不是框架 watch 模式。稳定 target ID 只表示多次运行之间的 target identity 稳定，不提供增量失效能力。

## Astro 语义 import 解析

对于 locked Astro project，Limina 从官方 Astro/Volar context 物化 primary 与 extra TypeScript service script，并使用该 toolchain 的 TypeScript 实例枚举 dependency。每条 generated dependency 必须先严格反向映射到唯一用户源码范围，随后才由 Astro decorated TypeScript host 解析。这里不再存在 standalone Astro collector 或 source-first resolution 往返。

只有严格 source mapping 才能形成 mapped dependency。Limina 先尝试完整 generated literal token；只有该严格查询没有结果时才尝试 inner content，两次查询都不允许 fallback match。Generated synthetic import 即使解析到 governed workspace source，也只能成为 `unmapped-generated` observation，绝不会创建 graph edge。损坏、歧义或相互冲突的 mapping、toolchain 不兼容、service-script failure 与 resolution-host failure 都会 fail closed。Locked 路径不会调用 Oxc 或 workspace TypeScript export fallback。

首个 adapter family 有明确边界：

| 组件                                     | 支持契约                              |
| ---------------------------------------- | ------------------------------------- |
| Astro                                    | `>=7.0.0 <8.0.0`                      |
| `@astrojs/check`                         | `0.9.10`                              |
| `@astrojs/language-server`               | `2.16.13`                             |
| LS-owned `@astrojs/compiler`             | `2.13.1`                              |
| `@volar/language-core`                   | `2.4.28`                              |
| `@volar/kit`                             | `2.4.28`                              |
| `@volar/typescript`                      | `2.4.28`                              |
| leaf-visible 与 check-visible TypeScript | Limina 已声明的 TypeScript peer range |

TypeScript peer range 是 `>=5.4.0 <5.10.0 || >=6.0.0 <6.1.0`。Astro `7.0.0` 是受支持的 floor，不是唯一可接受版本。adapter 还会检查 internal API shape，因此版本字符串匹配但 exports 不兼容时仍然 fail closed。

依赖解析遵循 package ownership。Limina 依次从所属 leaf、`@astrojs/check`、Language Server、`@volar/kit` 创建解析 scope。依赖必须由拥有它的 scope 声明；owner-scoped 解析失败后不会改从 workspace root 重试。resolved file 可以位于 pnpm store、hoisted directory 或其他 symlink layout。路径只记录为 provenance，并用于隔离不同 module instance；物理路径相等永远不是兼容条件。因此，两份受支持的 TypeScript 可以来自不同 realpath，甚至可以是范围内不同版本。

Semantic provider 只确认 source-authored dependency 与 target；源码 ownership、provider 选择、scheduling 与 graph policy 仍由 Limina 决定：

| Astro 源码 target | 图策略                                                            |
| ----------------- | ----------------------------------------------------------------- |
| `.astro`          | framework scheduling                                              |
| `.svelte`         | framework scheduling                                              |
| `.vue`            | Astro 确认物理 target，再记录到 Vue owner 的 framework scheduling |
| `.ts` / `.tsx`    | 到 target build owner 的 framework scheduling                     |

对于 `A.astro -> B.vue -> C.ts`，`A -> B` 始终由 Astro pipeline 负责。只有独立分析 `B.vue` 源码时才使用 Vue semantic resolution，因此 Vue 不会重新解释写在 `A.astro` 中的 import。`.astro` 与 `.svelte` 仍不会进入生成声明的 `files`；它们真实的跨 owner import 仍可形成 framework scheduling，而 declaration-provider edge 始终位于同一个 build-checker identity 内。

## Vue 语义 import 分析

Vue import 收集不再提供配置字段。Standalone import API 不接受 framework 文件：`.vue` dependency semantics 必须使用 project-aware `vue-tsc` context。Source profile 只作为 adapter-local 输入来选择官方 service-script representation，不形成第二套 dependency authority。

对于 locked Vue-semantic project，Limina 先从 checker execution scope 解析 `vue-tsc`，再从这份已安装 `vue-tsc` 的依赖环境解析 Vue Language Core、Volar TypeScript 和 toolchain 使用的 TypeScript。它会物化 Vue service script，端到端使用同一 toolchain TypeScript 枚举 generated dependency，严格反投影每条 dependency，再通过 Volar-aware host 解析 generated semantic literal。语义身份由 generated `semanticSpecifier`、resolution mode、checker target、resolver、kind 与 canonical type evidence 构成；源码 spelling 不再是第二套 authority。因此源码 `<script src="./entry.ts">` 的 `ImportRecord.specifier` 与报告中的 `importedSpecifier` 可能显示为 `./entry.js`，但文件与行号仍指向 `.vue` 源码。Synthetic service-script import 只能成为 observation，绝不会形成 graph edge，也不会由 Oxc 或 workspace resolver rescue。TypeScript-only source directive 保留有界 direct-source TypeScript semantics。

支持的 adapter matrix 有明确边界：

| `vue-tsc` family | 对应 `@vue/language-core` | `@volar/typescript` | TypeScript           |
| ---------------- | ------------------------- | ------------------- | -------------------- |
| 2.2.0–2.2.12     | 与 `vue-tsc` 版本相同     | 2.4.11–2.4.28       | 5.4.x–5.9.x 或 6.0.x |
| 3.2.0–3.2.4      | 与 `vue-tsc` 版本相同     | 2.4.27              | 5.4.x–5.9.x 或 6.0.x |

发布包只将 `vue-tsc` 声明为 Vue optional checker peer。`@vue/language-core` 与 `@volar/typescript` 是 checker 内部 toolchain package：应用无需为 Limina 安装它们，Limina 也不再将它们发布为 peer。`vue-tsc` peer range 表达受支持的 external checker 版本；Limina 仍按上表校验实际安装的完整 tuple。顶层 checker 缺失或版本越界时分别报告 `Missing external checker` 或 `Unsupported external checker`；内部 tuple 不完整或不兼容时报告 `Unsupported vue-tsc toolchain`，修复方式是在对应 checker scope 升级、降级或重装 `vue-tsc`，而不是直接安装内部 package。

该 Vue tuple 使用的 TypeScript 属于 checker-toolchain 角色，通过 `vue-tsc` 解析；它不要求与 Limina 自身必需的 TypeScript runtime 是同一个物理安装。

不受支持的 tuple 会使 project-aware Vue dependency preparation fail closed。Standalone API 不会回退到 lightweight Vue collector 或近似的 Vue extension resolver。

## Svelte 语义 dependency 分析

对于 locked Svelte project，Limina 从所属 leaf 解析公共 `svelte/compiler`、受支持的公共 `svelte2tsx` peer 与 TypeScript。Adapter 把原始 component 转成 generated TSX 与 Source Map v3 map；Limina 不会为非 Svelte consumer 打包或安装这个 Svelte-only adapter。Dependency 由同一 TypeScript 实例枚举。只有 decoded segments 显式覆盖 generated dependency 范围内每个 UTF-16 offset，并且单调、连续地映射到当前 source 时，provenance 才成立；sparse、partial、unmapped、cross-source、倒退或跳跃的 range 会 fail closed，不会继承 greatest-lower-bound segment。

这条有界路径不会加载 `svelte.config.js`，不会执行 preprocess/default-language hook，不会导入 `svelte-check` 或 Language Server private subpath，也不会复刻 snapshot 与 Language Service lifecycle。它只用极小的显式 `lang="ts"`/`lang="typescript"` detector 给公共 `svelte2tsx.isTsFile` 提供输入；dependency graph policy 不区分 instance 与 module script。Bounded Program overlay 只能为已枚举 literal 查询 ambient TypeChecker evidence，不能成为第二套 `.svelte` module resolver。Generated synthetic dependency 只能成为 observation，locked Svelte resolution 永不回退到 Oxc。

对所有 locked framework，preparation 会同时记录 checker target 与现有 `TypeEvidence`。受管源码 target 形成 project dependency，concrete declaration 停在 declaration boundary，`target = null` 且具有 ambient evidence 时形成 typed non-source observation，`target = null` 且 evidence 为 missing 时保持 genuine missing。文件是否存在、resource 扩展名、virtual-module allowlist、workspace export resolution 与 Oxc 都不能把 checker miss 变成新 target。

### 从 `config.imports.vue` 迁移的 breaking change

删除 `config.imports.vue`，不需要添加替代字段。仍包含 `config.imports` 的配置会在加载时直接报告这项迁移。公共 `VueImportParser` 类型以及 Limina 对 `@vue/compiler-sfc` 的直接/可选依赖也已删除。

Limina 不再提供 compiler-sfc 专属的 duplicate script block 或 `<script setup src>` 结构诊断；SFC 是否有效由 Vue checker 与 editor tooling 负责。Limina 只在自身分析边界内报告源码 provenance、resolution 与 graph failure。

## 声明依赖与检查器 identity

Limina 会区分声明依赖和框架调度依赖：

- `declaration-provider` 表示真实的编译器声明关系，可以成为生成的 TypeScript project reference。
- `framework-schedule` 只用于排列框架检查或构建顺序，绝不会写成生成的 `tsconfig` reference。

provider 会先于 consumer 运行。纯 framework-scheduling cycle 会作为一个调度 component 执行；declaration cycle 仍然失败。

每条成功生成的 `declaration-provider` edge 两端都具有完全相同的 `tsc`、`tsgo` 或 `vue-tsc` identity，并在 manifest version 5 中记录 `cacheReuse: "reusable"`。因此 canonical declaration relation 会在生成 config 与 target 物化前染色整个 build component。component 已包含不同 build identity 时，graph prepare 会失败，不再保留跨 checker reference，也不再发出 cache-churn warning。`framework-schedule` 不是 compiler project reference，因此仍可跨 checker identity。

## 从 alias 与 `preset` 迁移

把旧 entry 移到与其 `preset` 同名的固定 key，再删除 `preset`：

```js
// before
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

// after
checkers: {
  tsgo: {
    include: ['packages/**/tsconfig.json'],
  },
  'vue-tsc': {
    include: ['apps/web/tsconfig.json'],
  },
}
```

如果多个 alias 以前使用同一个 `preset`，需要把不重叠的 selector 合并到一个固定 key。selector 重叠或策略冲突时，请显式决定如何处理；Limina 不会猜测哪个 alias 优先。配置文件是 TypeScript/MTS，因此 Limina 会给出确定的 schema diagnostic，但不会自动改写。

## 生成图与 manifest

运行 `limina graph prepare` 会物化 `.limina/manifest.json` 和生成的检查器配置。managed build/typecheck 命令与流水线会按需物化；只读的 graph、source 和 proof check 只在内存中计算图。

当前 manifest 为 version 5。它同时持久化 ownership plan（config role、final owner 与 solution leaf closure）、稳定排序的 typed `dependencyEdges`，以及 build/framework execution targets。Version 1 到 4 只作为旧生成产物的归属 ledger，用于安全清理后写入 version 5。未来版本或格式错误的 manifest 会 fail closed。
