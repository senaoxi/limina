# 单体仓库约束

![Limina 单体仓库分层边界模型](/layered-boundaries.png)

Limina 不要求每个单体仓库采用同一种目录结构。它首先约束的是源码和类型配置之间的关系：一个被检查的源码模块应该只归属于一个类型检测模块，而类型构建输出模块由 Limina 在 `.limina/` 目录下生成和维护。

这个前提很重要。Limina 生成的类型输出模块不是重新发明一份独立的 `tsconfig`，而是从用户维护的类型检测模块派生出来：它会 `extends` 原来的类型检测模块，保留原有的 `TypeScript` 类型语义，再额外覆盖声明输出、增量构建、输出目录、构建缓存和项目引用等和类型输出相关的配置。

所以，用户编写的类型检测模块不能只是“能让编辑器工作”的任意文件集合。它需要有清楚的源码归属边界。只有这个边界清楚，Limina 才能稳定回答：

```text
这个源码模块归哪个类型检测模块管？
这个类型检测模块对应哪个 .limina 类型输出模块？
这个导入需要消费哪个上游声明输出？
```

在这个基础上，Limina 才继续约束跨包访问、公开入口、类型关系、产物边和发布前检查。

可以把整体关系理解成这条链：

```text
源码模块
  -> 归属于唯一类型检测模块
  -> 派生出 .limina 类型输出模块
  -> 根据 TypeScript 声明提供者推导项目引用
  -> 进入图检查、产物图和发布前检查
```

这不是要把仓库改造成固定模板，而是让跨包关系、类型关系和产物关系能被复现、审查和修正。

## 类型检测模块是源码归属边界

在 Limina 的模型里，用户维护的是源码层面的类型检测模块，Limina 管理的是 `.limina/` 下的类型输出模块。

| 模块         | 位置                              | 维护方 | 作用                                                                           |
| ------------ | --------------------------------- | ------ | ------------------------------------------------------------------------------ |
| 类型检测模块 | 用户源码里的 `tsconfig*.json`     | 用户   | 描述哪些源码文件属于当前类型检查范围，以及这些文件按什么 `TypeScript` 语义检查 |
| 类型输出模块 | `.limina/tsconfig/.../*.dts.json` | Limina | 基于类型检测模块生成声明输出、增量构建和生成的项目引用                         |

类型输出模块会继承类型检测模块。也就是说，用户在类型检测模块中配置的 `moduleResolution`、`paths`、`baseUrl`、`customConditions`、`types`、`lib`、`jsx`、`strict` 等仍然会影响 `TypeScript` 如何理解源码。Limina 只覆盖和输出有关的配置，不会替用户重新设计类型环境。

因此，类型检测模块至少要满足一个基本要求：

```text
一个被 Limina 检查的源码模块，只能归属于一个普通类型检测模块。
```

如果同一个实现文件同时被多个普通类型检测模块覆盖，Limina 就无法稳定判断它的声明应该由哪个 `.limina` 类型输出模块提供。后续的声明提供者判断、生成的项目引用和图检查都会失去可靠前提。

不建议这样组织：

```text
packages/core/tsconfig.lib.json       includes src/index.ts
packages/core/tsconfig.browser.json   also includes src/index.ts
```

更合理的方式是让同一个实现文件只归一个叶子类型检测模块管辖；如果需要多环境聚合，可以用聚合式 `tsconfig.json` 引用多个叶子配置，而不是让多个叶子配置同时拥有同一批实现文件。

## 文件先要有治理区域和清楚的包归属

Limina 从最近的 `pnpm-workspace.yaml` 开始。每个最终激活包都是独立 package island，包根目录的 `package.json` 是 owner manifest。被检查的源码文件首先要属于这些单元；找不到归属时，Limina 会报告它位于已激活区域之外。如果普通源码 `tsconfig*.json` 覆盖了多个工作区包 owner 的文件，也会被报告为边界过宽。

