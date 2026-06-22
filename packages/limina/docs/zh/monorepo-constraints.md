# Limina 会约束 monorepo 里的关键关系

Limina 不要求每个 monorepo 都长成同一种目录结构。它真正约束的是那些最容易在大型 TypeScript 工作区里漂移的关系：文件归谁管、包之间怎么访问、公开入口能不能解析、类型关系是否来自真实导入、构建产物是否仍然像一个可安装的包。

> 只要某条关系会影响别的包、类型图、产物消费或发布结果，Limina 就会要求它写清楚，并且和真实源码对得上。

可以把这些约束理解成一条链：

```text
源码文件
  │ 属于哪个 package.json
  ▼
源码导入
  │ 是否被依赖声明和 exports 承认
  ▼
类型图
  │ 是否由真实 import 推导
  ▼
构建产物
  │ 是否形成限定的架构事实
  ▼
发布包
    是否能被消费者正确安装和解析
```

## 文件必须有清楚的包归属

Limina 用 pnpm workspace package 判断一个文件属于哪个 source owner。没有 `name` 的 workspace package 也可以用路径成为 source owner；普通嵌套 `package.json` 只影响 package resolution，不会自动切分 source owner。被检查的源码文件不能没有 source owner，一个普通源码 `tsconfig*.json` 也不能同时覆盖多个 source owner 的文件。

```text
packages/
  app/
    package.json
    tsconfig.lib.json
    src/main.ts
  ui/
    package.json
    src/Button.ts
```

如果 `packages/app/tsconfig.lib.json` 把 `packages/ui/src/Button.ts` 也 include 进来，Limina 会认为这个类型检查单元跨过了包边界。修复方式通常不是给诊断“消音”，而是让 `app` 通过包名依赖 `ui`，让 `ui` 自己的配置负责自己的源码。

默认的 `tsconfig.json` 也有形状约束：如果它带 `references`，它应该只做聚合入口，保留 `files: []` 和 `references`，把源码输入和编译选项放到具体的叶子配置里。普通源码配置不应该手写 `references`；静态边由 Limina 从真实 import 推导，静态分析看不到的动态或虚拟边写在 `liminaOptions.implicitRefs`。一个目录里有多套类型环境时，默认 `tsconfig.json` 应该能把它们聚合起来；只有一套环境时，默认 `tsconfig.json` 就应该直接代表这套环境。

## 跨包访问必须走公开入口

跨包相对导入是 Limina 明确拒绝的模式：

```ts
import { Button } from '../../ui/src/Button';
```

这段代码绕过了 `ui` 的公开 API，也绕过了 `app` 的依赖声明。更稳定的写法是：

```json [packages/app/package.json]
{
  "dependencies": {
    "@acme/ui": "workspace:*"
  }
}
```

```ts
import { Button } from '@acme/ui';
```

相对导入必须留在最近 `package.json` 形成的 package scope 内。裸包导入也必须被最近的 pnpm workspace source owner 承认。也就是说，源码里 import 了 `p-map`，当前 source owner 的 `dependencies`、`devDependencies`、`peerDependencies` 或 `optionalDependencies` 至少要有一处声明它。匹配的 `source.importAuthority.allow` package rule 可以把 workspace root `package.json` 加为第二个声明候选；项目模板、文档别名等由别处提供依赖的场景，可以用 specifier rule 说明。包自身导入和 Node 内置模块不按普通外部依赖处理。

`#imports` 也遵守同样的边界：`#utils/foo` 必须匹配当前 source owner 自己的 `package.json#imports`，解析结果也必须留在当前 source owner 内，或者落到一个已经声明的外部产物包里。

## 公开导出必须真的可解析

在 monorepo 里，`workspace:*` 只说明依赖来自工作区，不说明导入会读源码还是读产物。真正决定入口的是被依赖包的 `exports`。

```json [packages/core/package.json]
{
  "name": "@acme/core",
  "exports": {
    ".": "./src/index.ts",
    "./runtime": {
      "types": "./dist/runtime.d.ts",
      "import": "./dist/runtime.js"
    }
  }
}
```

Limina 会检查这些公开入口能不能在类型解析和运行时解析里成立。类型侧不能只解析到运行时 JavaScript；运行时侧也不能完全解析失败。纯类型入口可以只提供稳定的声明文件，源码入口可以指向检查器支持的源码文件。

这条约束的意思是：包既然把某个子路径公开给别的包使用，就不能只在某个工具的幸运路径里可用。它必须在 monorepo 的类型世界和消费者运行时世界里都能解释清楚。

## 类型关系必须来自真实导入

Limina 会根据源码里的真实 import 管理类型图。一个包导入了另一个包的源码入口，类型图里就应该有对应关系；没有真实导入的关系，也不应该长期留在图里。

