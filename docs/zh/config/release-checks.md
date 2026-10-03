# 发布检查

`limina release check` 根据 `package.entries` 选择输出，生成 npm 打包文件，检查发布文件，并根据 npm 注册表内容校验工作区发布依赖的一致性。它与 `package check` 分别运行。

内置发布检查属于此命令，不需要启用可选分析器。输出清单无效或标记为私有包（`private: true`）等早期失败，可能使该条目在打包与后续检查前停止。可选的 `release.npmPackageJsonLint` 集成会额外使用 `npm-package-json-lint` 检查打包后的 `package.json`。

对于工作区发布依赖，Limina 会把本地打包内容与 npm 发布标签基线（`release.contentHash.baselineTag`，默认 `latest`）比较，报告 `changed`（已更改）、`local-only`（仅本地存在）、`remote-only`（仅远程存在）文件。按配置忽略后内容相同，只表示该次比较没有内容差异诊断；其余发布检查仍适用。

只有输出清单的 `name` 命中具有名称的激活源码包时，才启动工作区遍历。它读取该源码所属包清单的 `dependencies`、`optionalDependencies` 与 `peerDependencies` 中的 `workspace:` 依赖，并拒绝 `link:` 条目。普通语义化版本依赖不会仅因本地存在同名包而被遍历。未命中源码包时，发布文件与清单检查仍执行，但不遍历工作区依赖。每个依赖的比较使用首个与源码包名称相同的配置输出条目；没有条目时使用 `<source-package>/dist`，不会逐一比较全部同名依赖输出。

在解包或比较注册表基线的打包文件之前，Limina 会先使用 `dist.integrity` 校验它；若该字段缺失，则回退使用 SHA-1 `dist.shasum`。完整性校验元数据缺失、格式错误或摘要不匹配都会让 `release check` 失败，且不能跳过这项校验。

::: warning 发布文件要求
发布检查会拒绝私有输出（`private: true`）、缺失 `README.md` 或 `LICENSE.md`、源码映射文件（`.map`）、JavaScript 中的 `sourceMappingURL` 注释，以及不覆盖本地工作区版本的发布依赖范围。
:::

依赖范围遵循常规语义化版本预发布规则：`^1.0.0` 不接受 `1.1.0-beta.1`，而 `^1.1.0-beta.0` 显式接受该预发布系列。这适用于 `dependencies`、`optionalDependencies` 与 `peerDependencies`；本地工作区成员身份不会扩大打包后消费者的版本范围。

源码映射指令检查依据 JavaScript 解析上下文识别真实的行注释和块注释，包括模板插值与正则表达式附近的注释。字符串、模板字面量或正则中的类似指令文本不算指令。无法可靠解析的 JavaScript 会导致发布检查失败，并报告对应文件及解析诊断。

::: warning 本地依赖泄漏
发布检查会拒绝输出清单和打包清单所有依赖区间里泄露的 `workspace:`、`link:`、`file:`、`catalog:`。
:::

::: tip 选择条目
没有 `--package` 时，`limina release check` 通过已验证的激活包索引解析当前工作目录，并要求该目录所属包的 `name` 命中配置条目。附近未激活的包清单不能选择条目。传入一个或多个 `--package <name>` 可跳过当前工作目录匹配，并选择每个名称的全部条目。
:::

## 注册表信任范围与响应体限制 {#registry-authority-与响应体限制}

发布检查的注册表请求必须属于当前生效的注册表信任范围；默认使用 npm 官方注册表（`https://registry.npmjs.org/`）。企业注册表与镜像注册表的元数据和打包文件使用同一 HTTPS 源时受支持。

Limina 在每次发布检查调用中创建一份注册表配置快照，以命令的有效工作目录定位 npm 项目或工作区的 `.npmrc`，不会从待比较的输出目录读取配置。同名键按环境变量、项目 npmrc、用户 npmrc、全局 npmrc 的顺序确定优先级。支持大小写 npm 配置环境变量；两种写法同时存在时，小写优先。`NPM_CONFIG_USERCONFIG` 与 `NPM_CONFIG_GLOBALCONFIG` 可指定对应配置文件。npm 的 `ini` 解析器处理 npmrc 引号与注释，注册表设置支持 `${ENV_VAR}` 插值。插值变量缺失、配置不可读、显式指定的配置文件不存在或所选注册表 URL 无效时，检查失败。

