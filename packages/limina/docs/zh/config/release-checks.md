# 发布检查

`limina release check` 独立于 `package check`。它使用同一组 `package.entries` 做选择，打包 `npm tarball`，然后校验发布卫生，以及基于 `npm` 注册表内容的工作区发布依赖一致性。

Limina 内置的发布检查始终执行。除此之外，还可以通过可选的 `release.npmPackageJsonLint` 集成，让 `npm-package-json-lint` 检查打包后的 `package.json`。

对于工作区发布依赖，Limina 会把本地打包产物和 `npm dist-tag` 基线（`release.contentHash.baselineTag`，默认 `latest`）做包相对内容差异对比。差异报告会把文件分成 `changed`、`local-only`、`remote-only` 三类；失败时会列出发布相关的具体文件名。如果按配置忽略后消费者可见包内容一致，就不会要求该依赖重新发布。

在解包或比较注册表基线 tarball 之前，Limina 会先使用 `dist.integrity` 校验它；若该字段缺失，则回退使用 SHA-1 `dist.shasum`。integrity 元数据缺失、格式错误或摘要不匹配都会让 `release check` 失败，且不能跳过这项校验。

::: warning `tarball` 与发布卫生
发布检查会拒绝私有输出（`private: true`）、缺失 `README.md` 或 `LICENSE.md`、源码映射文件（`.map`）、`JavaScript sourceMappingURL` 注释，以及不覆盖本地工作区版本的发布依赖范围。
:::

::: warning 本地依赖泄漏
发布检查会拒绝输出清单和打包清单所有依赖区间里泄露的 `workspace:`、`link:`、`file:`、`catalog:`。
:::

::: tip 选择条目
没有 `--package` 时，`limina release check` 要求当前目录最近的 `package.json#name` 必须命中配置条目；传入一个或多个 `--package <name>` 时会跳过当前目录匹配。
:::

## npmPackageJsonLint

- **类型：** `boolean | { rules?: Record<string, RuleConfig> }`
- **默认值：** `false`

`npmPackageJsonLint: true` 会使用 Limina 的默认发布规则，让 `npm-package-json-lint` 检查打包后的发布清单。对象形式同样会启用集成，并把 `rules` 合并到默认规则上。将单条规则设为 `off` 可以关闭它；设为 `warning` 时会显示问题，但不会让发布检查失败。

`RuleConfig` 可以是 `off`、`warning`、`error`，也可以是所选规则支持的 `[severity, options]` 元组。

```ts
export default defineConfig({
  release: {
    npmPackageJsonLint: {
      rules: {
        'prefer-property-order': 'warning',
        'require-types': 'off',
      },
    },
  },
});
```

`npm-package-json-lint` 是 Limina 的可选对等依赖。需要启用这项集成时，请在运行 Limina 的工作区中安装它：

```sh
pnpm add -D npm-package-json-lint@^9.1.0
```

如果已经启用集成但没有安装这个包，`release check` 会失败并给出安装提示。不需要这项集成时，可以省略该字段或显式设为 `false`。Limina 直接读取这里的规则覆盖，不会搜索单独的 `npm-package-json-lint` 配置文件。

## contentHash.baselineTag

- **类型：** `string | ((args: { importerName: string; dependencyName: string }) => string)`
- **默认值：** `'latest'`

`contentHash.baselineTag` 是对比依赖包输出时作为线上基线的 `npm dist-tag`。传入函数可以按 `importer/dependency` 组合返回不同的基线。

## contentHash.builtinIgnore

- **类型：** `boolean`
- **默认值：** `false`

默认 `contentHash.builtinIgnore` 是 `false`，所以 `README`、`changelog`、`contributing`、`security` 文件以及 `docs/**`、`examples/**` 都不会被忽略。

设置 `builtinIgnore: true` 后，内置忽略集只会在 `release.contentHash.ignore` 未配置或忽略函数返回 `undefined` 时作为兜底。

::: info
忽略函数返回 `[]` 表示该 `dependency` 不忽略任何文件（不应用内置集）；返回 `undefined` 才会回退到内置集。
:::

## contentHash.ignore

- **类型：** `string[] | ((args: { importerName: string; dependencyName: string }) => string[] | undefined)`

`contentHash.ignore` 可以是包相对 `glob` 数组，例如 `client/**` 或 `dist/*.wasm`，也可以写成函数并按 `importer/dependency` 包名返回 `glob` 数组。

被忽略的报告会按命中的规则分组，并统计 `changed`、`local-only`、`remote-only` 三类数量。

::: info `[]` 与 `undefined`
对于函数形式，返回 `[]` 表示该 `dependency` 不忽略任何文件，而返回 `undefined` 会在 `builtinIgnore: true` 时回退到内置忽略集。
:::
