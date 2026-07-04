# 核心概念

Limina 的概念可以从一条主线理解：先确定哪些 `tsconfig` 进入治理范围，再根据源码导入和模块解析结果生成声明构建图，最后把源码依赖、产物依赖和包边界放在同一套检查流程里验证。

它不替代 TypeScript、框架检查器、打包器、测试框架或包管理器。Limina 负责把这些工具已经依赖的配置关系显式化，并报告源码、配置和包边界之间不一致的地方。

## 检查器入口

[检查器入口](./config/checkers.md)用来告诉 Limina：哪些源码 `tsconfig.json` 应该交给哪个检查器处理。

省略 `config.checkers` 时，Limina 会使用默认的 auto 模式。auto 模式会发现普通 `tsconfig.json`，根据源码文件能力在 `tsc` 和 `vue-tsc` 之间选择合适的检查器。需要使用 `tsgo`、`vue-tsgo`、`svelte-check`，或者需要明确控制入口范围时，再改用显式检查器配置。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        include: ['tsconfig.json', 'packages/**/tsconfig.json'],
        exclude: ['**/docs/**'],
      },
      vue: {
        preset: 'vue-tsc',
        include: ['packages/app/tsconfig.json'],
      },
    },
  },
});
```

`include` 和 `exclude` 匹配的是工作区根目录下的入口 `tsconfig.json`。不要把 `tsconfig.lib.json`、`tsconfig.test.json`、`tsconfig.build.json` 或 `.limina` 下的生成配置直接写进 `checker.include`。这些非入口源码配置只有在被已选中的 `tsconfig.json` 通过 `references` 触达时，才会进入 Limina 的检查范围。

检查器预设的能力不同：

- `tsc`、`tsgo` 和 `vue-tsc` 是构建类预设，可以执行 Limina 生成的声明构建入口；
- `vue-tsgo` 作为 Vue 类型检查执行器使用，选中的源码仍可参与 Limina 图检查和覆盖证明，但不会作为增量声明构建预设运行；
- `svelte-check` 以类型检查执行为主，不提供 TypeScript 项目引用式的声明构建语义。

这个区分会影响后续命令。`limina checker build` 只能使用构建类预设；只被类型检查类预设覆盖的源码配置不能作为声明构建目标。

## 源码配置

源码配置是用户维护的 `tsconfig*.json`。它决定源码文件集合和类型检查语义，例如 `lib`、`types`、`jsx`、`paths`、`customConditions` 和框架相关设置。

常见结构如下：

```text
packages/core/tsconfig.json
packages/core/tsconfig.lib.json
packages/core/tsconfig.test.json
packages/core/tsconfig.tools.json
```

在 Limina 的模型里，`tsconfig.json` 通常作为入口或聚合器存在；`tsconfig.lib.json`、`tsconfig.test.json`、`tsconfig.tools.json` 这类配置通常是源码叶子配置。源码叶子配置应该描述自己拥有的源码文件，不应该手工维护 `references`。Limina 会根据静态导入和 `liminaOptions.implicitRefs` 推导声明构建引用。

如果某条边来自动态导入、生成代码、虚拟模块或其他静态导入分析看不到的关系，可以在源码叶子配置里声明 `liminaOptions.implicitRefs`：

```jsonc
{
  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../contracts/tsconfig.lib.json",
        "reason": "runtime schema generation imports this project through generated code",
      },
    ],
  },
}
```

`implicitRefs` 的 `path` 必须指向同一检查器可达范围内的普通源码 `tsconfig*.json`，不能指向 `.limina` 生成配置、构建配置、基础配置或自身。

## 聚合器配置

聚合器是只包含 `files: []` 和 `references` 的 `tsconfig`。它不拥有源码文件，只负责把多个源码配置组合成一个入口。

```jsonc
{
  "files": [],
  "references": [{ "path": "./tsconfig.lib.json" }, { "path": "./tsconfig.test.json" }],
}
```

Limina 允许默认入口 `tsconfig.json` 作为聚合器。运行 `limina graph prepare` 时，Limina 会从检查器入口出发，沿着这些 `references` 展开源码配置，并在 `.limina/` 下生成检查器实际消费的构建图。

不要把聚合器当成源码拥有者。需要区分不同运行环境、测试范围或构建目标时，应让聚合器引用多个源码叶子配置，而不是让一个配置同时承担聚合和源码归属两种职责。

## 声明构建配置

声明构建配置是 Limina 生成给构建类检查器使用的内部 `tsconfig`。它们位于：

```text
.limina/tsconfig/checkers/<checker>/projects/.../*.dts.json
.limina/tsconfig/checkers/<checker>/solutions/.../tsconfig.build.json
.limina/tsconfig/checkers/<checker>/tsconfig.build.json
```

项目级声明构建配置会 `extends` 对应的源码配置，并写入明确的 `files`、`compilerOptions`、`references` 和 `liminaOptions`。其中关键选项包括：

```jsonc
{
  "compilerOptions": {
    "composite": true,
    "incremental": true,
    "noEmit": false,
    "declaration": true,
    "emitDeclarationOnly": true,
    "declarationMap": false,
    "rootDir": "...",
    "outDir": "...",
    "tsBuildInfoFile": "...",
  },
  "liminaOptions": {
    "generated": true,
    "checker": "typescript",
    "sourceConfig": "...",
  },
}
```

声明文件会写到 `.limina/dts/checkers/<checker>/...`，构建缓存会写到 `.limina/tsbuildinfo/checkers/<checker>/...`。这些路径属于 Limina 的内部输出，不应该手工编辑，也不应该写进用户维护的源码配置。

生成的 `references` 来自两类事实：源码导入经过 TypeScript 解析后落到 Limina 管理的源码提供者，或源码配置显式声明了 `liminaOptions.implicitRefs`。如果导入解析到 `.d.ts` 系列声明文件，Limina 会把它视为声明消费，而不是源码项目引用。

## 用户产物构建配置

声明构建配置只用于 Limina 内部的检查器构建，不等同于用户发布到 `dist` 的产物。

需要通过 Limina 执行用户侧产物构建时，应在源码叶子配置上声明 `liminaOptions.outputs`，再运行：

```sh
pnpm exec limina build packages/core/tsconfig.lib.json
```

`liminaOptions.outputs` 支持 `target`、`rootDir`、`outDir` 和 `declarationMap`。路径字段相对声明它们的源码配置解析；没有显式设置时，`outDir` 默认指向该配置目录下的 `dist`，`target` 会优先继承源码配置中的 `compilerOptions.target`，否则使用 `ESNext`，`declarationMap` 默认是 `false`。

```jsonc
{
  "liminaOptions": {
    "outputs": {
      "rootDir": "src",
      "outDir": "dist",
      "declarationMap": true,
    },
  },
}
```

Limina 会在 `.limina/tsconfig/checkers/<checker>/outputs/...` 下生成输出构建配置，并用构建类检查器执行它。输出构建缓存会写到 `.limina/tsbuildinfo/build/...`，并由 Limina 管理。没有声明 `liminaOptions.outputs` 的源码配置不能作为 `limina build <config>` 的受管产物构建目标；如果只是想直接调用检查器构建某个原始配置，应使用 `limina build <config> --raw --preset <tsc|tsgo|vue-tsc>`。

## 源码边、声明边与产物边

一条 `import` 不一定等于一条 `references`。Limina 会先看这条导入在当前源码配置和检查器语义下解析到哪里，再决定它属于哪类关系。

如果 TypeScript 解析结果落到 Limina 管理的源码文件，这条导入会形成源码边，声明构建图需要引用目标源码配置对应的生成声明配置。对于工作区包导入，这通常意味着导入方包也应该在 `package.json` 的依赖字段里声明目标包。

如果 TypeScript 解析结果落到 `.d.ts`、`.d.mts` 或 `.d.cts`，这条导入已经在消费声明文件，不需要再生成源码项目引用。

如果跨包导入解析到目标包的 `dist` 目录，`limina graph export` 会把它归类为产物边。产物边说明当前源码消费的是构建产物，而不是 Limina 管理的源码图。它不应该被伪装成源码 `references`。

对于声明了 `exports` 的工作区包，Limina 会按相关源码配置的解析条件检查公开入口。受治理源码通过包导入访问这些入口时，TypeScript 应该能解析到稳定的类型入口或检查器支持的源码入口。如果只能解析到运行时 JavaScript，或者 TypeScript / Oxc 无法解析该导出，图检查会报告问题。

## 依赖图导出

`limina graph export` 会以 JSON 导出包节点和跨包边：

```sh
pnpm exec limina graph export --view all
```

可选视图包括：

- `--view source`：只导出源码边；
- `--view artifact`：只导出产物边；
- `--view all`：同时导出两类边。

导出结果用于观察 Limina 当前能证明的包级依赖事实。它不是构建系统的任务图，也不是包管理器的依赖清单，更不是构建顺序来源。构建顺序仍由 TypeScript 项目引用图和具体执行器决定；包发布产物仍需要由构建、测试、包检查和发布流程共同维护。

## 标签与图规则

源码配置可以通过 `liminaOptions.graphRules` 绑定一组图规则标签。Limina 会把这些标签带到对应的生成声明配置上，并在图检查时使用它们判断哪些引用或依赖不允许出现。

```jsonc
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
}
```

规则在 `limina.config.ts` 中声明：

```js
import { defineConfig } from 'limina';

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

`deny.refs` 用来禁止项目引用指向某些源码配置，`deny.deps` 用来禁止源码导入某些包、`#imports` 或 Node 内置模块。`allow.refs` 只解释已经存在的额外引用，不会创建引用，也不会覆盖 `deny.refs`。

图规则适合表达浏览器与 Node、公开 API 与内部工具、生产代码与测试代码这类边界。Limina 会把规则、源码导入和生成声明图一起检查；如果带有 `runtime-client` 标签的源码导入了 `node:fs`，图检查会失败，并显示规则里的 `reason`。
