# limina 眼中的健康 monorepo

## limina 和 Nx / Turborepo 的区别

`limina` 和 Nx、Turborepo 都属于 monorepo tooling，但它们解决的问题层级不同。

Nx / Turborepo 主要解决的是 **任务执行层** 问题：在一个 monorepo 里，哪些项目需要执行任务、任务之间有什么顺序、哪些任务可以并行、哪些结果可以缓存、CI 怎样跑得更快。Nx 官方文档把它的任务能力概括为：并行运行多个项目的多个 target、定义 task pipeline、只运行受变更影响的项目，并通过缓存加速任务执行。 Turborepo 也明确把重点放在自动并行化、缓存任务、按目录 / package / source-control changes 过滤任务上。

`limina` 解决的是 **架构一致性层** 问题：这些任务运行之前，仓库结构本身是否可信。

换句话说：

```text
Nx / Turborepo:
  这个 monorepo 里，应该跑哪些任务？怎样更快地跑？

limina:
  这个 monorepo 的 TypeScript 源码图、package 依赖图、project references、
  package exports、运行时边界和发布产物是否表达了同一个事实？
```

举个例子，假设 `packages/app` 依赖 `packages/core`：

```json
{
  "dependencies": {
    "@acme/core": "workspace:*"
  }
}
```

Nx / Turborepo 可以帮你决定：

```text
app build 之前是否要先跑 @acme/core 的 build？
app test 是否受 @acme/core 变更影响？
@acme/core build 的结果能否复用缓存？
```

这类能力非常重要。Nx 文档也说明，Nx 会根据项目依赖和 task pipeline configuration 保证任务以正确顺序并行执行。Turborepo 的缓存机制则会基于任务输入生成 fingerprint，并在命中缓存时恢复任务输出。

但这些工具通常不会替你回答下面这些问题：

```text
@acme/core 被声明为 workspace:*，它是否真的被当作源码依赖消费？
TypeScript 是否解析到了 packages/core/src/index.ts？
还是解析到了 packages/core/dist/index.d.ts？

app 的 tsconfig 是否 reference 了 @acme/core 的 declaration leaf？
@acme/core 的 tsconfig.lib.dts.json 是否有严格的 tsconfig.lib.json companion？
app 是否绕过 package exports，用 ../../core/src 直接穿透了包边界？
@acme/core 的 dist/package.json 对消费者是否真的可用？
```

这些就是 limina 关心的问题。

因此，更准确的定位是：

```text
Nx / Turborepo 是 monorepo task orchestration layer。
limina 是 TypeScript monorepo architecture conformance layer。
```

二者不是互斥关系。一个项目可以同时使用 Nx / Turborepo 和 limina：

```json [package.json]
{
  "scripts": {
    "build": "turbo build",
    "test": "turbo test",
    "typecheck": "limina check typecheck",
    "prepublishOnly": "limina check publish"
  }
}
```

在这种组合里：

```text
Nx / Turborepo 负责：
  - 任务编排
  - affected execution
  - 并行执行
  - 本地 / 远程缓存
  - CI 加速

limina 负责：
  - workspace:* 是否真的表示源码依赖
  - package imports 是否被最近的 package.json 授权
  - project references 是否匹配真实 import
  - tsconfig*.dts.json 是否有严格 companion
  - source files 是否被 checker 覆盖
  - client / shared / node runtime 边界是否被破坏
  - dist 发布产物是否对消费者可用
```

Nx 自身也提供 module boundary / conformance 能力，例如通过 project tags 声明项目之间的依赖约束，并用 ESLint rule 或 Nx Conformance 检查边界。([Nx][4]) limina 和这类能力的区别在于：limina 的规则不是通用 tag-level project dependency policy，而是专门针对 **pnpm + TypeScript package monorepo** 的结构一致性问题，包括 `workspace:*` 协议语义、TypeScript declaration graph、local typecheck companion、package exports 到源码图的解析、以及发布产物边界。

所以可以这样理解：

```text id="fy541j"
Nx 的 module boundary 更像：
  “带有 tag A 的项目能不能依赖带有 tag B 的项目？”

limina 更像：
  “这个 dependency 在 package.json、tsconfig references、TypeScript module resolution、
   source file ownership 和 dist package exports 中是否一致？”
```

