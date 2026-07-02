# Checker Entries

Checker entries tell Limina which source `tsconfig.json` files each checker should handle. When `config.checkers` is omitted, Limina uses `auto` mode: it discovers ordinary `tsconfig.json` files, chooses `tsc` or `vue-tsc` from the files each one contains, and sends `TypeScript` projects that depend on `Vue` projects to `vue-tsc` as well, so initial setup does not need hand-written routing.

Use an explicit checker object when you need `tsgo`, check-only checkers, smaller `Vue` coverage, or more explicit `include` / `exclude` rules. Limina starts from those entries, follows `references` from aggregator configs, and writes the declaration graph, checker build entries, declaration output directories, `.tsbuildinfo` paths, and manifest under `.limina/`.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    // Optional. Omit this field for default auto discovery.
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

- **Type:** `{ mode: 'auto'; exclude?: string[] }`
- **Default:** used when `config.checkers` is omitted

`auto` mode treats every ordinary `tsconfig.json` as a source entry. An entry with only `TypeScript`, `JavaScript`, and `JSON` files goes to `tsc`. An entry containing `.vue` files goes to `vue-tsc`. `solution-style tsconfig.json` files are handled as aggregators, and Limina classifies them from the referenced source configs.

If a `TypeScript` entry imports a `Vue` entry, `auto` mode sends that `TypeScript` entry to `vue-tsc` too. This promotion continues through dependency chains, so the generated build graph avoids an incompatible `tsc` project depending on a `vue-tsc` project.

Use the object form when automatic discovery should skip specific `tsconfig` scopes:

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

`exclude` matches tsconfig paths relative to the workspace root. It is separate from `config.source.exclude`, which controls source coverage checks. Without `exclude`, `auto` mode scans every ordinary `tsconfig.json` it can discover and every ordinary source config reached through aggregator `references`.

`auto` mode only chooses between `tsc` and `vue-tsc`. Switch to an explicit checker object when you need another preset or a tighter split.

## Vue import Parsing

- **Type:** `config.imports.vue?: 'heuristic' | 'compiler-sfc'`
- **Default:** `'heuristic'`

Limina extracts imports from `Vue SFC` `<script>` and `<script setup>` blocks when it builds the source graph. The default heuristic parser needs no extra package and is enough for ordinary inline script imports.

Use `config.imports.vue: 'compiler-sfc'` when you want Limina to parse SFC blocks through `Vue`'s compiler package:

```js
export default defineConfig({
  config: {
    imports: {
      vue: 'compiler-sfc',
    },
  },
});
```

When this mode is enabled, install `@vue/compiler-sfc` in the workspace running Limina. Missing `@vue/compiler-sfc` fails checker preflight before any checker process starts.

## \<name\>

- **Type:** `string` key of `config.checkers` (a `Record<string, CheckerConfig>`)

The `checkers` `key` is the checker namespace, such as `typescript`, `vue`, or `svelte`. Generated files are scoped by this name under `.limina/tsconfig/checkers/<name>/`, so diagnostics can always say which checker produced or reached a config.

## preset

- **Type:** `'tsc' | 'tsgo' | 'vue-tsc' | 'vue-tsgo' | 'svelte-check'`

`preset` chooses the parser and checker runner:

- `tsc`: TypeScript and JSON;
- `tsgo`: TypeScript and JSON through `@typescript/native-preview`;
- `vue-tsc`: TypeScript, JSON, and `.vue`;
- `vue-tsgo`: Vue through `vue-tsgo` and `@typescript/native-preview`;
- `svelte-check`: Svelte coverage proof and second-class typecheck execution.

Only built-in presets are accepted. Custom presets and custom `extensions` are rejected.

## include

- **Type:** `string[]`
- **Required:** yes

`include` is a non-empty list of workspace-root-relative selectors for source entry files named exactly `tsconfig.json`. It must not select `tsconfig.lib.json`, `tsconfig.test.json`, `tsconfig.build.json`, generated `.limina` files, base configs, check configs, or other reserved `tsconfig` files.

During `graph prepare`, Limina expands `include` minus `exclude` to get the checker entry set. Each entry must belong to only one checker. From there, Limina follows `TypeScript references` on `solution-style tsconfig.json` files and brings the referenced source configs into the managed scope.

Non-entry configs such as `tsconfig.lib.json`, `tsconfig.test.json`, or `tsconfig.tools.json` are therefore useful, but they are not selected directly by `checker.include`. They enter Limina's managed scope only when a selected `tsconfig.json` entry references them. A standalone base, build-only, or helper config that is not reachable from an entry is not treated as a source check target.

For every source config in scope, Limina writes declaration build configs under `.limina/tsconfig/checkers/<checker>/projects/...`. Those configs extend the source config, force declaration emit options, write declaration output under `.limina/dts/checkers/<checker>/...`, and record the source-to-generated mapping. Source `tsconfig.json` solution aggregators are generated under `.limina/tsconfig/checkers/<checker>/solutions/...`.

## Entry Uniqueness and Capability Coverage

After `include` and `exclude` are applied, checker entry sets must not overlap. The same `tsconfig.json` entry cannot be listed under both `typescript` and `vue`, even if the presets are different. Choose one checker as the entry owner.

This does not mean a referenced source config can only have one capability. Once entries expand through `references`, different presets may cover the same source config. This is how a repository can add `Vue` capability to a source config that also participates in a `TypeScript` graph. The duplicate case Limina rejects is narrower: two checkers with the same preset must not govern the same expanded source config.

Limina also checks file capability after expansion. If a source config includes `.vue` files but is only covered by `tsc` or `tsgo`, `graph prepare` fails and points to a checker preset that can handle that extension. Add a matching checker entry that reaches the config, or move those files to a config owned by the right checker.

## Cross-checker Reachability

Source `import`s may cross checker boundaries. For example, a `TypeScript`-only entry may import a project handled through a `Vue` checker entry. Limina records that dependency so checkers running in build mode can build the provider side before the consumer side.

When presets with different build cache behavior can reach the same generated declaration config, Limina prints a warning after the build:

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

Read `reachable from` as the reachability map. It tells you which checker and which entry `tsconfig.json` can reach the same generated config. To remove the warning, make that reachable area use cache-compatible build presets. Same-preset combinations are fine, and `tsc` with `vue-tsc` is treated as compatible. Combinations such as `tsgo` with `tsc` or `tsgo` with `vue-tsc` are warned because they do not safely share the same underlying build cache.

## exclude

- **Type:** `string[]`
- **Default:** `[]`

`exclude` removes entry selectors from `include`. Use it to keep entry ownership clear:

```js
exclude: ['**/docs/**', 'packages/playground/tsconfig.json'];
```

## Generated Graph

Run `limina graph prepare` to materialize `.limina/manifest.json` and generated checker configs. Graph-consuming commands also automatically prepare the graph before they run.

Source `tsconfig` paths are the canonical paths in user config and diagnostics. Generated `.limina/tsconfig/checkers/.../*.dts.json` paths are internal output and do not need to be written in user config.
