# Paths

Paths settings control generated compatibility configs.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  paths: {
    artifactDirectories: ['dist'],
    conditionPriority: ['types', 'import', 'default'],
    generatedFileName: 'tsconfig.dts.paths.generated.json',
    generatedFileMarker: 'GENERATED FILE - DO NOT EDIT BY HAND.',
    sourceExtensions: ['.ts', '.tsx', '.vue'],
  },
});
```

## `artifactDirectories`

`artifactDirectories` tells Limina which directory names represent build output, such as `dist`, `build`, or `lib`. When a `workspace:*` dependency resolves into one of those directories, Limina treats it as a source dependency falling back to an artifact.

## `conditionPriority`

`conditionPriority` controls which package export conditions Limina checks first. When a package exports `types`, `import`, and `default`, this order affects which export entry is used to infer source aliases.

## `generatedFileName`

`generatedFileName` is the generated compatibility config file name. The default is `tsconfig.dts.paths.generated.json`. Run `limina paths generate` to write generated files, then manually add them to the first position of the relevant declaration leaf's `extends` array.

## `generatedFileMarker`

`generatedFileMarker` is the header marker written into generated files. Limina uses it to know which generated paths files can be safely refreshed or removed.

## `sourceExtensions`

`sourceExtensions` are the suffixes Limina tries when mapping an artifact export back to source, such as `.ts`, `.tsx`, or `.vue`.

For example, `@acme/app` source imports `@acme/core`:

```ts
// packages/app/src/main.ts
import { createClient } from '@acme/core';
```

If `packages/app/package.json` declares `"@acme/core": "workspace:*"` but `@acme/core` still exports `./dist/index.js`, Graph check reports that the source dependency resolved to build output. After `limina paths generate`, Limina writes aliases back to source entries and tells you which `tsconfig*.dts.json` files should manually extend the generated config first.

In a fuller example, the directory can look like this:

```text
packages/app/
  package.json
  src/main.ts
  tsconfig.lib.dts.json
packages/core/
  package.json
  src/index.ts
  dist/index.js
```

`packages/core/package.json` still exports build output:

```jsonc
{
  "name": "@acme/core",
  "exports": {
    ".": "./dist/index.js",
  },
}
```

When `pnpm exec limina graph check` runs, Limina resolves `import '@acme/core'` in `@acme/app`. Because app depends on core with `workspace:*`, the edge should be a source dependency. TypeScript resolution lands on `packages/core/dist/index.js`, and `dist` is listed in `artifactDirectories`.

The result is a graph check report that a workspace source dependency resolved to an artifact. Running `pnpm exec limina paths generate` then lets Limina infer source aliases from exports and `sourceExtensions`, write a compatibility config, and tell you to add it as the first `extends` entry in app's declaration leaf.
