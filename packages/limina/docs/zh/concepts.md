# 核心概念

Limina 使用 TypeScript 的一些概念，但模型并不大。最重要的一点是：让“源码实际 import 了什么”、“TypeScript 构建了什么”、“package 发布了什么”保持一致。

## Checker entry

Checker entry 是 Limina 开始检查的根配置。

```js
export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: 'tsconfig.build.json',
      },
    },
  },
});
```

对 TypeScript 来说，它通常是一个 build graph 聚合器，通过 `references` 指向声明 project。Limina 会沿着这个图发现应该检查的目标。

对框架文件来说，checker entry 可以使用 `vue-tsc` 或 `svelte-check`。这些 checker 负责普通 `tsc` 无法独立理解的文件。

只要你希望 Limina 检查某一类源码，就需要在 `limina.config.mjs` 中给它一个 checker entry。普通 TypeScript package 通常指向根 `tsconfig.build.json`；Vue 或 Svelte 项目则增加对应框架 checker。后续的 graph、proof、paths 和 checker 命令都会从这些 entry 出发，所以 entry 本质上决定了“哪些项目应该进入治理范围”。

## Declaration leaf

Declaration leaf 是一个 `tsconfig*.dts.json` project。它是能被 `tsc -b` 消费的图节点。

它应该只输出声明文件，并带有 build-mode 需要的选项：

```jsonc
{
  "compilerOptions": {
    "composite": true,
    "incremental": true,
    "noEmit": false,
    "declaration": true,
    "emitDeclarationOnly": true,
    "rootDir": "src",
    "outDir": "./.tsbuild",
    "tsBuildInfoFile": "./.tsbuild/lib.tsbuildinfo",
  },
}
```

Declaration leaf 负责图结构。它说明这个 project reference 了哪些其他 declaration leaf。

当一个 package 或一个 package 内的某个环境需要进入 `tsc -b` 图时，就给它一个 declaration leaf。例如 `packages/core/tsconfig.lib.dts.json` 可以表示 `@acme/core` 的库源码边界。这样“这个项目依赖谁”会变成 TypeScript 可检查的 reference 图；`@acme/app` import `@acme/core` 时，Limina 就能检查 `app` 的 leaf 是否 reference 了 `core` 的 leaf。

## Local companion

每个 declaration leaf 都应该有一个普通 typecheck companion：

```text
tsconfig.lib.dts.json    <->    tsconfig.lib.json
tsconfig.tools.dts.json  <->    tsconfig.tools.json
tsconfig.test.dts.json   <->    tsconfig.test.json
```

Companion 负责严格 typecheck 语义，例如 `strict`、`lib`、`types`、`jsx` 和框架设置。Proof check 会验证 declaration leaf 与 companion 的文件集和类型检查相关 compilerOptions 保持一致；checker build 则通过 `tsc -b` 或 `vue-tsc -b` 运行一等公民 entry。

这样可以把构建输出设置和普通类型检查设置分开。

实践中可以让 declaration leaf 只负责可构建的声明输出，把日常开发需要的严格类型检查语义放在 local companion 里。比如 `tsconfig.lib.dts.json` 只关心 declaration emit，而 `tsconfig.lib.json` 可以包含 `strict`、DOM lib、测试 types 或 JSX 设置。Limina 会证明二者语义一致，而不是额外运行 companion no-emit pass，这样既能保持 `tsc -b` 图干净，又不会牺牲普通源码检查的严格程度。

## Aggregator config

Aggregator 是只包含 `files: []` 和 `references` 的 tsconfig。它只负责聚合其他 project，不拥有源码文件。

Limina 期望 `tsconfig.build.json` 这类 build graph config 是纯 aggregator。如果默认 `tsconfig.json` 带有 `references`，Limina 也期望它是纯 IDE/typecheck aggregator。

如果一个目录只是负责把多个 leaf 组合起来，就让它保持 aggregator 角色。例如根 `tsconfig.build.json` reference 所有 package 的 `tsconfig*.dts.json`，但自己不包含源码。这样 graph 的入口和实际 leaf 边界更容易审查，Proof check 也能发现“一个 config 同时聚合项目又包含源码”的含糊写法。

## Source dependency

用 `workspace:*` 声明的依赖是 source dependency。它表示这个 workspace package 应该通过 project references 和源码解析来表达。

如果 TypeScript 把一个 `workspace:*` import 解析到了 `dist`，Limina 会报错。你可以让 exports 暴露源码入口，移除这条源码图边，或生成显式 compatibility paths。

当 `@acme/app` 的 `package.json` 写了 `"@acme/core": "workspace:*"`，这条边就表示 app 应该按源码依赖 core，因此也应该配套 project reference 和源码可解析入口。Limina 会防止这类源码依赖悄悄绕到 `dist`。如果短期内必须保留 artifact-facing exports，可以用 `limina paths generate` 生成显式兼容 paths，再把 generated config 放到相关 declaration leaf 的 `extends` 第一项。

## Artifact dependency

用 `link:`、`file:`、`catalog:` 或普通 semver 声明的依赖会被视为 artifact dependency。它通常不应该再建模成源码 project reference。

Artifact dependency 应该在 package output 层检查，而不是假装它的源码属于当前图。

如果某个 package 只是想像外部消费者一样使用一个已经构建好的包，就应该把它当作 artifact dependency。例如某个工具 package 通过普通 semver 使用 `@acme/core` 的发布产物，而不是参与 core 的源码构建图。这样源码 graph 不会被不必要的 reference 拉大，发布产物问题则交给 `limina package check` 在 output 层处理。

## Labels 和 rules

Declaration leaf 可以用 `limina` label 启用某条 graph rule：

```jsonc
{
  "limina": "runtime-client",
}
```

对应的 `graph.rules.runtime-client` 可以禁止 reference 或 dependency：

```js
export default defineConfig({
  graph: {
    rules: {
      'runtime-client': {
        deny: {
          deps: [
            {
              name: 'node:*',
              reason: 'browser runtime must not import Node builtins',
            },
          ],
        },
      },
    },
  },
});
```

适合用 label 表达重要架构边界，例如 browser vs Node、public API vs internal tools、production vs tests，或某个 package 自己的规则。

当一组源码有明确边界时，可以在对应 `tsconfig*.dts.json` 写 label，并在 `limina.config.mjs` 中写规则。例如 browser runtime leaf 写 `"limina": "runtime-client"`，规则里禁止 `node:*` 和 `@acme/internal-node`。边界就不再只靠约定；只要有人在 browser 项目里 import `node:fs`，Graph check 会直接失败，并显示规则里的 reason。