这也是为什么 limina 不应该被描述成“不是构建器，也不是 tsc 替代品”。更合适的说法是：

> limina 是面向 pnpm + TypeScript monorepo 的 architecture conformance 工具。它补充 Nx / Turborepo 这类任务执行层工具，专门检查 monorepo 结构是否健康、可证明、可发布。

---

## 为什么 monorepo 需要 architecture conformance

monorepo 的复杂度并不只来自“项目很多”。真正危险的是：**同一份依赖关系会在多个系统里被重复表达**。

在一个 TypeScript package monorepo 中，至少有这些图同时存在：

```text id="ejf3wn"
pnpm workspace graph
package.json dependency graph
TypeScript project reference graph
TypeScript module resolution graph
package exports graph
source file ownership graph
runtime boundary graph
published artifact graph
```

只要这些图表达的事实不一致，仓库就会进入一种很危险的状态：本地能跑、CI 能过，但结构已经开始腐化。

### 场景一：package 图说“源码依赖”，TypeScript 却解析到产物

`package.json` 里写的是：

```json id="mx9jsq"
{
  "dependencies": {
    "@acme/core": "workspace:*"
  }
}
```

在 limina 的模型里，`workspace:*` 表示源码依赖。源码依赖应该进入 TypeScript project graph，由 project references 表达。

但 `@acme/core` 的 exports 可能是：

```json id="p18vyi"
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

于是 TypeScript 实际解析到了：

```text id="u68r4s"
packages/core/dist/index.d.ts
```

而不是：

```text id="jq12ya"
packages/core/src/index.ts
```

这时任务执行工具仍然可以正常跑 `build`、`test`、`typecheck`，甚至还能缓存结果。但 limina 会认为这个 monorepo 不健康：因为 `workspace:*` 声明的是 source dependency，而 TypeScript 实际使用的是 artifact dependency。limina 的 README 也明确区分了 source dependency 和 artifact dependency：`workspace:*` 被视为源码依赖，`link:`、`file:`、`catalog:` 或普通 semver 则被视为产物依赖。

这里需要的不是“更快地跑任务”，而是 architecture conformance：证明 `package.json`、project references 和 module resolution 对“这个依赖到底是源码还是产物”达成一致。

### 场景二：TypeScript project reference 图和真实 import 图不一致

假设 `app` 中有：

```ts id="pr21rt"
import { createClient } from '@acme/core';
```

但 `packages/app/tsconfig.lib.dts.json` 没有 reference `packages/core/tsconfig.lib.dts.json`。

TypeScript 有时仍然能通过，因为它可能通过 package exports、paths 或 node_modules 找到了类型文件。但从工程图角度看，这是不健康的：真实源码 import 产生了一个跨包依赖，而 project references 没有表达它。

limina 的 graph check 正是用来验证 project references 和真实 cross-project imports 是否一致；README 将其描述为检查 reachable TypeScript declaration leaves、references、graph-owned imports、package boundaries 和 label-based deny rules。

没有 conformance，这类问题通常只会在重构、增量构建、发布或消费者安装后暴露。

### 场景三：跨包相对路径 import 绕过了 package exports

代码里出现：

```ts id="o1q8q1"
import { createClient } from '../../core/src/client';
```

这在 monorepo 内通常能跑，但它绕过了 `@acme/core` 的 public exports，也绕过了 `packages/app/package.json` 中应该声明的依赖关系。

这类问题不是 task runner 能解决的。任务可以跑得很快，但跑得很快不代表结构正确。

limina 期待 workspace packages 通过 package exports 互相依赖，而不是通过相对路径穿透边界。它会把这种情况视为跨包边界违规。

### 场景四：声明文件被生成了，但源码没有被同等严格地检查

一个 `tsconfig.lib.dts.json` 可能能成功 emit `.d.ts`：

```jsonc id="trmq2d"
{
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "emitDeclarationOnly": true,
    "outDir": "dist",
  },
  "include": ["src/**/*.ts"],
}
```

但如果它没有对应的 `tsconfig.lib.json`，或者两个配置的文件集合 / strict 语义不一致，那么生成出来的 declaration 并不能证明源码经过了严格 typecheck。

limina 的文档模型要求 declaration leaves 有 strict local companions，例如 `tsconfig.lib.dts.json` 对应 `tsconfig.lib.json`，`tsconfig.dts.json` 对应 `tsconfig.json`。 这就是 conformance 的意义：不是只看“有没有产物”，而是证明“产物来自被正确检查的源码”。

### 场景五：CI 绿色，但有源码文件根本没被检查

monorepo 中经常会出现新增文件没有进入任何 `include`、没有进入任何 framework checker，也没有进入 declaration graph 的情况。

CI 绿色不代表它是对的，可能只是因为这个文件没有被任何任务看到。

limina 的 typecheck coverage proof 会验证 source boundary 中的文件是否被 checker entries 或 allowlist 覆盖。README 将这一点描述为：验证 reachable declaration leaves 是否匹配 strict local typecheck companions，并验证 source files 是否被 checker entries 或 allowlist 覆盖。

这就是 architecture conformance 和普通 task execution 的差异：

```text id="mzmtsn"
普通 typecheck:
  已经进入 tsconfig 的文件是否能通过？

