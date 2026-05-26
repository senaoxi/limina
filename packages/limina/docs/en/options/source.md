# Source Coverage

Source settings define which files need proof coverage.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    source: {
      include: ['packages/**/src/**/*.{ts,tsx,vue}'],
      exclude: ['node_modules', 'dist', '.tsbuild', 'coverage'],
    },
  },
});
```

## `include`

`include` is the source glob set that needs proof coverage. When it is omitted, Limina derives source files from active checker extensions and applies the default exclude list.

If every TypeScript, TSX, and Vue file under `packages/**/src` should be covered by a checker, put those globs in `include`. New files then automatically become part of `proof check`.

## `exclude`

`exclude` is the directory or glob set that should stay outside proof coverage. Use it for `dist`, `.tsbuild`, fixtures, generated caches, and other files that should not be treated as governed source.

For example, after `include` covers `packages/**/src/**/*.{ts,tsx,vue}`, adding this file makes it part of the proof boundary:

```ts
// packages/core/src/generated/runtime.ts
export const runtimeName = 'core';
```

If the file is not covered by a project reachable from a checker entry and is not listed in `proof.allowlist`, `limina proof check` reports it as uncovered source. If a fixture directory should stay outside governance, exclude it explicitly instead of letting it escape by accident.

In a fuller example, the directory can look like this:

```text
packages/core/
  src/index.ts
  src/generated/runtime.ts
  tsconfig.lib.dts.json
  tsconfig.lib.json
```

`config.source.include` covers `packages/**/src/**/*.{ts,tsx,vue}`, so `src/generated/runtime.ts` is considered source that needs proof coverage. When `pnpm exec limina proof check` runs, Limina collects source files matched by `include`, then checks whether each file is covered by a graph project, checker entry, or `proof.allowlist`.

If `runtime.ts` is not covered by any checker, the result is a proof check failure listing it as uncovered source. If it is actually a fixture or cache file, exclude that directory; if it is an intentional exception, add it to `proof.allowlist` with a reason.