```ts
// packages/app/src/main.ts
import { createClient } from '@acme/core';
```

如果这个入口解析到 `core` 的源码，Limina 会把它视为源码层依赖。相反，如果入口解析到 `core` 的构建产物，Limina 不会把它当成源码项目引用，而是把这条产物消费关系导出为受导入方 tsconfig 域限定的 artifact 边。

这能避免两类常见问题：代码已经依赖上游源码，但类型图没有承认；或者类型图里存在没有真实 import 支撑的关系。确实存在静态分析看不到的源码边时，`implicitRefs` 必须带上原因，让这条例外可审计。

## 运行时边界必须落到真实导入

有些架构约束不是包名能表达的，比如浏览器代码不能导入 Node 内置模块，公共 API 不能访问内部实现，插件运行时不能依赖 CLI 代码。Limina 允许你把这些边界写成图规则，然后用真实 import 去验证。

```jsonc [packages/app/src/client/tsconfig.json]
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "include": ["./**/*.ts"],
}
```

```js [limina.config.mjs]
export default defineConfig({
  graph: {
    rules: {
      'runtime-client': {
        deny: {
          deps: [
            {
              name: 'node:*',
              reason: 'client runtime must stay free of Node builtin imports',
            },
          ],
        },
      },
    },
  },
});
```

如果真实代码导入了 `node:fs`，Limina 会把它报告为运行时边界违规，而不是把它当成普通类型错误或代码风格问题。

## 声明了的工作区依赖应该能被使用路径证明

`package.json` 里声明了另一个工作区包，不代表这条依赖一定还需要保留。Limina 的源码检查会从包入口、bin、scripts 和显式配置的额外入口出发，判断工作区依赖是否能被触达。

```json [packages/app/package.json]
{
  "dependencies": {
    "@acme/core": "workspace:*",
    "@acme/unused": "workspace:*"
  }
}
```

如果 `@acme/unused` 没有从这些入口路径里被使用，Limina 会报告它是无用的工作区依赖。确实通过生成代码、运行时字符串或工具无法看见的路径使用时，可以给这条例外写明原因；否则更好的修复就是删除依赖。

## 产物关系是限定图事实

如果一个包消费的是另一个包的构建产物，Limina 可以在依赖图导出中展示这段关系。它会从真实源码导入和模块解析结果推导 artifact 边：只有导入实际解析到对方公开的产物入口，这条边才会进入依赖图导出。

```ts
import { runtimeValue } from '@acme/core/runtime';
```

如果 `@acme/core/runtime` 解析到 `core/dist`，`limina graph export --view artifact` 会导出从消费方到 `core` 的 artifact 边。

这条边受导入方项目的 compiler options 限定，包括 `compilerOptions.customConditions`。它适合用于架构审查和诊断，不是权威任务图，也不应该被当作构建调度正确性的证明。

## 发布包必须站在消费者视角成立

源码检查通过，不代表发布包一定可用。Limina 的包检查会看构建后的 `outDir`：`exports` 指向的文件是否存在，类型入口是否能解析，浏览器产物是否误导入 Node 能力，输出 JS 是否导入了未声明的外部包，包内自引用是否访问了没有公开的入口。

发布检查会再往前走一步：把包打成 npm tarball，从消费者真正安装到的内容里检查 `package.json`、README/license、source map、`sourceMappingURL`，以及工作区发布依赖是否已经在 registry 上有可匹配的版本和内容。

这条约束很朴素：仓库内部能跑，不等于用户安装后也能用。Limina 要求发布出来的包继续兑现源码和包配置里表达的关系。

## 一眼看懂这些约束

| Limina 约束什么       | 它防止什么问题                         |
| --------------------- | -------------------------------------- |
| 文件只能有清楚包归属  | 一个 tsconfig 混进多个包的源码         |
| 跨包访问走公开入口    | 相对路径绕过依赖声明和 exports         |
| 裸包导入必须声明依赖  | 代码用了包，但清单没有承认             |
| 公开导出必须可解析    | 子路径暴露出去却无法被类型或运行时使用 |
| 类型图来自真实 import | 缺失引用、无用引用和过期关系           |
| 图规则命中真实导入    | 浏览器、公共 API、运行时边界失守       |
| 工作区依赖要可达      | `package.json` 留下无用依赖            |
| 产物边要能导出        | 产物消费关系难以审查                   |
| 发布包要可安装        | 源码健康，但消费者安装后坏掉           |

这些约束合在一起，就是 Limina 对 monorepo 的基本态度：代码可以自由组织，但跨包关系必须清楚；配置可以分层，但每层都要说同一件事；包可以在工作区内协作，但发布给用户时仍然要像一个完整、可靠的 npm 包。