architecture conformance:
  应该被检查的文件是否真的进入了某个 checker？
```

### 场景六：源码图健康，但发布包坏了

源码检查通过不等于 npm 消费者能正常使用。

例如：

```text id="tm0cmz"
packages/core/src/index.ts       正常
packages/core/dist/index.js      正常
packages/core/dist/package.json  exports / types 写错
```

这种问题不会被源码级 project graph 完整覆盖，因为消费者安装的是 `dist` 中的 package。

limina 因此把 source graph checks、package artifact checks 和 release hygiene checks 分开。README 也明确说，source graph checks 不证明 installed package 对消费者可用；`limina package check` 会检查 built package outputs 下的 manifest、exports、type resolution 和 runtime imports，而 `limina release check` 负责 npm tarball 卫生和发布依赖一致性。

这就是为什么发布前需要 `package:check` 和 `release:check`，而不是只跑 `typecheck`。

---

## architecture conformance 到底在保证什么

architecture conformance 的目标不是增加规则感，而是防止 monorepo 进入“多套事实并存”的状态。

一个健康的 pnpm + TypeScript monorepo 中，同一条依赖应该在多个层面一致：

```text id="h8idlj"
package.json:
  @acme/app depends on @acme/core via workspace:*

tsconfig references:
  app's declaration leaf references core's declaration leaf

TypeScript module resolution:
  @acme/core resolves to source graph owned files, not stale dist files

package exports:
  imports go through declared public entrypoints

source ownership:
  files stay inside their nearest package.json owner

runtime rules:
  client code does not import node:* or node-only projects

dist package:
  published package exports/types/runtime imports work for consumers
```

limina 的职责就是把这些一致性要求变成可执行检查。

顶层 `strict: true` 会要求 Limina 把这套模型当作必须满足的结构约束，而不是兼容性的提示行为。在这个模式下，普通 `tsconfig*.json` leaf 必须有同名 `tsconfig*.dts.json` build leaf；源码归属必须落到 nearest `package.json`；`workspace:` 包的 exports 必须接入源码图；`link:`/artifact 依赖不能继续保留跨包 project reference；构建后或打包后的 manifest 必须已经是合法 npm package manifest，不能残留 pnpm 本地依赖协议。

可以把它理解成下面这个公式：

```text id="dk29fb"
task runner answers:
  Can we run this efficiently?

architecture conformance answers:
  Is the thing we are running structurally meaningful and safe?
```

所以，monorepo 需要 architecture conformance，不是因为 `tsc` 不够好，也不是因为 Nx / Turborepo 不够强，而是因为大型 TypeScript workspace 有一类问题不属于“执行效率”问题。

它们属于“结构真实性”问题：

```text id="g4j5vo"
这个依赖到底是源码依赖还是产物依赖？
这个 import 是否被 package.json 授权？
这个 project reference 是否反映了真实 import？
这个 declaration 是否来自被严格检查的源码？
这个文件是否真的被任何 checker 覆盖？
这个 runtime 是否越过了 client/node 边界？
这个 dist 是否真的是消费者可安装的 package？
```

limina 解决的就是这些问题。

[1]: https://nx.dev/features/run-tasks 'Run Tasks | Nx'
[2]: https://turbo.build/repo/docs/core-concepts/monorepos/running-tasks 'Running tasks'
[3]: https://turbo.build/repo/docs/crafting-your-repository/caching 'Caching'
[4]: https://nx.dev/features/enforce-module-boundaries 'Enforce Module Boundaries | Nx'

`limina` 是一个面向 pnpm + TypeScript monorepo 的架构治理工具。

它和 Nx、Turborepo、Rush 这类 monorepo 工具处在同一问题域，但切入点不同：Nx 更关注任务编排、affected execution、缓存和 CI 加速；limina 更关注 monorepo 结构本身是否健康，尤其是 TypeScript project references、`workspace:*` 源码依赖、package exports、源码覆盖证明和发布产物边界是否一致。

换句话说：

> Nx 让 monorepo 的任务更高效地运行；limina 让这些任务所依赖的 monorepo 结构更可信。

下面通过几个具体场景解释 limina 到底在检查什么。

## 用例一：`workspace:*` 看起来是源码依赖，但 TypeScript 实际解析到了 `dist`

假设你有两个包：

```text
packages/
  core/
    src/index.ts
    dist/index.d.ts
    package.json
  app/
    src/main.ts
    package.json
