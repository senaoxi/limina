# Checker entries

Checker entries 会被 graph、source、proof 和 checker commands 共同使用。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: 'tsconfig.build.json',
      },
      vue: {
        preset: 'vue-tsc',
        entry: 'tsconfig.vue.build.json',
      },
      svelte: {
        preset: 'svelte-check',
        entry: 'tsconfig.svelte.build.json',
      },
    },
  },
});
```

## `<name>`

`checkers` 的 key 是这组 checker 的名字，例如 `typescript`、`vue` 或 `svelte`。它会出现在报告和调试信息里，用来区分是哪一类源码入口出了问题。

同一个 workspace 可以同时有多个 checker entry。普通 TypeScript 图可以用 `typescript`，Vue app 可以额外用 `vue`，Svelte package 可以额外用 `svelte`。

## `preset`

`preset` 决定 Limina 调用哪个 checker runner：

- `tsc`：处理 TypeScript 和 JSON；
- `tsgo`：通过 `@typescript/native-preview` 处理 TypeScript 和 JSON；
- `vue-tsc`：处理 `.vue`；
- `vue-tsgo`：通过 `vue-tsgo` 和 `@typescript/native-preview` 处理 `.vue`；
- `svelte-check`：处理 `.svelte`。

Limina 只接受内置 preset。`tsc`、`tsgo` 和 `vue-tsc` 支持 build execution，所以是一等公民；`vue-tsgo` 和 `svelte-check` 只支持直接 typecheck execution，所以是二等公民。`vue-tsgo` 仍具备 Limina source graph 能力，`svelte-check` 则不参与 source graph。

`tsgo` 使用 Microsoft 的预览包 `@typescript/native-preview`，执行 `tsgo -b <entry> --pretty false`。当你希望 Limina 的 build checker 试跑 native TypeScript preview，同时保持和 `tsc` 相同的 source graph 模型时，可以使用它。

```js
export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsgo',
        entry: 'tsconfig.build.json',
      },
    },
  },
});
```

`vue-tsgo` 使用 KazariEX 的 `vue-tsgo` 包和 `@typescript/native-preview`，并通过 `limina checker typecheck` 执行 `vue-tsgo --project <entry>`。Limina 会有意把它作为二等公民 execution checker：当前 `vue-tsgo --build` 会把源码 import 展开到临时虚拟 TS workspace，不能保持 TypeScript project-reference 边界，也不具备增量构建语义。Limina 仍会使用已配置的 `vue-tsgo` tsconfig entry 做自己的 graph 和 proof coverage。一等公民 Vue build 检查优先使用 `vue-tsc`。

```js
export default defineConfig({
  config: {
    checkers: {
      vue: {
        preset: 'vue-tsgo',
        entry: 'tsconfig.vue.build.json',
      },
    },
  },
});
```

## `entry`

`entry` 是 checker 的入口配置，通常是一个 build graph aggregator，例如 `tsconfig.build.json` 或 `tsconfig.vue.build.json`。Graph、proof、source 和 checker commands 都会从这些 entry 推导检查范围。

如果 `entry` 指向的 graph 里包含 `packages/app/tsconfig.lib.dts.json`，而 app 源码 import 了 `@acme/core`，Limina 就会沿着这个入口检查 app 是否正确 reference 了 core。

## `extensions`

`extensions` 不是用户配置项。Limina 会为每个内置 preset 固定 extensions，因为它们是 proof 语义的一部分：

- `tsc`：`.ts`、`.tsx`、`.cts`、`.mts`、`.d.ts`、`.d.cts`、`.d.mts`、`.json`；
- `tsgo`：`.ts`、`.tsx`、`.cts`、`.mts`、`.d.ts`、`.d.cts`、`.d.mts`、`.json`；
- `vue-tsc`：`.ts`、`.tsx`、`.cts`、`.mts`、`.d.ts`、`.d.cts`、`.d.mts`、`.json`，以及 `@vue/language-core` 返回的 Vue 扩展；
- `vue-tsgo`：`.ts`、`.tsx`、`.cts`、`.mts`、`.d.ts`、`.d.cts`、`.d.mts`、`.json`，以及 `@vue/language-core` 返回的 Vue 扩展；
- `svelte-check`：`.ts`、`.tsx`、`.cts`、`.mts`、`.d.ts`、`.d.cts`、`.d.mts`、`.json`、`.svelte`。

配置 `extensions` 会被拒绝。

配置了 `vue` checker 后，源码中如果出现 `.vue` 文件：

```vue
<!-- packages/app/src/App.vue -->
<script setup lang="ts">
const count: number = '1';
</script>
```

`limina checker build` 会用 `vue-tsc -b` 覆盖一等公民 Vue entry，而不是只跑普通 `tsc` / `tsgo`。`vue-tsgo` entry 在执行上是二等公民，会在后续通过 `limina checker typecheck` 执行，同时仍会把它的 tsconfig route 贡献给 Limina coverage proof。如果没有给 Vue 源码配置 checker entry，`proof check` 也更容易暴露“这些文件没有被任何 checker 覆盖”的问题。

完整一点看，目录通常类似这样：

```text
packages/app/
  tsconfig.vue.build.json
  tsconfig.vue.dts.json
  tsconfig.vue.json
  src/App.vue
```

模块里出现了 Vue 单文件组件：

```vue
<!-- packages/app/src/App.vue -->
<script setup lang="ts">
const count: number = '1';
</script>
```

运行 `pnpm exec limina checker build` 时，Limina 会从 `config.checkers.vue.entry` 指向的 `tsconfig.vue.build.json` 出发，并对一等公民 Vue checker 执行 `vue-tsc -b`。如果 entry 使用 `vue-tsgo`，Limina 会保留它的 graph/proof coverage，但 checker 本身会通过 `pnpm exec limina checker typecheck` 执行为 `vue-tsgo --project <entry>`。

结果是这个类型错误由已配置的 Vue checker 报出。这样用户能知道 `.vue` 文件不是靠普通 `tsc` 顺便覆盖，而是由专门的 checker entry 进入 Limina 的检查范围。

对于 `vue-tsgo` 和 `svelte-check`，Limina 会通过 `limina checker typecheck` 执行直接二等公民 checker 命令。`vue-tsgo` 仍会作为 graph-aware entry 参与 Limina 自己的 tsconfig coverage proof，但它不是一等公民 build runner。
