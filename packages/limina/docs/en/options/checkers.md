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
- `vue-tsc`: `.vue`;
- `svelte-check`: `.svelte`.

Only built-in presets are accepted. `tsc` and `vue-tsc` are first-class build checkers; `svelte-check` is source-only.

## `entry`

`entry` is the checker entry config, usually a build graph aggregator such as `tsconfig.build.json` or `tsconfig.vue.build.json`. Graph, proof, paths, and checker commands all derive their scope from these entries.

If the graph under `entry` includes `packages/app/tsconfig.lib.dts.json` and app source imports `@acme/core`, Limina follows this entry and checks whether app references core correctly.

## `extensions`

`extensions` is not a user option. Limina fixes extensions per built-in preset because they are part of the proof model:

- `tsc`: `.ts`, `.tsx`, `.cts`, `.mts`, `.d.ts`, `.d.cts`, `.d.mts`, `.json`;
- `vue-tsc`: `.vue`;
- `svelte-check`: `.svelte`.

Configuring `extensions` is rejected.

After configuring a `vue` checker, a `.vue` source file is handled by that checker:

```vue
<!-- packages/app/src/App.vue -->
<script setup lang="ts">
const count: number = '1';
</script>
```

`limina checker build` uses `vue-tsc -b` for Vue entries instead of relying only on plain `tsc`. Without a checker entry for Vue source, `proof check` is also more likely to reveal that those files are not covered by any checker.

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

When `pnpm exec limina checker build` runs, Limina starts from `config.checkers.vue.entry` and runs `vue-tsc -b` because `vue-tsc` is first-class.

The result is that this type error is reported by `vue-tsc`. The user can tell that `.vue` files are not accidentally covered by plain `tsc`; they enter Limina through a dedicated checker entry.

For `svelte-check`, Limina proves `.svelte` source coverage and runs `svelte-check --tsconfig <entry>` through `limina checker typecheck`. It does not currently parse `.svelte` import graphs, so graph/source/proof coverage is intentionally narrower than first-class checkers.