治理不会自动穿过工作区包下面的每一层目录。默认情况下，嵌套 `package.json` 会停止当前 island；嵌套 `pnpm-workspace.yaml` 永远会停止当前 owner 的遍历。激活子包根目录也会停止父包遍历，但即使祖先存在工作区边界，子包仍会启动独立 island。

`regions.extendNestedPackageScopes` 可以让满足条件的嵌套包作用域继续留在当前区域。嵌套清单必须没有 `name` 字段，所有已发现工作区都不能把该目录识别为工作区包，而且该目录不能位于嵌套工作区边界内。其中源码继续继承外层工作区包的 owner 和依赖授权；嵌套清单仍然负责相对导入和 `#imports` 的包作用域。

`regions.exclude` 要求每条规则明确一种治理根 `kind`：`workspace-package`、`package-scope` 或 `pnpm-workspace`。相对于 `config.rootDir` 的路径 glob 只匹配同 `kind` 的精确 candidate 根目录，不匹配包名或 descriptor 路径。排除激活父包不会级联到未匹配的激活后代。被排除区域不属于当前 owner 运行，受治理源码导入其中内容时会按跨边界访问处理。完整匹配和验证规则见[治理区域](./config/regions.md)。

例如：

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

如果 `packages/app/tsconfig.lib.json` 把 `packages/ui/src/Button.ts` 也包含进来，这个类型检查范围就跨过了工作区包边界。更稳妥的修复通常不是给这条诊断消音，而是让 `app` 通过包名依赖 `ui`，再由 `ui` 自己的配置管自己的源码。

默认的 `tsconfig.json` 也需要保持清楚的形状。如果它只承担聚合作用，可以保留 `references` 和空的 `files`；具体源码输入应该放在叶子配置里。普通源码叶子配置不应该手写 `TypeScript` 项目引用：静态源码边由 Limina 从 `TypeScript` 声明提供者推导，静态分析看不到但工程上真实存在的边，再通过 `liminaOptions.implicitRefs` 显式声明。

这条约束的重点很简单：先让每个源码文件能回答“我的包作用域是否属于当前运行，又由哪个工作区包归属”，后面的导入关系、类型图和产物检查才有稳定基础。

## 类型检测模块不能承担声明构建补边职责

普通类型检测模块描述的是源码检查范围，不应该同时承担声明构建补边职责。

一个比较清楚的源码配置通常只回答两类问题：

```text
我管哪些文件？
这些文件按什么 TypeScript / 检查器语义检查？
```

而不应该在叶子配置里手写：

```text
我的声明构建应该引用哪些上游声明输出？
```

这个职责属于 `.limina/` 下的类型输出模块。Limina 会根据 `TypeScript` 声明提供者推导生成的项目引用；对于静态分析看不到的真实边，再读取 `liminaOptions.implicitRefs`。

因此，普通源码叶子配置里出现手写 `references`，容易把三件事混在一起：

```text
TypeScript 原生聚合引用图
Limina 生成的项目引用
用户为动态或虚拟关系做的补边
```

更清楚的分工是：

```text
聚合式 tsconfig.json
  -> 聚合多个类型检测模块

普通源码 tsconfig*.json
  -> 描述源码文件集合和类型检查语义

.limina/**/*.dts.json
  -> 描述声明输出和生成的项目引用
```

这个分工也让排障更直接：源码范围的问题回到用户 `tsconfig` 修正，声明输出和引用图的问题回到 `.limina` 生成逻辑或 `implicitRefs` 修正。

## 跨包访问应该经过公开入口

跨包相对导入通常会让包边界失去意义：

```ts
import { Button } from '../../ui/src/Button';
```

这条导入绕过了 `ui` 的公开入口，也绕过了 `app` 对 `ui` 的依赖声明。更容易维护的形态是：

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