```

`app` 依赖 `core`：

```json
{
  "dependencies": {
    "@acme/core": "workspace:*"
  }
}
```

在 `app/src/main.ts` 中：

```ts
import { createClient } from '@acme/core';
```

从 pnpm 的角度看，这没有问题。`workspace:*` 会把本地 workspace 包链接进来。

但问题在于 `@acme/core/package.json` 可能是这样写的：

```json
{
  "name": "@acme/core",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

这意味着 TypeScript 解析 `@acme/core` 时，可能会走到：

```text
packages/core/dist/index.d.ts
```

而不是：

```text
packages/core/src/index.ts
```

这就是 limina 关心的问题。

因为 `workspace:*` 在 limina 的模型里表示**源码依赖**。既然 `app` 声明自己依赖 `@acme/core` 的源码，那么 TypeScript project graph 也应该表达这个事实：

```jsonc
// packages/app/tsconfig.lib.dts.json
{
  "references": [{ "path": "../core/tsconfig.lib.dts.json" }],
}
```

同时，`@acme/core` 的 exports 或 paths 也应该让 TypeScript 在源码图中解析到源码，而不是 `dist`。

### limina 会怎么看

limina 会认为这是不健康结构：

```text
workspace:* dependencies are source dependencies,
but TypeScript resolved this package export to a file not owned by the source graph.
```

### 修复方式

有三种方向：

第一种，给 package exports 增加 source-facing condition，例如：

```json
{
  "exports": {
    ".": {
      "source": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

第二种，使用 limina 生成兼容 paths：

```sh
pnpm exec limina paths generate
```

然后在对应 `tsconfig*.dts.json` 中手动加入：

```jsonc
{
  "extends": [
    "./tsconfig.dts.paths.generated.json",
    "./tsconfig.lib.json",
    "../../tsconfig.dts.base.json",
  ],
}
```

第三种，如果你本来就想消费 `dist`，那就不要把它建模成源码依赖。使用 `link:`、`catalog:` 或 semver，并移除 project reference。

---

## 用例二：包之间用相对路径互相引用，仓库里能跑，发布后坏掉

很多 monorepo 会出现这种代码：

```ts
// packages/app/src/main.ts
import { createClient } from '../../core/src/client';
```

这在仓库内通常能跑，因为文件路径确实存在。

但这破坏了 package 边界。

`app` 实际上绕开了：

```json
{
  "dependencies": {
    "@acme/core": "workspace:*"
  }
}
```

也绕开了 `@acme/core` 的 `exports`：

```json
{
  "exports": {
    "./client": "./dist/client.js"
  }
}
```

更严重的是，这种写法不能代表真实消费者的使用方式。npm 用户安装 `@acme/app` 时，并没有 `../../core/src/client` 这个路径。

### limina 会怎么看

limina 会认为这是跨包相对路径穿透：

```text
Relative import escapes package owner scope:
  reason: relative source imports must not cross the nearest package.json owner boundary.
```

### 推荐写法

改成 package exports import：

```ts
import { createClient } from '@acme/core/client';
```

然后在 `@acme/core/package.json` 中显式导出：

```json
{
  "exports": {
    "./client": {
      "source": "./src/client.ts",
      "types": "./dist/client.d.ts",
      "import": "./dist/client.js"
    }
  }
}
```

这样有三个好处：

1. 仓库内源码消费路径清楚。
2. 发布后消费者路径一致。
3. TypeScript project graph 可以和 package dependency graph 对齐。

---

## 用例三：`tsconfig.dts.json` 能生成声明文件，但没有被严格 typecheck

假设一个包里有：

```text
packages/core/
  src/index.ts
  tsconfig.lib.dts.json
```

`tsconfig.lib.dts.json` 负责生成声明文件：

```jsonc
{
  "extends": "../../tsconfig.dts.base.json",
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "emitDeclarationOnly": true,
    "rootDir": "src",
    "outDir": "dist",
  },
  "include": ["src/**/*.ts"],
}
```

这个配置能跑 `tsc -b`，也能生成 `.d.ts`。

但它有一个问题：它只证明“能 emit declaration”，不一定证明源码被严格检查过。

比如你的 declaration emit base config 可能为了兼容构建关闭了一些严格选项，或者 include 文件集合和本地 typecheck 配置不一致。

limina 的模型要求每个 declaration leaf 都有一个本地 companion：

```text
tsconfig.lib.dts.json  ->  tsconfig.lib.json
tsconfig.test.dts.json ->  tsconfig.test.json
tsconfig.dts.json      ->  tsconfig.json
```

例如：

```jsonc
// packages/core/tsconfig.lib.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "strict": true,
  },
  "include": ["src/**/*.ts"],
}
```

### limina 会怎么看

如果缺少 companion，limina 会报：

```text
Missing typecheck companion config:
  declaration leaf: packages/core/tsconfig.lib.dts.json
  expected typecheck config: packages/core/tsconfig.lib.json
  reason: every tsconfig*.dts.json project should have a matching tsconfig*.json file with the same typechecking semantics.
