# Package checks

Package checks 针对构建后的 output directory 运行。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  package: {
    entries: [
      {
        name: '@acme/core',
        outDir: 'packages/core/dist',
        checks: ['publint', 'attw', 'boundary'],
        attw: {
          profile: 'esm-only',
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

## `name`

`name` 是这个 package entry 的友好名称。CLI 的 `--package <name>` 和 release cwd 匹配都会用它。

## `outDir`

`outDir` 指向消费者实际安装到的构建后 package 目录，通常是 `packages/*/dist`。这个目录里应该有发布用的 `package.json`、JavaScript 和 declarations。README/license 与 tarball 卫生由 `limina release check` 校验。

开启顶层 `strict: true` 后，每个 `outDir/package.json` 都必须存在，并且看起来像一个完整的 npm package manifest。Limina 还会拒绝 `dependencies`、`devDependencies`、`peerDependencies` 和 `optionalDependencies` 中残留的 `workspace:`、`link:`、`file:`、`catalog:` specifier，因为构建产物应该已经是消费者和 npm 实际看到的发布就绪 manifest。

## `checks`

`checks` 控制启用哪些工具：

- `publint`：检查消费者视角的 package metadata 和 exports 问题；
- `attw`：用 Are The Types Wrong 检查类型解析；
- `boundary`：扫描构建后的 JavaScript imports，检查 runtime 和依赖边界。

## `publint.strict`

`publint.strict` 控制 publint 是否使用严格模式，默认开启。

## `attw.profile`

`attw.profile` 控制 Are The Types Wrong 的检查 profile，常见值包括 `esm-only`、`node16` 和 `strict`。

## `boundary.environment`

`boundary.environment` 可以是字符串，也可以是接收 emitted relative file path 的函数。整个 package 都是 browser output 时可以写 `'browser'`；同一个 output 里同时有 node/browser 文件时，可以按文件路径返回不同 environment。

## `boundary.ignoredExternalPackages`

`boundary.ignoredExternalPackages` 用来声明少数外部 import 是有意允许的，即使它们没有写在构建后 package manifest 里。

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

`limina package check --package @acme/core` 会在 output 层检查 `types`、exports 和 runtime imports。若这个 entry 的 `boundary.environment` 是 `browser`，残留的 `node:fs` 也会被当作浏览器产物边界问题报告出来。

完整一点看，目录可以是：

```text
packages/core/
  src/index.ts
  dist/package.json
  dist/index.js
```

源码 `src/index.ts` 可能已经通过 checker build/source execution，但发布时消费者安装的是 `dist`。运行 `pnpm exec limina package check --package @acme/core` 时，Limina 会读取 `package.entries` 里 `name` 匹配的 entry，然后在 `outDir` 指向的 `packages/core/dist` 中运行配置好的 `publint`、`attw` 和 `boundary`。

结果可能是多个层面的失败：`attw` 发现 `types` 指向 `missing.d.ts`；`boundary` 在 browser entry 中发现 `node:fs`。Package checks 校验的是消费者实际拿到的 package 在 resolver 和 runtime 维度的行为，而不是开发态源码。

## Release checks

`limina release check` 独立于 `package check`。它使用同一组 `package.entries` 做选择，打包 npm tarball，然后校验发布卫生和基于 npm registry metadata 的 workspace 发布依赖一致性。对于 workspace 发布依赖，Limina 会把本地打包产物和 npm dist-tag baseline 做 package-relative content diff 对比，`release.contentHash.baselineTag` 默认是 `latest`。diff 报告会把文件分成 `changed`、`local-only`、`remote-only` 三类；失败时会列出 release-relevant 的具体文件名。

默认 `release.contentHash.builtinIgnore` 是 `false`，所以 README、changelog、contributing、security 文件以及 `docs/**`、`examples/**` 都不会被忽略。设置 `builtinIgnore: true` 后，内置忽略集只会在 `release.contentHash.ignore` 未配置或 ignore 函数返回 `undefined` 时作为兜底；ignore 函数返回 `[]` 表示该 dependency 不忽略任何文件。`release.contentHash.ignore` 可以是 package-relative glob 数组，例如 `client/**` 或 `dist/*.wasm`，也可以写成函数并按 importer/dependency 包名返回不同规则。被忽略的报告会按命中的规则分组，并统计 `changed`、`local-only`、`remote-only` 三类数量。

如果按配置忽略后消费者可见 package 内容一致，就不会要求该依赖重新发布。Release checks 也会拒绝 private output、缺失 README/license、source map 文件、JavaScript `sourceMappingURL` 注释，以及不覆盖本地 workspace 版本的发布依赖 range。开启顶层 `strict: true` 后，release checks 还会拒绝 output manifest 和 packed manifest 所有依赖区间里泄露的 `workspace:`、`link:`、`file:`、`catalog:`。没有 `--package` 时，它要求 cwd 最近的 `package.json#name` 必须命中配置 entry；传入一个或多个 `--package <name>` 时会跳过 cwd 匹配。
