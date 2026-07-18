# 检查器入口

检查器入口用来告诉 Limina：哪些源码 `tsconfig.json` 交给哪个检查器处理。入口发现只会发生在已激活的[治理区域](./regions.md)内。如果没有配置 `config.checkers`，Limina 会使用 `auto` 模式：在这些区域中自动发现普通 `tsconfig.json`，根据里面的文件选择 `tsc` 或 `vue-tsc`，并把依赖 `Vue` 项目的 `TypeScript` 项目一起交给 `vue-tsc`，让首次接入不需要手写路由。

需要使用 `tsgo`、只做类型检查的检查器、更小的 `Vue` 覆盖范围，或更明确的 `include` / `exclude` 规则时，再改用显式检查器对象。Limina 会从这些入口出发，继续跟随聚合配置里的 `references`，并把构建所需的声明图、检查器入口、声明输出目录、`.tsbuildinfo` 和清单写到 `.limina/`。

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

`auto` 模式会在每个激活 package island 中独立发现普通 `tsconfig.json`，包括外部激活包。只包含 `TypeScript`、`JavaScript` 和 `JSON` 的入口会交给 `tsc`；包含 `.vue` 文件的入口会交给 `vue-tsc`。`solution-style tsconfig.json` 会按聚合器处理，Limina 根据它引用到的源码配置判断应该使用哪种能力。父级发现不会穿过激活子包根目录或 owner-local 嵌套工作区边界；激活子包会启动自己的发现任务。

如果 `TypeScript` 入口 `import` 到 `Vue` 入口，`auto` 模式会把这个 `TypeScript` 入口也交给 `vue-tsc`。这个提升会沿依赖链继续传播，避免生成的构建图里出现 `tsc` 项目依赖 `vue-tsc` 项目的不兼容关系。

如果自动发现需要跳过某些 `tsconfig` 作用域，可以写成对象形式：

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

`exclude` 过滤的是已激活区域内的入口路径。它和 `config.source.exclude` 分开，后者控制的是覆盖证明里的源码文件边界。入口选定后，Limina 会独立跟随聚合器的 `references`；`exclude` 只用来移除入口，不能用来隐藏被引用的源码配置。

`auto` 模式只会在 `tsc` 和 `vue-tsc` 之间选择。需要其他预设或更细的拆分时，改用显式检查器对象。

## Vue import 解析

- **类型：** `config.imports.vue?: 'heuristic' | 'compiler-sfc'`
- **默认值：** `'heuristic'`

Limina 构建源码图时，会从 `Vue SFC` 的 `<script>` 和 `<script setup>` 中提取 `import`。默认的启发式解析器不需要额外包，普通内联 `script import` 场景已经够用。

如果希望 Limina 通过 `Vue` 的编译器包解析 `SFC` 块，可以启用：

```js
export default defineConfig({
  config: {
    imports: {
      vue: 'compiler-sfc',
    },
  },
});
```

启用这个模式后，运行 Limina 的工作区需要安装 `@vue/compiler-sfc`。如果缺少这个包，检查器预检会在启动任何检查器进程之前失败。

## \<name\>

- **类型：** `config.checkers` 的字符串 `key`（`Record<string, CheckerConfig>`）

这个 `key` 是检查器命名空间，例如 `typescript`、`vue` 或 `svelte`。生成文件会放在 `.limina/tsconfig/checkers/<name>/` 下，所以诊断能明确告诉你：哪个检查器生成了配置，哪个检查器又触达了它。

## preset

- **类型：** `'tsc' | 'tsgo' | 'vue-tsc' | 'vue-tsgo' | 'svelte-check'`

`preset` 选择解析器和执行器：

- `tsc`：`TypeScript` 和 `JSON`；
- `tsgo`：通过 `@typescript/native-preview` 执行 `TypeScript` 和 `JSON`；
- `vue-tsc`：`TypeScript`、`JSON` 和 `.vue`；
- `vue-tsgo`：通过 `vue-tsgo` 和 `@typescript/native-preview` 执行 `Vue`；
- `svelte-check`：`Svelte` 源码覆盖和第二类类型检查执行。

只接受内置预设。自定义预设和自定义 `extensions` 都会被拒绝。

## include

- **类型：** `string[]`
- **必填：** 是

`include` 是非空的、相对 `config.rootDir` 的选择器列表，只能选中文件名正好为 `tsconfig.json` 的源码入口。外部激活包可以使用 `../`。selector 只过滤激活 package island 已经产生的 candidate，不能把未激活路径或 owner-local 边界后的 descriptor 拉入图中。不要让它选中 `tsconfig.lib.json`、`tsconfig.test.json`、`tsconfig.build.json`、`.limina` 里的生成文件、基础配置、检查配置或其他保留 `tsconfig`。

`limina graph prepare` 使用下面的模型：

```text
included entries = 已激活区域内匹配 include 的入口
effective entries = included entries 减去 exclude
```

如果一个 `include` 匹配项不属于任何已激活工作区包，或者位于已排除、不可访问的区域边界之下，它就不会进入 included entries。每个 effective entry 只能属于一个检查器。之后 Limina 会跟随 `solution-style tsconfig.json` 上的 `TypeScript references`，把存在的普通源码配置纳入治理。引用越过已激活区域时会报告跨区域错误；`exclude` 不会屏蔽这条引用。

