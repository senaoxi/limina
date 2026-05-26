# Paths

Paths settings 控制生成的 compatibility config。

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

`artifactDirectories` 告诉 Limina 哪些目录名代表构建产物，例如 `dist`、`build`、`lib`。当 `workspace:*` 依赖解析到这些目录时，Limina 会把它当作“源码依赖落到了 artifact”来处理。

## `conditionPriority`

`conditionPriority` 控制读取 package exports 时优先看哪些 condition。包同时声明 `types`、`import`、`default` 时，这个顺序会影响 Limina 选择哪个导出入口来反推源码 aliases。

## `generatedFileName`

`generatedFileName` 是生成的 compatibility config 文件名，默认是 `tsconfig.dts.paths.generated.json`。运行 `limina paths generate` 写出生成文件后，需要手动把它们放到相关 declaration leaf 的 `extends` 第一项。

## `generatedFileMarker`

`generatedFileMarker` 是生成文件头部的标记。Limina 用它判断哪些 generated paths 文件可以安全刷新或移除。

## `sourceExtensions`

`sourceExtensions` 是 Limina 把 artifact export 映射回源码入口时尝试的后缀，例如 `.ts`、`.tsx`、`.vue`。

例如 `@acme/app` 的源码写了：

```ts
// packages/app/src/main.ts
import { createClient } from '@acme/core';
```

同时 `packages/app/package.json` 使用 `"@acme/core": "workspace:*"`，但 `@acme/core` 的 `exports` 仍然指向 `./dist/index.js`。这时 Graph check 会提示源码依赖解析到了构建产物；运行 `limina paths generate` 后，Limina 会生成指向源码入口的 aliases，并提示把生成文件手动放到相关 `tsconfig*.dts.json` 的 `extends` 第一项。

完整一点看，目录可以是：

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

`packages/core/package.json` 仍然把 exports 指向构建产物：

```jsonc
{
  "name": "@acme/core",
  "exports": {
    ".": "./dist/index.js",
  },
}
```

运行 `pnpm exec limina graph check` 时，Limina 会解析 `@acme/app` 里的 `import '@acme/core'`。因为 app 用 `workspace:*` 依赖 core，这条边按语义应该是源码依赖；但 TypeScript 解析结果落到了 `packages/core/dist/index.js`，并且 `dist` 在 `artifactDirectories` 里。

结果是 graph check 报告 workspace source dependency resolved to artifact。随后运行 `pnpm exec limina paths generate`，Limina 会根据 exports 和 `sourceExtensions` 推导源码 alias，生成 compatibility config，并提示把它加入 app 的 declaration leaf `extends` 第一项。