```

如果 companion 存在，但文件集合不同，也会失败。

例如 dts leaf 包含：

```text
src/index.ts
src/runtime.ts
```

但 local typecheck 只包含：

```text
src/index.ts
```

limina 会认为 declaration leaf 正在为未被本地严格 typecheck 的文件生成类型，这是不健康的。

### 推荐结构

```text
packages/core/
  tsconfig.json              # 默认 IDE/typecheck 入口
  tsconfig.lib.json          # lib 源码严格 typecheck
  tsconfig.lib.dts.json      # lib declaration emit
  tsconfig.test.json         # test 严格 typecheck
  tsconfig.test.dts.json     # test declaration graph leaf
```

---

## 用例四：`tsconfig.json` 同时承担太多职责，IDE、typecheck、build 全混在一起

很多项目会把 `tsconfig.json` 写成这样：

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "outDir": "dist",
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "references": [{ "path": "../core" }],
}
```

这个配置同时在做几件事：

- IDE 默认入口；
- 本地 typecheck；
- declaration emit；
- project reference graph；
- lib + test 混合环境。

短期看方便，长期看会导致几个问题：

1. IDE 看到的类型环境和 build 看到的不一致。
2. test-only dependency 可能进入 production declaration graph。
3. declaration emit 可能包含不该发布的文件。
4. project references 无法表达 lib/test/tools 的不同边界。

limina 更推荐拆开：

```text
packages/app/
  tsconfig.json
  tsconfig.lib.json
  tsconfig.lib.dts.json
  tsconfig.test.json
  tsconfig.test.dts.json
  tsconfig.tools.json
  tsconfig.tools.dts.json
```

单环境目录中，`tsconfig.json` 可以直接是 leaf：

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "strict": true,
  },
  "include": ["src/**/*.ts"],
}
```

多环境目录中，`tsconfig.json` 应该是纯聚合器：

```jsonc
{
  "files": [],
  "references": [
    { "path": "./tsconfig.lib.json" },
    { "path": "./tsconfig.test.json" },
    { "path": "./tsconfig.tools.json" },
  ],
}
```

### limina 会怎么看

如果一个带 references 的 `tsconfig.json` 还混入 compilerOptions、include 等字段，limina 会认为它不是 pure aggregator。

limina 的判断是：**有 references 的默认 `tsconfig.json` 应该只做聚合，不应该同时做 leaf。**

---

## 用例五：client runtime 误用了 Node API

假设你有一个浏览器端 runtime：

```text
packages/app/src/client/runtime.ts
```

里面有人写了：

```ts
import fs from 'node:fs';

