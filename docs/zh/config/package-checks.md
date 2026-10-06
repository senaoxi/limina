# 包检查

包检查针对消费者实际安装的输出目录运行。先完成项目构建，再用 `package.entries` 指定输出：

```sh
pnpm build
pnpm exec limina package check --package @acme/core
```

下面示例展示完整配置。若只填写 `name` 和 `outDir`，三项工具默认都会启用；其中 publint 和 ATTW 需要另行安装，缺失时会跳过，见下方[工具选择](#checks)。

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

::: tip 提示
包检查分析打包产物的元数据和类型，并扫描配置输出目录的导入边界。结果覆盖实际运行的分析器和扫描的文件，不保证所有运行时或消费环境都可用。[发布检查](./release-checks.md)另行检查必需文件和发布内容。
:::

## `entries`

- **类型：** `PackageEntry[]`

`entries` 列出要检查的构建后包输出。每个条目都是独立的输出产物：多个条目可以同名，一个源码包可以产出多个条目，条目名称也不必等于源码包名。Limina 不会从这段配置推断或校验源码与输出之间的绑定关系。

`--package <name>` 选择全部同名配置条目。不带该选项时，通过已验证的激活包索引解析当前工作目录，也支持 `config.rootDir` 外的词法路径。当前工作目录所属的激活包有名称且命中条目时，选择全部同名条目；未命中时，`package check` 回退到全部配置条目。所属包无名称或当前工作目录不在激活包内时，也选择全部条目。附近未激活的 `package.json` 不能用来选择条目。`release check` 要求命中当前工作目录所属的具名激活包，不会回退。

## `name`

- **类型：** `string`

`name` 是选择这个输出产物时使用的名称。CLI 的 `--package <name>` 会使用它；重复名称会选中多个产物。

## `outDir`

- **类型：** `string`

`outDir` 相对于 `config.rootDir`，指向消费者实际安装到的构建后包目录，通常是 `packages/*/dist`。它可以包含 `../`，并指向外部激活包的输出。这个目录里应该有发布用的 `package.json`、`JavaScript` 和声明文件。`limina release check` 检查 `README.md`、`LICENSE.md` 和打包文件中的发布内容。

这个输出在工作区发现期间是无条件生效的输出根目录。它必须是专用输出目录：不能等于或包含 `config.rootDir` 或任何激活包根目录，也不能与 Limina 的 `.limina` 命名空间发生任一方向的包含。输出归属无效时，`workspace:validate` 会在包选择或产物操作开始前失败。

::: info 说明
每个 `outDir/package.json` 必须存在，并可解析为具有非空 `name` 的对象。内置清单检查拒绝 `dependencies`、`devDependencies`、`peerDependencies` 和 `optionalDependencies` 中残留的 `workspace:`、`link:`、`file:`、`catalog:` 说明符。可选分析器会补充元数据和解析检查；仅内置检查不等于验证完整 npm 清单。
:::

Limina 也会拒绝在 `exports` 根同时使用子路径键（如 `"."`、`"./foo"`）与条件键（如 `"import"`）。这些声明检查独立于可选工具的选择，不解析或枚举全部导出目标。

打包产物中的导出目标缺失检查委托给 publint。关闭或跳过 publint 时，目标存在性尚未检查；其余检查通过不代表完整发布契约通过。ATTW 检查运行时与类型的兼容性，不决定哪些入口应该公开，也不改变消费者图的结果。包检查不会自动选择全部工作区包或扩展 ATTW 的检查入口集合。

## `checks`

- **类型：** `Array<'publint' | 'attw' | 'boundary'>`
- **默认值：** `['publint', 'attw', 'boundary']`

`checks` 控制启用哪些工具：

- `publint`：检查消费者视角的包元数据和导出问题；
- `attw`：用 `Are The Types Wrong` 检查类型解析；
- `boundary`：扫描构建后的 `JavaScript` 导入，检查运行时和依赖边界。

`checks` 先决定基础工具集合。省略 `publint` 或 `attw` 时，保留这个集合；显式 `false` 从集合中移除工具，显式 `true` 或对象则把工具加入集合。CLI `--tool` 只筛选最终已启用集合，不能重新启用被关闭的工具。筛选后没有检查的条目不会运行；全部条目都没有检查时，`package check` 失败。

::: warning 注意
`publint` 和 `@arethetypeswrong/core` 是 Limina 的可选对等依赖。已启用的分析器未安装时，Limina 会把对应检查记为 `skipped`（已跳过），并继续其他包检查；即使用 `--tool` 单独选择它，仅发生跳过也不会让 `package check` 以非零状态退出。如果持续集成必须覆盖这两项检查，应显式安装并校验对应包。
:::

只有分析器包确实未安装时才会跳过。已安装包的入口、初始化、语法或传递依赖发生加载错误时，包检查会失败并保留加载错误。Limina 使用与导入分析器时相同的 ESM 来源和条件判断包是否存在。

## `publint`

- **类型：** `boolean | { strict?: boolean; level?: 'suggestion' | 'warning' | 'error' }`
- **省略时：** 由 `checks` 决定是否启用

`publint: true` 使用 Limina 默认配置启用 `publint`。`publint: false` 会在这个包条目里关闭 `publint`。对象形式会启用 `publint`，并修改传给 `publint` 的选项。

例如，`checks: ['boundary']` 且省略 `publint` 时，只运行边界检查；再添加 `publint: true` 才会同时启用 publint。`attw` 遵循相同规则。

### `publint.strict`

- **类型：** `boolean`
- **默认值：** `true`

`publint.strict` 控制 `publint` 的 `strict` 选项，默认开启。

### `publint.level`

- **类型：** `'suggestion' | 'warning' | 'error'`

`publint.level` 控制传给 publint 的最低消息级别。该级别返回的任何消息都会让此检查失败，包括 `warning`（警告）或 `suggestion`（建议）；它是报告阈值，不是仅警告而不失败的退出策略。

## `attw`

- **类型：** `boolean | { profile?: 'esm-only' | 'node16' | 'strict'; level?: 'warn' | 'error'; ignoreRules?: string[]; entrypoints?: string[]; includeEntrypoints?: string[]; excludeEntrypoints?: (string | RegExp)[]; entrypointsLegacy?: boolean }`
- **省略时：** 由 `checks` 决定是否启用

`attw: true` 使用 Limina 默认配置启用 `Are The Types Wrong`。`attw: false` 会在这个包条目里关闭它。对象形式会启用 `ATTW`，并修改 Limina 过滤选项和 `checkPackage` 入口选项。

### `attw.profile`

- **类型：** `'esm-only' | 'node16' | 'strict'`
- **默认值：** `'esm-only'`

`attw.profile` 控制 `Are The Types Wrong` 的检查配置档，常见值包括 `esm-only`、`node16` 和 `strict`。

### `attw.level`

- **类型：** `'warn' | 'error'`
- **默认值：** `'error'`

`attw.level: 'warn'` 把过滤后剩余的 ATTW 问题作为警告输出，不让此检查失败；默认 `'error'` 会失败。该选项不豁免 ATTW 找不到包类型时的硬失败，也不豁免分析器加载或执行失败。

### `attw.ignoreRules`

- **类型：** `string[]`

`attw.ignoreRules` 按规则名忽略问题，比如 `false-cjs`、`cjs-resolves-to-esm`、`no-resolution` 或 `named-exports`。

### `attw` 的入口选项

以下字段直接传给 ATTW 的 `checkPackage`，入口根使用 `'.'`，子入口可写为 `'./client'`：

| 字段                 | 类型                   | 作用                                                               |
| -------------------- | ---------------------- | ------------------------------------------------------------------ |
| `entrypoints`        | `string[]`             | 指定完整入口集合，关闭自动发现，并覆盖下面的包含与排除选项         |
| `includeEntrypoints` | `string[]`             | 在自动发现的入口上补充入口                                         |
| `excludeEntrypoints` | `(string \| RegExp)[]` | 从待检查入口中排除匹配项                                           |
| `entrypointsLegacy`  | `boolean`              | 没有其他已发现或已配置入口时，允许 ATTW 按旧方式从发布文件推导入口 |

自动发现和筛选的具体行为取决于所安装的受支持 ATTW 版本。需要明确覆盖哪些入口时，直接设置 `entrypoints`；Limina 不会替你扩展为全部工作区包或全部导出文件。

## `boundary.environment`

- **类型：** `'browser' | 'node' | (string & {}) | ((relativeFilePath: string) => 'browser' | 'node' | (string & {}))`

`boundary.environment` 可以是字符串或接收输出相对文件路径的函数。未配置时，`node/` 或 `plugin/` 下的文件使用 `'node'`，其余使用 `'browser'`。只有精确的 `'node'` 返回值允许 Node 内置模块，自定义环境字符串不具备该许可。

边界扫描读取整个 `outDir` 的 `.js`、`.mjs` 和 `.cjs`，包括没有被打包选中的文件。它检查 `es-module-lexer` 返回的具体模块说明符；CommonJS `require`、计算形式的动态导入与 `import.meta` 不构成已覆盖导入。它不会验证每个相对输出导入目标是否存在。

## `boundary.ignoredExternalPackages`

- **类型：** `string[]`

`boundary.ignoredExternalPackages` 允许导入此字段列出的外部包，即使构建后包清单没有声明它们。

## 示例：源码通过，产物仍有问题

假设构建后留下了错误的类型入口和浏览器产物中的 Node 导入：

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

对这个输出运行 `limina package check --package @acme/core` 后，已启用且实际运行的 publint / ATTW 可以报告类型入口问题，具体诊断取决于工具版本与检查入口。`boundary.environment: 'browser'` 则会独立报告 `node:fs` 导入。

如果 publint 被禁用或因缺失而跳过，导出目标存在性仍未得到检查。边界扫描通过也不能替代类型解析检查；应同时查看每项工具的执行状态。