因此，`tsconfig.lib.json`、`tsconfig.test.json`、`tsconfig.tools.json` 这类非入口配置依然有用，但不要直接写进 `checker.include`。它们只有在被某个已选中的 `tsconfig.json` 入口 `reference` 到时，才会进入 Limina 的检查范围。单独存在的基础配置、仅构建配置或工具辅助配置，如果没有从入口可达，Limina 不会把它当成源码检查目标。

对每个进入检查范围的源码配置，Limina 都会在受信任的 `.limina` namespace 内生成声明构建配置。内部包保留可读的 checker/project 布局；外部包会映射到内部 `external/<stable-id>/...` namespace，不会把 `../` 嵌入生成路径。这些配置会 `extends` 源码配置，强制声明输出选项，把声明输出写到同一个受信任 namespace，并记录源码配置和生成配置的对应关系。

## 入口唯一性与能力覆盖

`include` 和 `exclude` 计算完成后，不同检查器的入口集合不能重叠。同一个 `tsconfig.json` 入口不能同时写到 `typescript` 和 `vue` 下面，即使预设不同也不行。你需要先选定：这个入口由哪个检查器负责。

这不表示被 `reference` 展开后的源码配置只能有一种能力。入口展开之后，不同预设可以共同覆盖同一个源码配置。这可以用来给同一份源码叠加能力，例如某个源码配置既在 `TypeScript` 图里，又需要 `Vue` 能力。Limina 真正拒绝的是更窄的情况：两个相同预设的检查器同时管到同一个展开后的源码配置。

Limina 还会在展开后检查文件能力。如果某个源码配置包含 `.vue` 文件，却只被 `tsc` 或 `tsgo` 覆盖，`graph prepare` 会失败，并提示需要能处理这个扩展名的检查器。修复方式是加一个能到达该配置的匹配检查器入口，或者把这些文件移到合适检查器管辖的配置里。

## 跨检查器可达性

源码 `import` 可以跨检查器边界。例如，一个纯 `TypeScript` 入口可能 `import` 到由 `Vue` 检查器负责的项目。Limina 会记录这条依赖关系，让构建类检查器执行时先构建被依赖的一侧。

如果多个构建类预设能触达同一个生成的声明构建配置，并且它们的底层构建缓存语义不适合共享，Limina 会在构建结束后打印警告：

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

可以把 `reachable from` 当成可达性地图看。它告诉你：同一个生成配置会被哪些检查器、哪些入口 `tsconfig.json` 触达。想消掉警告，就要让这片可达区域使用缓存兼容的构建预设。同预设组合没问题，`tsc` 和 `vue-tsc` 也视为兼容；`tsgo` 和 `tsc`、`tsgo` 和 `vue-tsc` 这类组合会提示，因为它们不能安全共享同一套底层构建缓存。

## exclude

- **类型：** `string[]`
- **默认值：** `[]`

`exclude` 从 included entries 中排除入口匹配项。它适合处理仍位于已激活区域内的个别入口：

```js
exclude: ['**/docs/**', 'packages/playground/tsconfig.json'];
```

模式列表保留 tinyglobby 的 pattern-list 语义：入口至少匹配一个 positive pattern，并且不匹配任何 negative pattern 时，才会被排除。negative pattern 会从整个 excluded set 中减去匹配项；只有 negative pattern 的列表不会排除任何入口，数组顺序也不会重新包含路径。

前导 `!` 按以下规则分类：

- 没有前导 `!` 的模式，以及以 `!(` 开头的 extglob，属于 positive pattern；
- 单个前导 `!` 会被移除，剩余部分成为 negative pattern；`!!(...)` 也按这条规则处理，因为第二个 `!` 开始了 extglob；
- `!!path`、`!!!path` 等其他双叹号或三叹号形式会被忽略。

absolute、parent-relative、directory expansion、trailing slash、escaped metacharacter、dot path、brace、extglob、globstar 和大小写行为都保持 tinyglobby 兼容。公共 selector 从 `config.rootDir` 解释，最终路径仍必须落在已验证的激活包索引内。

不要在这里重复整个区域的排除。被排除或不可访问区域中的路径按定义已经不参与 `include` 发现。也不要用 `exclude` 阻止 `references`：effective entry 选定后，即使引用路径匹配 exclude pattern，Limina 仍会继续跟随有效引用。

## 生成图

运行 `limina graph prepare` 会显式物化 `.limina/manifest.json` 和检查器作用域内的 `tsconfig` 图。managed `limina build`、`checker build`、`checker typecheck`，以及包含检查器任务或 `graph:prepare` 的 `check` 流水线，也会按需物化相同文件。`graph check`、`source check`、`proof check` 只在内存中计算生成图，不会因为读取图事实就写出检查器配置。

用户配置和诊断中的规范路径是源码 `tsconfig` 路径。`.limina/tsconfig/checkers/.../*.dts.json` 是内部生成路径，不需要写进用户配置。