export function loadConfig() {
  return fs.readFileSync('config.json', 'utf8');
}
```

这在 Node 环境下 typecheck 可能能过，但这段代码不能进入浏览器 runtime。

传统方式通常靠 code review 发现。但在 monorepo 里，这种边界很容易被破坏，尤其是 shared/client/server 目录互相引用时。

limina 用 label 表达架构边界。

```jsonc
// packages/app/src/client/tsconfig.dts.json
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "extends": ["./tsconfig.json", "../../../tsconfig.dts.base.json"],
  "references": [],
}
```

然后在 `limina.config.mjs` 中声明规则：

```js
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

### limina 会怎么看

它会把这类问题作为 architecture violation，而不是普通 TypeScript error：

```text
Denied graph access:
  rule: runtime-client
  imported specifier: node:fs
  denied dependency: node:*
  reason: client runtime must stay free of Node builtin imports
```

### 适用场景

这种规则特别适合：

- `runtime-client` 不能依赖 `runtime-node`；
- `runtime-shared` 不能依赖 client-only 或 node-only 实现；
- browser 包不能 import Node builtin；
- public API 层不能 import internal package；
- plugin runtime 不能依赖 CLI-only 代码。

---

## 用例六：新增了源码文件，但没有任何 checker 覆盖它

假设有人新增了一个文件：

```text
packages/core/src/generated/runtime.d.ts
```

但它没有出现在任何 `tsconfig*.json` 的 `include` 中，也没有被任何 checker entry 覆盖。

这类文件最危险的地方在于：CI 可能仍然是绿的。

不是因为文件正确，而是因为它根本没被检查。

limina 的 proof check 会先确定 source boundary，然后证明每个 source file 至少被一种方式覆盖：

- declaration graph；
- checker entry；
- allowlist。

如果没有覆盖，会报：

```text
Source files are not covered by typecheck proof:
  - packages/core/src/generated/runtime.d.ts
  reason: every file in config.source must be covered by a checker entry or an explicit allowlist entry.
```

### 正确修复

优先把它纳入 tsconfig：

```jsonc
{
  "include": ["src/**/*.ts", "src/**/*.d.ts"],
}
```

如果它确实是生成文件，并且由其他流程验证，可以放入 allowlist：

```js
export default defineConfig({
  proof: {
    allowlist: [
      {
        file: 'packages/core/src/generated/runtime.d.ts',
        reason: 'Generated declaration stub validated by the runtime build pipeline.',
      },
    ],
  },
});
```

allowlist 必须有具体理由。limina 不鼓励把 allowlist 当成跳过检查的垃圾桶。

---

## 用例七：测试代码依赖了测试工具，但 package.json 没声明

假设 `packages/core/src/__tests__/core.spec.ts` 中有：

```ts
import { describe, it, expect } from 'vitest';
```

但 `packages/core/package.json` 里没有：

```json
{
  "devDependencies": {
    "vitest": "catalog:test"
  }
}
```

这种情况在 monorepo 中很常见，因为根目录可能已经安装了 `vitest`，所以本地能跑。

但从 package owner 的角度看，`packages/core` 的测试源码使用了 `vitest`，它就应该在最近的 package owner 中被授权。

### limina 会怎么看

limina 会报 unauthorized bare package import：

```text
Unauthorized bare package import:
  package owner: packages/core/package.json
  imported specifier: vitest
  package: vitest
  reason: source imports must be authorized by the nearest package.json dependencies, devDependencies, peerDependencies, or optionalDependencies.
```

### 修复方式

在最近的 package owner 中补声明：

```json
{
  "devDependencies": {
    "vitest": "catalog:test"
  }
}
```

这个规则的目标不是强迫每个包重复安装依赖，而是让每个 package 的源码依赖关系可审计。

---

## 用例八：源码检查全过，但发布产物对消费者不可用

假设源码里这样写：

```ts
export { createClient } from './client';
```

源码 typecheck 没问题，build 也成功生成了：

```text
dist/client.js
dist/client.d.ts
```

但 `dist/package.json` 写错了：

```json
{
  "name": "@acme/core",
  "exports": {
    ".": "./index.js"
  },
  "types": "./missing.d.ts"
}
```

源码图检查无法发现这个问题，因为源码确实是对的。

但消费者安装到的是 `dist` 目录里的 package。消费者看到的是 `exports`、`types`、实际 `.js` 和 `.d.ts` 文件。