Limina 会检查相对导入是否越过最近的 `package.json` 包作用域。对于裸包导入，它还会检查当前工作区包作用域是否通过 `dependencies`、`devDependencies`、`peerDependencies` 或 `optionalDependencies` 承认了这个依赖。匹配的 `source.importAuthority.allow` 授权可以让特定源码归属方使用工作区根清单中的指定依赖声明。

这个区别对已扩展的嵌套包作用域尤其重要：它会继承外层工作区 owner 的依赖授权，但相对导入仍然不能越过最近的嵌套 `package.json` 作用域。如果这个嵌套作用域没有被扩展，或已被 `regions.exclude` 裁剪，受治理源码导入其中内容时会先构成治理区域越界，再进入普通包访问规则。

`#imports` 也遵循类似边界。它的声明来源是导入文件最近的包作用域：相对目标应该留在声明它的包作用域内；如果目标指向三方包或工作区依赖，这个依赖仍然需要被导入文件所属的工作区包作用域授权，或者命中匹配的工作区根依赖授权。

Limina 并不是禁止跨包协作，而是要求跨包协作走能被包清单和公开入口解释的路径。

## 公开导出要在被使用时说得通

在单体仓库里，`workspace:*` 只说明依赖来自工作区，并不说明消费者会读源码还是读产物。真正决定入口的是被依赖包的 `package.json#exports`。

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

Limina 会在相关检查中区分 `TypeScript` 类型解析结果和 `Oxc` 运行时解析结果。对被源码静态导入命中的工作区入口来说，类型侧不能只落到运行时 `JavaScript`；运行时侧也不应该完全不可解析。纯类型入口可以解析到声明文件，源码入口可以解析到当前检查器支持的源码文件。

::: warning 边界约束

Limina 的检查入口不是对工作区包的 `exports` 做预扫描，而是从源码里收集到的导入记录。判断的起点是被源码导入抽取命中的模块说明符。换句话说，只有源码里出现了某条导入，并且这条导入被 `Oxc parser` 收集到，Limina 才会继续把这个说明符交给 `TypeScript` 解析器，并对解析后的目标模块做类型侧、运行时侧和图关系判断。

例如，一个工作区包可以只给运行时插件使用某个入口：

```json [packages/demo/package.json]
{
  "name": "demo",
  "exports": {
    "./runtime": "./dist/runtime.js"
  }
}
```

如果源码中没有静态导入 `demo/runtime`，而这个入口只会被插件、运行时注册表或外部系统注入使用，它就不会仅因为出现在 `exports` 中而进入类型入口检查流程。这类入口可以被理解为运行时专用入口。只有当治理范围内的源码静态导入了 `demo/runtime`，它才会进入后续的 `TypeScript` 类型解析和图检查流程。

这条约束的意思不是要求每个导出都同时暴露源码和产物，而是要求“被 Limina 观察到并纳入治理的导入关系”能够在当前仓库的类型解析和运行时解析中解释清楚。

:::

## references 来自声明提供者，不是来自导入文本

源码里出现了导入，并不代表一定要生成 `TypeScript` 项目引用。Limina 现在更关注的是：在当前检查器和 `tsconfig` 下，`TypeScript` 能确认这个导入的声明由谁提供。

```ts
// packages/app/src/main.ts
import { createClient } from '@acme/core';
```

如果 `TypeScript` 解析到的是 `core` 已有的 `.d.ts` 文件，这更接近声明文件消费，不应该强行生成源码项目引用。只有当 `TypeScript` 解析到另一个 Limina 管辖的源码文件，并且这个文件归属于另一个源码 `tsconfig` 时，Limina 才会把它映射到 `.limina` 下对应的类型输出模块。

可以把判断压缩成这样：

| `TypeScript` 类型解析结果     | Limina 对项目引用的处理                                 |
| ----------------------------- | ------------------------------------------------------- |
| `.d.ts` / `.d.mts` / `.d.cts` | 视为声明文件消费，不生成 `TypeScript` 项目引用          |
| 当前类型检测模块内的源码      | 视为当前范围内部关系，不生成 `TypeScript` 项目引用      |
| 另一个 Limina 管辖的源码文件  | 可能生成到目标类型输出模块的项目引用                    |
| `TypeScript` 无法解析         | 不用 `Oxc` 补判项目引用，输出诊断或交给相关检查暴露问题 |