完成同名键合并后，优先使用依赖包匹配的 `@scope:registry`，再使用通用 `registry`。因此，通用 `NPM_CONFIG_REGISTRY` 不会覆盖不同键名的作用域注册表设置。两个键均不存在时，使用 npm 官方默认地址。注册表的路径前缀会被保留，例如 `https://packages.example.com/npm/team/`。

```ini
registry=https://packages.example.com/npm/default/
@team:registry=https://packages.example.com/npm/team/
```

注册表和打包文件 URL 必须是绝对 HTTPS URL，且不得包含凭据、查询参数或片段。打包文件必须与所选注册表同源（协议、主机与有效端口相同）。显式配置的企业内部 HTTPS 注册表可以成为受信任的请求来源。元数据与打包文件请求都拒绝所有重定向，包括同源重定向。跨源 CDN 打包文件、带签名查询参数的 URL 和 HTTP 注册表不在允许范围内。注册表选择能力不包括 `.npmrc` 认证、自定义 CA 或代理配置支持。

元数据响应体上限为 **16 MiB**，打包文件响应体上限为 **128 MiB**。Limina 在 `Content-Length` 有效时检查声明长度，同时累计 HTTP 内容解码后响应流的实际字节数；超限后立即取消读取，不进入解析或完整性校验。限制同样适用于分块传输与 HTTP 压缩响应，恰好达到上限的响应仍可接受。原有超时与打包文件完整性校验继续生效。`LIMINA_RELEASE_REGISTRY` 会报告注册表信任范围无效、打包文件 URL 不允许、元数据或打包文件超限等结构化原因，并包含字节上限及可用的实际读取字节数。

这些上限约束下载响应体，不代表 tar 归档解压后的内容大小或进程总内存上限。下载体积未超限的打包文件，解压后仍可能很大。

## `npmPackageJsonLint`

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

## `contentHash.baselineTag`

- **类型：** `string | ((args: { importerName: string; dependencyName: string }) => string)`
- **默认值：** `'latest'`

`contentHash.baselineTag` 是对比依赖包输出时作为线上基线的 npm 发布标签。传入函数可以按引用方与依赖包的组合返回不同的基线。

每条引用方到依赖包的边都独立求值基线与忽略策略，包括多个引用方触达的共享依赖。包级已访问状态仅限制递归，不把首个引用方的策略复用于后续边。基线必须同步返回非空字符串，非法回调结果会报告失败。注册表元数据在单个所选条目的一致性检查状态中，按注册表基础 URL 与包名缓存；这不会跨边复用策略决定，也不是持久缓存。

## `contentHash.builtinIgnore`

- **类型：** `boolean`
- **默认值：** `false`

默认 `contentHash.builtinIgnore` 是 `false`，不忽略任何内置文件。开启时，内置集合包含根目录下精确名称 `README`、`README.md`、`CHANGELOG.md`、`HISTORY.md`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`，以及 `docs/` 和 `examples/` 下的路径；其他大小写或位置不会自动加入。

设置 `builtinIgnore: true` 后，内置忽略集只会在 `release.contentHash.ignore` 未配置或忽略函数返回 `undefined` 时作为默认忽略集。

::: info 说明
忽略函数返回 `[]` 表示该依赖包不忽略任何文件（不应用内置集）；返回 `undefined` 才会回退到内置集。
:::

## `contentHash.ignore`

- **类型：** `string[] | ((args: { importerName: string; dependencyName: string }) => string[] | undefined)`

`contentHash.ignore` 可以是包相对通配模式数组，例如 `client/**` 或 `dist/*.wasm`，也可以写成函数并按引用方与依赖包的名称返回通配模式数组。

被忽略的报告会按命中的规则分组，并统计 `changed`、`local-only`、`remote-only` 三类数量。

::: info `[]` 与 `undefined`
对于函数形式，返回 `[]` 表示该依赖包不忽略任何文件，而返回 `undefined` 会在 `builtinIgnore: true` 时回退到内置忽略集。
:::