所以 limina 把 package checks 单独作为一层：

```js
export default defineConfig({
  package: {
    entries: [
      {
        name: '@acme/core',
        outDir: 'packages/core/dist',
      },
    ],
  },
});
```

运行：

```sh
pnpm exec limina package check
```

limina 会对真实 `dist` 做检查：

- 用 publint 检查 package manifest 和 exports；
- 用 Are The Types Wrong 检查类型解析；
- 检查 runtime imports 是否被 manifest 授权；
- 检查 browser output 是否误 import Node builtin；
- 检查 public package output 是否有 README/LICENSE。

### limina 的观点

源码图健康和发布产物健康是两件事。

一个健康 monorepo 必须同时保证：

```text
source graph is valid
package artifact is valid
```

---

## 用例九：一个文件被多个 declaration leaf 同时拥有

假设你有：

```text
packages/core/src/index.ts
packages/core/tsconfig.lib.dts.json
packages/core/tsconfig.tools.dts.json
```

两个 dts config 都 include 了同一个文件：

```jsonc
{
  "include": ["src/**/*.ts"],
}
```

这样 `src/index.ts` 同时属于 lib declaration graph 和 tools declaration graph。

这会导致几个问题：

1. 同一个文件可能被不同 compiler options 检查。
2. declaration emit 可能重复。
3. project reference graph 中无法判断谁才是这个文件的 owner。
4. 运行时边界 label 可能冲突。

limina 会认为一个 checker graph file 必须只有一个 declaration owner。

### 修复方式

让不同 leaf 拥有不同文件集合：

```jsonc
// tsconfig.lib.dts.json
{
  "include": ["src/**/*.ts"],
  "exclude": ["src/tools/**"],
}
```

```jsonc
// tsconfig.tools.dts.json
{
  "include": ["src/tools/**/*.ts"],
}
```

或者重新调整目录结构：

```text
src/
  lib/
  tools/
```

让每个 declaration leaf 的边界更自然。

---

## 用例十：一个包的浏览器产物意外依赖了未声明依赖

假设构建后的 `dist/index.js` 中出现：

```js
import { parse } from 'yaml';
```

但 `dist/package.json` 没有声明：

```json
{
  "dependencies": {
    "yaml": "^2.0.0"
  }
}
```

源码包里可能因为根目录安装了 `yaml` 而能正常测试，但消费者安装发布包时，`yaml` 不一定存在。

limina 的 package boundary check 会扫描发布产物中的 JS imports，并检查它们是否在 output manifest 中声明。

### limina 会怎么看

```text
"yaml" resolves to package "yaml" which is not listed in dependencies, peerDependencies, optionalDependencies, or self exports
```

### 修复方式

在最终发布产物的 package manifest 中补依赖：

```json
{
  "dependencies": {
    "yaml": "^2.0.0"
  }
}
```

或者如果它确实是外部环境提供的依赖，放到 `peerDependencies`。

---

## 总结

limina 眼中的健康 monorepo，不是“所有命令能跑完”，而是下面几张图互相一致：

```text
pnpm workspace packages
        │
        ▼
package.json dependencies
        │
        ▼
workspace:* source dependency graph
        │
        ▼
TypeScript project references
        │
        ▼
actual TypeScript module resolution
        │
        ▼
source files covered by checkers
        │
        ▼
built package outputs consumed by users
```

只要其中某一层表达了不同的事实，limina 就会认为 monorepo 不健康。

例如：

| 现象                                       | limina 的判断                              |
| ------------------------------------------ | ------------------------------------------ |
| `workspace:*` 但解析到 `dist`              | 源码依赖和 TypeScript resolution 不一致    |
| 跨包相对 import                            | 绕开 package exports 和 package owner 边界 |
| project reference 跨包但没有 `workspace:*` | TS 图声明了源码依赖，但 package 图没有     |
| dts leaf 没有 companion                    | declaration emit 没有严格 typecheck 证明   |
| source file 没被任何 checker 覆盖          | CI 绿不代表文件被检查                      |
| browser runtime import `node:fs`           | 运行时边界被破坏                           |
| dist manifest exports/types 错误           | 源码健康但发布产物不健康                   |
| dist import 未声明依赖                     | 消费者安装后可能缺依赖                     |
