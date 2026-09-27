# 发布检查

`limina release check` 独立于 `package check`。它使用同一组 `package.entries` 做选择，打包 `npm tarball`，然后校验发布卫生，以及基于 `npm` 注册表内容的工作区发布依赖一致性。

Limina 内置的发布检查始终执行。除此之外，还可以通过可选的 `release.npmPackageJsonLint` 集成，让 `npm-package-json-lint` 检查打包后的 `package.json`。

对于工作区发布依赖，Limina 会把本地打包产物和 `npm dist-tag` 基线（`release.contentHash.baselineTag`，默认 `latest`）做包相对内容差异对比。差异报告会把文件分成 `changed`、`local-only`、`remote-only` 三类；失败时会列出发布相关的具体文件名。如果按配置忽略后消费者可见包内容一致，就不会要求该依赖重新发布。

在解包或比较注册表基线 tarball 之前，Limina 会先使用 `dist.integrity` 校验它；若该字段缺失，则回退使用 SHA-1 `dist.shasum`。integrity 元数据缺失、格式错误或摘要不匹配都会让 `release check` 失败，且不能跳过这项校验。

::: warning `tarball` 与发布卫生
发布检查会拒绝私有输出（`private: true`）、缺失 `README.md` 或 `LICENSE.md`、源码映射文件（`.map`）、`JavaScript sourceMappingURL` 注释，以及不覆盖本地工作区版本的发布依赖范围。
:::

依赖范围遵循常规 semver 预发布规则：`^1.0.0` 不接受 `1.1.0-beta.1`，而 `^1.1.0-beta.0` 显式接受该预发布系列。这适用于 `dependencies`、`optionalDependencies` 与 `peerDependencies`；本地 workspace 成员身份不会扩大打包后消费者的版本范围。

Source map 指令检查依据 JavaScript 解析上下文识别真实的行注释和块注释，包括模板插值与正则表达式附近的注释。字符串、模板字面量或正则中的类似指令文本不算指令。无法可靠解析的 JavaScript 会导致发布检查失败，并报告对应文件及解析诊断。

::: warning 本地依赖泄漏
发布检查会拒绝输出清单和打包清单所有依赖区间里泄露的 `workspace:`、`link:`、`file:`、`catalog:`。
:::

::: tip 选择条目
没有 `--package` 时，`limina release check` 要求当前目录最近的 `package.json#name` 必须命中配置条目；传入一个或多个 `--package <name>` 时会跳过当前目录匹配。
:::

## Registry authority 与响应体限制

release registry 请求必须属于当前 effective registry authority；默认 authority 为 npm 官方 registry（`https://registry.npmjs.org/`）。企业 registry 与镜像 registry 的 metadata 和 tarball 使用同一 HTTPS origin 时受支持。

Limina 在每次 release 调用中创建一份 registry 配置快照，以命令的有效工作目录定位 npm 项目或 workspace 的 `.npmrc`，不会从待比较的输出目录读取配置。同名键按环境变量、项目 npmrc、用户 npmrc、全局 npmrc 的顺序确定优先级。支持大小写 npm 配置环境变量；两种写法同时存在时，小写优先。`NPM_CONFIG_USERCONFIG` 与 `NPM_CONFIG_GLOBALCONFIG` 可指定对应配置文件。npm 的 `ini` 解析器处理 npmrc 引号与注释，registry 设置支持 `${ENV_VAR}` 插值。插值变量缺失、配置不可读、显式指定的配置文件不存在或所选 registry URL 无效时，检查明确失败。

完成同名键合并后，优先使用依赖包匹配的 `@scope:registry`，再使用通用 `registry`。因此，通用 `NPM_CONFIG_REGISTRY` 不会覆盖不同键名的 scoped registry。两个键均不存在时，使用 npm 官方默认地址。registry 的路径前缀会被保留，例如 `https://packages.example.com/npm/team/`。

```ini
registry=https://packages.example.com/npm/default/
@team:registry=https://packages.example.com/npm/team/
```

生产 registry 与 tarball URL 必须是绝对 HTTPS URL，且不得包含 credentials、query 或 hash。tarball 必须与所选 registry 具有相同 origin（协议、主机与有效端口）。显式配置的企业内部 HTTPS registry 可以成为受信任 authority。metadata 与 tarball 请求都拒绝所有重定向，包括同源重定向。跨源 CDN tarball、带签名查询参数的 URL 和 HTTP registry 不在允许范围内。本次 registry 选择支持不包含 npmrc 认证、专用 CA 或代理配置支持。

metadata 响应体上限为 **16 MiB**，tarball 响应体上限为 **128 MiB**。Limina 在 `Content-Length` 有效时检查声明长度，同时累计 HTTP 内容解码后响应流的实际字节数；超限后立即取消读取，不进入解析或 integrity 校验。限制同样适用于分块传输与 HTTP 压缩响应，恰好达到上限的响应仍可接受。原有超时与 tarball integrity 校验继续生效。`LIMINA_RELEASE_REGISTRY` 会报告 authority 无效、tarball URL 不允许、metadata/tarball 超限等结构化原因，并包含字节上限及可用的实际读取字节数。

这些上限约束下载响应体，不代表 tar 归档解压后的内容大小或进程总内存上限。下载体积未超限的 tarball，解压后仍可能很大。

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

每条 importer → dependency 边都会独立求值 baseline 与 ignore 策略，包括经由多个 importer 到达的共享依赖。包级访问记录只限制递归遍历，不会把首个 importer 的策略结果复用于后续边。

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
