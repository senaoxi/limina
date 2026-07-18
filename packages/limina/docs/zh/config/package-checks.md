# 包检查

包检查针对构建后的输出目录运行。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  package: {
    entries: [
      {
        name: '@acme/core',
        outDir: 'packages/core/dist',
        checks: ['publint', 'attw', 'boundary'],
        publint: {
          level: 'warning',
        },
        attw: {
          profile: 'esm-only',
          ignoreRules: ['false-cjs'],
        },
        boundary: {
          environment: 'browser',
          ignoredExternalPackages: ['@acme/runtime-polyfill'],
        },
      },
    ],
  },
});
```

::: tip
包检查校验的是消费者实际安装目录在解析器和运行时维度的行为。`tarball` 与发布卫生由[发布检查](./release-checks.md)单独处理。
:::

## entries

- **类型：** `PackageEntry[]`

`entries` 列出要检查的构建后包输出。每个条目都是独立的输出产物：多个条目可以同名，一个源码包可以产出多个条目，条目名称也不必等于源码包名。Limina 不会从这段配置推断或校验源码与输出之间的绑定关系。

`--package <name>` 会选择所有同名配置条目。没有 `--package` 时，从激活包内部运行命令会通过已验证的激活包索引选择条目；位于 `config.rootDir` 外的词法路径仍然可以选择。附近未激活的 `package.json` 不会成为包 selector。

## name

- **类型：** `string`

`name` 是这个输出产物的 selector 名称。`CLI` 的 `--package <name>` 会使用它；重复名称会有意选中多个产物。

## outDir

- **类型：** `string`

`outDir` 相对于 `config.rootDir`，指向消费者实际安装到的构建后包目录，通常是 `packages/*/dist`。它可以包含 `../`，并指向外部激活包的输出。这个目录里应该有发布用的 `package.json`、`JavaScript` 和声明文件。`README.md`、`LICENSE.md` 与 `tarball` 卫生由 `limina release check` 校验。

这个输出在工作区发现期间是无条件 output root。它必须是专用的严格后代输出目录：不能等于或包含 `config.rootDir` 或任何激活包根目录，也不能与 Limina 的 `.limina` namespace 发生任一方向的包含。输出归属无效时，`workspace:validate` 会在包选择或产物操作开始前失败。

::: info
每个 `outDir/package.json` 都必须存在，并且看起来像一个完整的 `npm` 包清单。Limina 会拒绝 `dependencies`、`devDependencies`、`peerDependencies` 和 `optionalDependencies` 中残留的 `workspace:`、`link:`、`file:`、`catalog:` 说明符，因为构建产物应该已经是消费者和 `npm` 实际看到的发布就绪清单。
:::

## checks

- **类型：** `Array<'publint' | 'attw' | 'boundary'>`
- **默认值：** `['publint', 'attw', 'boundary']`

`checks` 控制启用哪些工具：

- `publint`：检查消费者视角的包元数据和导出问题；
- `attw`：用 `Are The Types Wrong` 检查类型解析；
- `boundary`：扫描构建后的 `JavaScript` 导入，检查运行时和依赖边界。

`checks` 先决定基础工具集合。`publint` 和 `attw` 也可以写成 `true`、`false` 或对象，用来覆盖对应工具：`false` 表示关闭，`true` 或对象表示开启并使用默认或自定义配置。

::: warning
`publint` 和 `@arethetypeswrong/core` 是 Limina 的可选 `peer dependency`。已启用的 analyzer 未安装时，Limina 会把对应检查记为 `skipped`，并继续其他包检查；即使用 `--tool` 单独选择它，仅发生 skip 也不会让 `package check` 以非零状态退出。如果 CI 必须覆盖这两项检查，应显式安装并校验对应包。
:::

## publint

- **类型：** `boolean | { strict?: boolean; level?: 'suggestion' | 'warning' | 'error' }`
- **默认值：** `true`

`publint: true` 使用 Limina 默认配置启用 `publint`。`publint: false` 会在这个包条目里关闭 `publint`。对象形式会启用 `publint`，并修改传给 `publint` 的选项。

### publint.strict

- **类型：** `boolean`
- **默认值：** `true`

`publint.strict` 控制 `publint` 的 `strict` 选项，默认开启。

### publint.level

- **类型：** `'suggestion' | 'warning' | 'error'`

`publint.level` 控制 `publint` 报告的最低消息级别。

## attw

- **类型：** `boolean | { profile?: 'esm-only' | 'node16' | 'strict'; level?: 'warn' | 'error'; ignoreRules?: string[]; entrypoints?: string[]; includeEntrypoints?: string[]; excludeEntrypoints?: (string | RegExp)[]; entrypointsLegacy?: boolean }`
- **默认值：** `true`

`attw: true` 使用 Limina 默认配置启用 `Are The Types Wrong`。`attw: false` 会在这个包条目里关闭它。对象形式会启用 `ATTW`，并修改 Limina 过滤选项和 `checkPackage` 入口选项。

### attw.profile

- **类型：** `'esm-only' | 'node16' | 'strict'`
- **默认值：** `'esm-only'`

`attw.profile` 控制 `Are The Types Wrong` 的检查配置档，常见值包括 `esm-only`、`node16` 和 `strict`。

### attw.level

- **类型：** `'warn' | 'error'`
- **默认值：** `'error'`

`attw.level: 'warn'` 会把剩余 `ATTW` 问题作为警告输出，但不让包检查失败。默认 `'error'` 保持发现问题即失败的行为。

### attw.ignoreRules

- **类型：** `string[]`

`attw.ignoreRules` 按规则名忽略问题，比如 `false-cjs`、`cjs-resolves-to-esm`、`no-resolution` 或 `named-exports`。

## boundary.environment

- **类型：** `'browser' | 'node' | (string & {}) | ((relativeFilePath: string) => 'browser' | 'node' | (string & {}))`

`boundary.environment` 可以是字符串，也可以是接收产出相对文件路径的函数。整个包都是浏览器输出时可以写 `'browser'`；同一个输出里同时有 `node` / `browser` 文件时，可以按文件路径返回不同环境。

## boundary.ignoredExternalPackages

- **类型：** `string[]`

`boundary.ignoredExternalPackages` 用来声明少数外部导入是有意允许的，即使它们没有写在构建后包清单里。

例如源码中没有类型错误，但构建后的产物里有这些问题：

```jsonc
// packages/core/dist/package.json
{
  "name": "@acme/core",
  "exports": "./index.js",
  "types": "./missing.d.ts",
}
```

```js
// packages/core/dist/index.js
import { readFileSync } from 'node:fs';
```

`limina package check --package @acme/core` 会在输出层检查 `types`、`exports` 和运行时导入。若这个条目的 `boundary.environment` 是 `browser`，残留的 `node:fs` 也会被当作浏览器产物边界问题报告出来。

::: details 完整一点的例子
目录可以是：

```text
packages/core/
  src/index.ts
  dist/package.json
  dist/index.js
```

源码 `src/index.ts` 可能已经通过检查器构建 / 源码执行，但发布时消费者安装的是 `dist`。运行 `pnpm exec limina package check --package @acme/core` 时，Limina 会读取 `package.entries` 里 `name` 匹配的条目，然后在 `outDir` 指向的 `packages/core/dist` 中运行配置好的 `publint`、`attw` 和 `boundary`。

结果可能是多个层面的失败：`attw` 发现 `types` 指向 `missing.d.ts`；`boundary` 在浏览器条目中发现 `node:fs`。包检查校验的是消费者实际拿到的包在解析器和运行时维度的行为，而不是开发态源码。
:::
