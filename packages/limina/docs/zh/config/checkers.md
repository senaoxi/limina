# 检查器入口

检查器入口用来告诉 Limina：哪些源码 `tsconfig.json` 交给哪个检查器处理。如果没有配置 `config.checkers`，Limina 会使用 auto 模式：自动发现普通 `tsconfig.json`，根据里面的文件选择 `tsc` 或 `vue-tsc`，并把依赖 Vue 项目的 TypeScript 项目一起交给 `vue-tsc`，让首次接入不需要手写路由。

需要使用 `tsgo`、只做类型检查的 checker、更小的 Vue 覆盖范围，或更明确的 include / exclude 规则时，再改用显式 checker 对象。Limina 会从这些入口出发，继续跟随 solution references，并把构建所需的声明图、检查器入口、声明输出目录、tsbuildinfo 和清单写到 `.limina/`。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    // 可选。省略这个字段时会使用默认 auto discovery。
    checkers: {
      typescript: {
        preset: 'tsc',
        include: ['tsconfig.json', 'packages/**/tsconfig.json'],
        exclude: ['**/docs/**'],
      },
      vue: {
        preset: 'vue-tsc',
        include: ['packages/*/docs/tsconfig.json', 'packages/app/tsconfig.json'],
      },
    },
  },
});
```

## auto

- **类型：** `{ mode: 'auto'; exclude?: string[] }`
- **默认值：** 省略 `config.checkers` 时使用

auto 模式会把每个普通 `tsconfig.json` 当作一个源码入口。只包含 TypeScript、JavaScript 和 JSON 的入口会交给 `tsc`；包含 `.vue` 文件的入口会交给 `vue-tsc`。solution-style `tsconfig.json` 会按聚合器处理，Limina 根据它引用到的源码配置判断应该使用哪种能力。

如果 TypeScript 入口 import 到 Vue 入口，auto 模式会把这个 TypeScript 入口也交给 `vue-tsc`。这个提升会沿依赖链继续传播，避免生成的构建图里出现 `tsc` 项目依赖 `vue-tsc` 项目的不兼容关系。

如果自动发现需要跳过某些 tsconfig 作用域，可以写成对象形式：

```js
export default defineConfig({
  config: {
    checkers: {
      mode: 'auto',
      exclude: ['packages/playground/tsconfig.json', '**/tsconfig.test.json'],
    },
  },
});
```

`exclude` 匹配的是相对工作区根目录的 tsconfig 路径。它和 `config.source.exclude` 分开，后者控制的是 proof coverage 里的源码文件边界。没有写 `exclude` 时，auto 模式仍会扫描能发现的每个普通 `tsconfig.json`，以及 solution references 触达的每个普通源码配置。

auto 模式只会在 `tsc` 和 `vue-tsc` 之间选择。需要其他 preset 或更细的拆分时，改用显式 checker 对象。

## Vue Import 解析

- **类型：** `config.imports.vue?: 'heuristic' | 'compiler-sfc'`
- **默认值：** `'heuristic'`

Limina 构建 source graph 时，会从 Vue SFC 的 `<script>` 和 `<script setup>` 中提取 import。默认的 heuristic parser 不需要额外包，普通 inline script import 场景已经够用。

如果希望 Limina 通过 Vue 的 compiler package 解析 SFC block，可以启用：

```js
export default defineConfig({
  config: {
    imports: {
      vue: 'compiler-sfc',
    },
  },
});
```

启用这个模式后，运行 Limina 的工作区需要安装 `@vue/compiler-sfc`。如果缺少这个包，checker preflight 会在启动任何 checker 进程之前失败。

## \<name\>

- **类型：** `config.checkers` 的字符串 key（`Record<string, CheckerConfig>`）

这个 key 是检查器命名空间，例如 `typescript`、`vue` 或 `svelte`。生成文件会放在 `.limina/tsconfig/checkers/<name>/` 下，所以诊断能明确告诉你：哪个检查器生成了配置，哪个检查器又触达了它。

## preset

- **类型：** `'tsc' | 'tsgo' | 'vue-tsc' | 'vue-tsgo' | 'svelte-check'`

`preset` 选择解析器和执行器：

- `tsc`：TypeScript 和 JSON；
- `tsgo`：通过 `@typescript/native-preview` 执行 TypeScript 和 JSON；
- `vue-tsc`：TypeScript、JSON 和 `.vue`；
- `vue-tsgo`：通过 `vue-tsgo` 和 `@typescript/native-preview` 执行 Vue；
- `svelte-check`：Svelte 源码覆盖和第二类 typecheck 执行。

只接受内置 preset。自定义 preset 和自定义 `extensions` 都会被拒绝。

## include

- **类型：** `string[]`
- **必填：** 是

`include` 是非空的、相对工作区根目录的选择器列表，只能选中文件名正好为 `tsconfig.json` 的源码入口。不要让它选中 `tsconfig.lib.json`、`tsconfig.test.json`、`tsconfig.build.json`、`.limina` 里的生成文件、base config、check config 或其他保留 tsconfig。

`limina graph prepare` 会展开 `include` 减去 `exclude`，得到这个 checker 的入口集合。每个入口只能属于一个 checker。之后 Limina 会跟随 solution-style `tsconfig.json` 上的 TypeScript `references`，把被引用到的源码配置也纳入治理。

因此，`tsconfig.lib.json`、`tsconfig.test.json`、`tsconfig.tools.json` 这类非入口配置依然有用，但不要直接写进 `checker.include`。它们只有在被某个已选中的 `tsconfig.json` 入口 reference 到时，才会进入 Limina 的检查范围。单独存在的 base config、build-only config 或工具辅助配置，如果没有从入口可达，Limina 不会把它当成源码检查目标。

对每个进入检查范围的源码配置，Limina 会在 `.limina/tsconfig/checkers/<checker>/projects/...` 下生成声明构建配置。这些配置会 `extends` 源码配置，强制声明 emit 选项，把声明输出写到 `.limina/dts/checkers/<checker>/...`，并记录源码配置和生成配置的对应关系。源码 `tsconfig.json` solution 聚合器会生成到 `.limina/tsconfig/checkers/<checker>/solutions/...` 下。

## 入口唯一性与能力覆盖

`include` 和 `exclude` 计算完成后，不同 checker 的入口集合不能重叠。同一个 `tsconfig.json` 入口不能同时写到 `typescript` 和 `vue` 下面，即使 preset 不同也不行。你需要先选定：这个入口由哪个 checker 负责。

这不表示被 reference 展开后的源码配置只能有一种能力。入口展开之后，不同 preset 可以共同覆盖同一个源码配置。这可以用来给同一份源码叠加能力，例如某个源码配置既在 TypeScript 图里，又需要 Vue 能力。Limina 真正拒绝的是更窄的情况：两个相同 preset 的 checker 同时管到同一个展开后的源码配置。

Limina 还会在展开后检查文件能力。如果某个源码配置包含 `.vue` 文件，却只被 `tsc` 或 `tsgo` 覆盖，graph prepare 会失败，并提示需要能处理这个扩展名的 checker。修复方式是加一个能到达该配置的匹配 checker 入口，或者把这些文件移到合适 checker 管辖的配置里。

## 跨 Checker 可达性

源码 import 可以跨 checker 边界。例如，一个纯 TypeScript 入口可能 import 到由 Vue checker 负责的项目。Limina 会记录这条依赖关系，让构建类 checker 执行时先构建被依赖的一侧。

如果多个构建类 preset 能触达同一个生成的声明构建配置，并且它们的底层 build cache 语义不适合共享，Limina 会在构建结束后打印 warning：

```text
Potentially incompatible build checker combination:
  generated config: ...
  source config: packages/core/tsconfig.lib.json
  reachable from:
    - config.checkers.typescript (tsgo)
      entry tsconfigs:
        - packages/app/tsconfig.json
    - config.checkers.vue (vue-tsc)
      entry tsconfigs:
        - packages/theme/tsconfig.json
```

可以把 `reachable from` 当成可达性地图看。它告诉你：同一个生成配置会被哪些 checker、哪些入口 `tsconfig.json` 触达。想消掉 warning，就要让这片可达区域使用 cache 兼容的构建 preset。同 preset 组合没问题，`tsc` 和 `vue-tsc` 也视为兼容；`tsgo` 和 `tsc`、`tsgo` 和 `vue-tsc` 这类组合会提示，因为它们不能安全共享同一套底层 build cache。

## exclude

- **类型：** `string[]`
- **默认值：** `[]`

`exclude` 从 `include` 结果里排除入口匹配项，用来让入口归属更清楚：

```js
exclude: ['**/docs/**', 'packages/playground/tsconfig.json'];
```

## 生成图

运行 `limina graph prepare` 会生成 `.limina/manifest.json` 和检查器作用域内的 tsconfig 图。消费图的命令也会在运行前自动 prepare。

用户配置和诊断中的规范路径是源码 tsconfig 路径。`.limina/tsconfig/checkers/.../*.dts.json` 是内部生成路径，不需要写进用户配置。
