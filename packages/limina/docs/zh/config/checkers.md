# 检查器入口

检查器入口会被图、源码、覆盖证明和检查器命令共同使用。

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

## \<name\>

- **类型：** `config.checkers` 的 `string` key（`Record<string, CheckerConfig>`）

`checkers` 的 key 是这组检查器的名字，例如 `typescript`、`vue` 或 `svelte`。它会出现在报告和调试信息里，用来区分是哪一类源码入口出了问题。

同一个工作区可以同时有多个检查器入口。普通 TypeScript 图可以用 `typescript`，Vue 应用可以额外用 `vue`，Svelte 包可以额外用 `svelte`。

## preset

- **类型：** `'tsc' | 'tsgo' | 'vue-tsc' | 'vue-tsgo' | 'svelte-check'`

`preset` 决定 Limina 调用哪个检查器运行器：

- `tsc`：处理 TypeScript 和 JSON；
- `tsgo`：通过 `@typescript/native-preview` 处理 TypeScript 和 JSON；
- `vue-tsc`：处理 `.vue`；
- `vue-tsgo`：通过 `vue-tsgo` 和 `@typescript/native-preview` 处理 `.vue`；
- `svelte-check`：处理 `.svelte`。

Limina 只接受内置预设。`tsc`、`tsgo` 和 `vue-tsc` 支持构建执行，所以是一等公民；`vue-tsgo` 和 `svelte-check` 只支持直接类型检查执行，所以是二等公民。`vue-tsgo` 仍具备 Limina 源码图能力，`svelte-check` 则不参与源码图。

`tsgo` 使用 Microsoft 的预览包 `@typescript/native-preview`，执行 `tsgo -b <entry> --pretty false`。当你希望 Limina 的构建检查器试跑原生 TypeScript 预览版，同时保持和 `tsc` 相同的源码图模型时，可以使用它。

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

::: warning
`vue-tsgo` 使用 KazariEX 的 `vue-tsgo` 包和 `@typescript/native-preview`，并通过 `limina checker typecheck` 执行 `vue-tsgo --project <entry>`。Limina 会有意把它作为二等公民执行检查器：当前 `vue-tsgo --build` 会把源码导入展开到临时虚拟 TS 工作区，不能保持 TypeScript 项目引用边界，也不具备增量构建语义。Limina 仍会使用已配置的 `vue-tsgo` tsconfig 入口做自己的图检查和覆盖证明。一等公民 Vue 构建检查优先使用 `vue-tsc`。
:::

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

## entry

- **类型：** `string`

`entry` 是检查器的入口配置，通常是一个构建图聚合器，例如 `tsconfig.build.json` 或 `tsconfig.vue.build.json`。图、覆盖证明、源码和检查器命令都会从这些入口推导检查范围。

如果 `entry` 指向的图里包含 `packages/app/tsconfig.lib.dts.json`，而 app 源码导入了 `@acme/core`，Limina 就会沿着这个入口检查 app 是否正确引用了 core。

## extensions

`extensions` 不是用户配置项。Limina 会为每个内置预设固定扩展名，因为它们是覆盖证明语义的一部分。配置 `extensions` 会被拒绝。

::: details 每个内置预设固定的扩展名

- `tsc`：`.ts`、`.tsx`、`.cts`、`.mts`、`.d.ts`、`.d.cts`、`.d.mts`、`.json`；
- `tsgo`：`.ts`、`.tsx`、`.cts`、`.mts`、`.d.ts`、`.d.cts`、`.d.mts`、`.json`；
- `vue-tsc`：`.ts`、`.tsx`、`.cts`、`.mts`、`.d.ts`、`.d.cts`、`.d.mts`、`.json`，以及 `@vue/language-core` 返回的 Vue 扩展；
- `vue-tsgo`：`.ts`、`.tsx`、`.cts`、`.mts`、`.d.ts`、`.d.cts`、`.d.mts`、`.json`，以及 `@vue/language-core` 返回的 Vue 扩展；
- `svelte-check`：`.ts`、`.tsx`、`.cts`、`.mts`、`.d.ts`、`.d.cts`、`.d.mts`、`.json`、`.svelte`。

:::

配置了 `vue` 检查器后，源码中如果出现 `.vue` 文件：

```vue
<!-- packages/app/src/App.vue -->
<script setup lang="ts">
const count: number = '1';
</script>
```

`limina checker build` 会用 `vue-tsc -b` 覆盖一等公民 Vue 入口，而不是只跑普通 `tsc` / `tsgo`。`vue-tsgo` 入口在执行上是二等公民，会在后续通过 `limina checker typecheck` 执行，同时仍会把它的 tsconfig 路由贡献给 Limina 覆盖证明。如果没有给 Vue 源码配置检查器入口，`proof check` 也更容易暴露“这些文件没有被任何检查器覆盖”的问题。

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

运行 `pnpm exec limina checker build` 时，Limina 会从 `config.checkers.vue.entry` 指向的 `tsconfig.vue.build.json` 出发，并对一等公民 Vue 检查器执行 `vue-tsc -b`。如果入口使用 `vue-tsgo`，Limina 会保留它的图检查和覆盖证明，但检查器本身会通过 `pnpm exec limina checker typecheck` 执行为 `vue-tsgo --project <entry>`。

结果是这个类型错误由已配置的 Vue 检查器报出。这样用户能知道 `.vue` 文件不是靠普通 `tsc` 顺便覆盖，而是由专门的检查器入口进入 Limina 的检查范围。

对于 `vue-tsgo` 和 `svelte-check`，Limina 会通过 `limina checker typecheck` 执行直接二等公民检查器命令。`vue-tsgo` 仍会作为图感知入口参与 Limina 自己的 tsconfig 覆盖证明，但它不是一等公民构建运行器。
