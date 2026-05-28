# Checker Entries

Checker entries are shared by graph, source, proof, paths, and checker commands.

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

The `checkers` key is the name of that checker entry, such as `typescript`, `vue`, or `svelte`. It appears in reports and debugging output so you can tell which source family a problem came from.

One workspace can have several checker entries. A plain TypeScript graph can use `typescript`, a Vue app can add `vue`, and a Svelte package can add `svelte`.

## `preset`

`preset` chooses the checker runner Limina invokes:

- `tsc`: TypeScript and JSON;
- `tsgo`: TypeScript and JSON through `@typescript/native-preview`;
- `vue-tsc`: `.vue`;
- `vue-tsgo`: `.vue` through `vue-tsgo` and `@typescript/native-preview`;
- `svelte-check`: `.svelte`.

Only built-in presets are accepted. `tsc`, `tsgo`, and `vue-tsc` are first-class build checkers; `vue-tsgo` is graph-aware but source-only for execution; `svelte-check` is source-only.

`tsgo` uses Microsoft's preview package `@typescript/native-preview` and runs `tsgo -b <entry> --pretty false`. Use it when you want Limina's build checker to exercise the native TypeScript preview while keeping the same source graph model as `tsc`.

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

`vue-tsgo` uses KazariEX's `vue-tsgo` package with `@typescript/native-preview` and runs `vue-tsgo --project <entry>` through `limina checker typecheck`. It is intentionally source-only for execution in Limina: current `vue-tsgo --build` expands source imports into a transient virtual workspace, does not preserve TypeScript project-reference boundaries, and does not provide incremental build semantics. Limina still uses the configured `vue-tsgo` tsconfig entry for its own graph and proof coverage. Prefer `vue-tsc` for first-class Vue build checks.

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

`entry` is the checker entry config, usually a build graph aggregator such as `tsconfig.build.json` or `tsconfig.vue.build.json`. Graph, proof, paths, and checker commands all derive their scope from these entries.

If the graph under `entry` includes `packages/app/tsconfig.lib.dts.json` and app source imports `@acme/core`, Limina follows this entry and checks whether app references core correctly.

## `extensions`

`extensions` is not a user option. Limina fixes extensions per built-in preset because they are part of the proof model:

- `tsc`: `.ts`, `.tsx`, `.cts`, `.mts`, `.d.ts`, `.d.cts`, `.d.mts`, `.json`;
- `tsgo`: `.ts`, `.tsx`, `.cts`, `.mts`, `.d.ts`, `.d.cts`, `.d.mts`, `.json`;
- `vue-tsc`: `.vue`;
- `vue-tsgo`: `.vue`;
- `svelte-check`: `.svelte`.

Configuring `extensions` is rejected.

After configuring a `vue` checker, a `.vue` source file is handled by that checker:

```vue
<!-- packages/app/src/App.vue -->
<script setup lang="ts">
const count: number = '1';
</script>
```

`limina checker build` uses `vue-tsc -b` for first-class Vue entries instead of relying only on plain `tsc`/`tsgo`. `vue-tsgo` entries are source-only for execution and run later through `limina checker typecheck`, while still contributing their tsconfig route to Limina coverage proof. Without a checker entry for Vue source, `proof check` is also more likely to reveal that those files are not covered by any checker.

In a fuller example, the directory usually looks like this:

```text
packages/app/
  tsconfig.vue.build.json
  tsconfig.vue.dts.json
  tsconfig.vue.json
  src/App.vue
```

The module is a Vue single-file component:

```vue
<!-- packages/app/src/App.vue -->
<script setup lang="ts">
const count: number = '1';
</script>
```

When `pnpm exec limina checker build` runs, Limina starts from `config.checkers.vue.entry` and runs `vue-tsc -b` for a first-class Vue checker. When the entry uses `vue-tsgo`, Limina keeps the entry in graph/proof coverage but runs the checker itself through `pnpm exec limina checker typecheck` as `vue-tsgo --project <entry>`.

The result is that this type error is reported by the configured Vue checker. The user can tell that `.vue` files are not accidentally covered by plain `tsc`; they enter Limina through a dedicated checker entry.

For `vue-tsgo` and `svelte-check`, Limina runs direct source-only checker commands through `limina checker typecheck`. `vue-tsgo` remains graph-aware for Limina's own tsconfig coverage proof, but it is not a first-class build runner.