如果确实存在静态分析看不到的源码边，例如代码生成、运行时 `manifest`、插件表或框架转换后才产生的连接关系，应该使用 `liminaOptions.implicitRefs` 显式声明，并写清原因。

```json [packages/app/tsconfig.lib.json]
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],

  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../core/tsconfig.lib.json",
        "reason": "app 的 route manifest 由构建插件生成，生成后会加载 core；源码中没有静态导入。"
      }
    ]
  }
}
```

`implicitRefs` 不是白名单，也不是绕过图规则的开关。它只是把静态图看不到、但工程上真实存在的关系显式放进声明构建图。

## 图规则要落到真实导入上

有些架构边界不是靠包名就能表达的，比如浏览器代码不能导入 `Node` 内置模块，公共 `API` 不应该访问内部实现，插件运行时代码不应该依赖 `CLI` 代码。Limina 允许把这些边界写成图规则，再用真实导入去验证。

```jsonc [packages/app/src/client/tsconfig.json]
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "include": ["./**/*.ts"],
}
```

```ts [limina.config.mts]
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

如果这个范围里的源码导入了 `node:fs`，Limina 会把它当作图规则问题报告。这里的判断不是“代码风格不好”，而是“这个真实导入违反了当前 `tsconfig` 声明的架构标签”。

这和上一节的问题相同：Limina 不靠抽象约定猜测关系，而是尽量把规则落到具体导入、具体文件和具体配置上。

## 声明过的工作区依赖应该能被触达

`package.json` 里声明了另一个工作区包，不代表这条依赖一定还在被使用。Limina 的源码检查会结合包入口、`bin`、脚本和显式配置的额外入口，借助 `Knip` 相关能力检查工作区依赖和源码文件的可达性。

```json [packages/app/package.json]
{
  "dependencies": {
    "@acme/core": "workspace:*",
    "@acme/unused": "workspace:*"
  }
}
```

如果 `@acme/unused` 不能从这些入口路径里被证明为可达，Limina 可以把它报告为无用工作区依赖。确实通过生成代码、运行时字符串或工具暂时看不到的路径使用时，可以在配置里写明忽略原因；否则，删除依赖通常比继续保留更清楚。

这里要注意边界：这类检查不能证明“仓库没有任何无用代码”，它只能在 Limina 收集到的源码归属、入口配置和 `Knip` 分析范围内报告可证明的问题。

## 产物关系只是依赖图里的限定事实

有些导入并不指向另一个包的源码，而是指向构建产物：

```ts
import { runtimeValue } from '@acme/core/runtime';
```

如果 `@acme/core/runtime` 通过公开入口解析到 `core/dist`，`limina graph export --view artifact` 可以把这段关系导出为产物边。这个边来自真实导入和模块解析结果，并且带有导入文件、导入说明符和解析结果作为证据。

但它不应该被理解成构建调度的权威任务图。源码里能观察到“消费了某个产物入口”，不等于 Limina 能证明“应该先运行哪个构建任务”。如果要把这类产物边用于任务编排，更合适的方式是让外部任务系统或 `CI` 显式消费导出的依赖图，并结合自己的构建目标配置做判断。

## 发布前检查只覆盖可报告的产物一致性问题

源码检查通过，不代表发布包一定可用。Limina 的包检查会围绕构建后的 `outDir` 执行补充检查：读取输出目录里的 `package.json`，打包成 `tarball`，按配置运行 `publint`、`Are The Types Wrong` 和包边界检查，并报告这些工具或 Limina 自身能识别的问题。

包边界检查会扫描发布输出中的 `JavaScript` 文件：浏览器环境的输出不应导入 `Node` 内置模块；输出里的自引用应该落在 `exports` 暴露的入口内；非相对外部导入需要能被输出包的依赖声明解释。

发布一致性检查会更接近 `npm` 消费者视角。它会检查 `tarball` 里是否有 `package.json`，是否缺少必要文件，是否包含 `source map` 文件或 `sourceMappingURL`，发布依赖里是否残留 `workspace:`、`link:`、`file:`、`catalog:` 等本地协议，并对工作区发布依赖做注册表基线或内容哈希相关校验。

这些检查不能替代 `npm` 发布流程、包管理器校验或真实消费者测试。它们的作用更具体：在发布前，把 Limina 能从 `tarball`、输出清单、依赖范围和已知检查工具中证明的问题报告出来。

## 一眼看懂这些约束

| Limina 约束什么                     | 它主要防止什么问题                                  |
| ----------------------------------- | --------------------------------------------------- |
| 一个源码模块只归一个类型检测模块    | 同一实现文件拥有多个声明输出提供者                  |
| 类型输出模块由 `.limina` 管理       | 用户源码配置和声明构建配置混在一起                  |
| 源码留在当前治理区域且有清楚 owner  | `tsconfig` 越过已停止区域或混入多个 owner 的源码    |
| 普通源码叶子配置不手写 `references` | 手工补边和生成的项目引用混淆                        |
| 跨包访问经过公开入口                | 相对路径绕过依赖声明和 `exports`                    |
| 裸包导入被清单承认                  | 代码用了依赖，但当前包没有声明                      |
| `#imports` 留在声明它的包语义内     | 内部别名绕过包作用域或依赖授权                      |
| 被导入命中的公开入口可以解析        | 子路径被源码使用时，类型侧或运行时侧说不清          |
| 项目引用来自声明提供者              | 把导入、依赖声明和 `TypeScript` 项目引用混为一谈    |
| 图规则命中真实导入                  | 浏览器、公共 `API` 或运行时边界只停留在口头约束     |
| 工作区依赖能被触达                  | `package.json` 长期留下无用依赖                     |
| 产物边可导出                        | 产物消费关系藏在源码导入里，难以审查                |
| 发布前检查产物一致性                | 源码检查通过，但 `tarball` 或输出清单存在可报告问题 |

## 使用时可以按这条路径排查

遇到 Limina 报告问题时，可以先按这个顺序看：

```text
1. 这个包作用域是否属于当前运行，又由哪个 pnpm 工作区包归属？
2. 当前源码文件是否只归属于一个普通类型检测模块？
3. 当前 tsconfig 是否留在当前治理区域和同一个工作区 owner 内？
4. 普通源码叶子配置里是否手写了 references？
5. 这条跨包导入是否经过包名和公开入口？
6. 当前包的 package.json 是否声明了这个裸包依赖？
7. TypeScript 能否在当前检查器和 tsconfig 下确认声明提供者？
8. 如果是静态图看不到的真实边，是否写了 implicitRefs 和 reason？
9. 如果是产物消费，是否应该只作为依赖图导出，而不是源码项目引用？
10. 如果是发布前问题，问题来自 outDir、tarball、依赖协议、类型入口还是边界检查？
```

这条路径不会覆盖所有项目差异，但能帮助你把问题定位到源码归属、类型检测模块、导入权限、类型图、产物图或发布产物中的某一层。

::: tip 小结

Limina 对单体仓库的约束可以概括成一句话：

```text
代码可以按项目需要组织，但源码归属、类型归属、跨包关系和产物关系要能被源码、配置或构建输出解释。
```

它不会替代 `TypeScript`、框架检查器、打包器、`npm` 发布流程或真实消费者测试。它做的是在这些工具之间补上一层可审查的关系检查：哪些源码归谁管，哪些源码模块由哪个类型检测模块负责，哪些导入被允许，哪些关系能进入声明构建图，哪些产物关系可以导出，哪些发布前问题能在 `tarball` 或输出目录里被发现。

:::
