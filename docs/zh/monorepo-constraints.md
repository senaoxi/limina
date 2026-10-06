# 多包仓库约束 {#单体仓库约束}

在多包仓库中，Limina 要求实现源码拥有清楚的包归属和类型检查归属，再据此检查跨包导入、声明引用和产物消费。目录结构可以按项目需要组织，但一个叶子配置不能把多个包的实现混成自己的输入。

本页按常见结构问题解释这些约束。配置角色的完整定义见[核心概念](./concepts.md)，具体匹配规则见[配置参考](./config/index.md)。

## 源码叶子配置是源码归属边界 {#类型检测模块是源码归属边界}

在 Limina 的模型里，用户维护源码层面的源码叶子配置，Limina 为支持构建的检查器管理 `.limina/` 下的声明构建配置。

| 模块         | 位置                              | 维护方 | 作用                                                                           |
| ------------ | --------------------------------- | ------ | ------------------------------------------------------------------------------ |
| 源码叶子配置 | 用户源码里的 `tsconfig*.json`     | 用户   | 描述哪些源码文件属于当前类型检查范围，以及这些文件按什么 `TypeScript` 语义检查 |
| 声明构建配置 | `.limina/tsconfig/.../*.dts.json` | Limina | 基于源码叶子配置生成声明输出、增量构建和生成的项目引用                         |

声明构建配置继承对应的源码叶子配置。用户配置的 `moduleResolution`、`paths`、`baseUrl`、`customConditions`、`types`、`lib`、`jsx`、`strict` 等仍影响检查器如何理解源码；生成配置会显式记录有效输入，并调整声明输出、增量缓存、相对 `types`、自动 `typeRoots` 等选项；声明输出需要时还会禁用 `rewriteRelativeImportExtensions`。这种继承不承诺与原生 `tsc -b` 行为等价。语义判定依据在确定最终负责该配置的检查器之前锁定：按 TypeScript 语义解析的配置可以由 `vue-tsc` 负责构建，而其导入不会因此按 Vue 语义重新解释。

普通源码叶子配置须满足以下归属要求：

```text
一个被 Limina 检查的源码模块，只能归属于一个普通源码叶子配置。
```

这里的唯一叶子配置要求针对实现源码。声明输入（`.d.ts`、`.d.mts`、`.d.cts`）使用单独的环境声明共享和覆盖规则。

同一个实现文件被多个普通源码叶子配置覆盖时，Limina 会报告归属冲突。声明提供者选择和生成引用依赖唯一的源码归属。

不建议这样组织：

```text
packages/core/tsconfig.lib.json       包含 src/index.ts
packages/core/tsconfig.browser.json   也包含 src/index.ts
```

让每个实现文件只归一个叶子源码叶子配置管辖。如需聚合多个环境，用 `tsconfig.json` 引用各自的叶子配置，避免它们重复覆盖实现文件。

## 文件先要有治理区域和清楚的包归属

所选 Limina 配置最近的 `package.json` 决定治理根，根自身的工作区声明决定包集合。每个激活包独立提供源码治理范围，其根清单负责依赖授权。没有工作区声明时，候选集合只有根包。

例如：

```text
packages/
  app/
    package.json
    tsconfig.lib.json
    src/main.ts
  ui/
    package.json
    tsconfig.lib.json
    src/Button.ts
```

如果 `app/tsconfig.lib.json` 同时包含 `ui/src/Button.ts`，它就跨过了包归属边界。应让 `ui` 的配置拥有该文件，再让 `app` 通过公开包入口依赖它。检查器因导入读到一个文件，不等于这个文件归导入方所有。

默认情况下，嵌套 `package.json`、嵌套工作区根和激活子包都会停止外层包的遍历；已激活的子包从自己的包根独立治理。满足条件的无名嵌套包作用域可以通过 `regions.extendNestedPackageScopes` 留在外层区域，但它的最近包作用域仍约束相对导入和 `#imports`。

`regions.exclude` 按种类排除包、嵌套包作用域或精确 `tsconfig`。排除父包不自动排除独立激活的后代；只排除配置文件也不等于排除源码。详细条件见[治理区域](./config/regions.md)。

还要区分源码归属、有效分析输入与检查器 `Program` 的文件集合。本地相对 `compilerOptions.types` 可以带入类型输入，`extends` 可以引用配置，但都不能单独证明源码归属。治理根内的本地有效输入仍须处于激活区域。

::: details 分层边界示意

![Limina 多包仓库分层边界模型](/layered-boundaries.png)

图中 `Module` 表示源码模块，`tsconfig scope` 表示源码配置范围，`tsconfig build scope` 对应派生的构建配置范围。这里讨论的内部声明配置位于 `.limina`，不是发布到 `dist` 的产物。pnpm 只是工作区层次示例；图中嵌套包作用域是否被治理，还取决于实际激活与扩展规则。

:::

## 源码叶子配置不手写原生 `references` {#类型检测模块不能承担声明构建补边职责}

用户维护两类输入：叶子配置描述源码范围与类型环境，聚合配置用 `references` 组织叶子。默认 `tsconfig.json` 只有在检查器解析后的文件集合为空、且直接声明了 `references` 时，才是 Limina 支持的聚合配置。

普通源码叶子不能直接声明原生 `references`，空数组也不行。Limina 根据源码关系生成 `.limina` 下的声明引用；静态分析看不到但确实需要的关系，由叶子上的 `liminaOptions.implicitRefs` 补充。

```text
用户 tsconfig.json：聚合叶子成员
用户 tsconfig.lib.json：定义源码与类型环境，可声明 implicitRefs
.limina/.../*.dts.json：记录内部声明输出及生成的 references
```

源码范围问题在用户配置中修复，引用问题则检查导入、提供者和规则，再重新生成。不要手动修补 `.limina` 文件；合法输入无法投影时，应报告生成缺陷。

## 跨包访问应该经过公开入口

跨包相对导入会绕过包名和公开入口：

```ts
import { Button } from '../../ui/src/Button';
```

这条导入绕过了 `ui` 的公开入口和 `app` 对 `ui` 的依赖声明。应声明依赖并通过包名导入：

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

这个区别对已扩展的嵌套包作用域尤其重要：它会继承外层工作区包的依赖授权，但相对导入仍然不能越过最近的嵌套 `package.json` 作用域。如果这个嵌套作用域没有被扩展，或已被 `regions.exclude` 裁剪，受治理源码导入其中内容时会先构成治理区域越界，再进入普通包访问规则。

`#imports` 也遵循类似边界。它的声明来源是导入文件最近的包作用域：相对目标应该留在声明它的包作用域内；如果目标指向三方包或工作区依赖，这个依赖仍然需要被导入文件所属的工作区包作用域授权，或者命中匹配的工作区根依赖授权。

跨包导入须符合包清单中的依赖声明和公开入口。

## 图检查依据实际消费的导出

在工作区里，`package.json#exports` 参与导入方检查器的解析。Limina 保留该次导入的解析结果，再根据实际目标判断工作区归属、源码或产物消费，以及图规则。

例如，一个包可以同时声明以下入口：

```json [packages/utility/package.json]
{
  "name": "utility",
  "type": "module",
  "exports": {
    "./a": "./src/a.ts",
    "./broken": "./src/missing.ts"
  }
}
```

当 `src/a.ts` 存在，且消费者只导入 `utility/a` 时，未被消费的损坏入口不会使 `limina graph check` 失败。已消费的依赖仍需满足归属、引用和图规则。如果消费者改为导入 `utility/broken`，且其检查器无法解析，图检查会定位该导入并失败。`graph export` 也会报告该失败，而非静默省略依赖。

导入方检查器仍然决定按包自身名称导入、解析条件、`paths`、环境模块声明、框架源码和声明的语义。另一个检查器配置或运行时文件命中不能修复其解析失败，也不能生成源码边。图检查不枚举包的 `exports`，也不展开通配入口来验证该包公开提供的入口和文件。既有声明引用规则继续适用，包括排除 `require.resolve()`。

发布检查面向另一对象。[包检查](./config/package-checks.md)只处理显式配置的输出条目。Limina 检查声明一致性，包括本地依赖协议和混合 `exports` 根键。可选的 publint 检查打包后的产物，包括导出目标缺失；关闭或无法使用 publint 时，该项未检查。可选的 ATTW 检查运行时与类型的兼容性，不改变图事实、边或诊断。包边界检查保留自身的产物代码约束，[发布检查](./config/release-checks.md)也保持独立。

图检查通过不代表完整发布契约已经通过。哪些公开入口应保留、弃用或删除，由包作者决定；未被工作区使用的入口可能服务外部消费者或兼容性需求。

## 项目引用来自声明提供者，不是来自导入文本 {#references-来自声明提供者-不是来自导入文本}

一个导入是否需要生成 `TypeScript` 项目引用，取决于当前检查器和 `tsconfig` 确定的声明提供者。

```ts
// packages/app/src/main.ts
import { createClient } from '@acme/core';
```

如果检查器把它解析到 `core` 的已有 `.d.ts` 文件，这属于声明文件消费，不会强行生成源码项目引用。被消费的源码关系只有在语义证据要求声明提供者，且另一受管配置具有有效的声明提供者时，才会映射到 `.limina` 下的声明构建配置。框架调度依赖仍是单独的关系。

解析结果与项目引用的关系如下：

| `TypeScript` 类型解析结果     | Limina 对项目引用的处理                                 |
| ----------------------------- | ------------------------------------------------------- |
| `.d.ts` / `.d.mts` / `.d.cts` | 视为声明文件消费，不生成 `TypeScript` 项目引用          |
| 当前源码叶子配置内的源码      | 视为当前范围内部关系，不生成 `TypeScript` 项目引用      |
| 另一个 Limina 管辖的源码文件  | 可能生成到目标声明构建配置的项目引用                    |
| `TypeScript` 无法解析         | 不用 `Oxc` 补判项目引用，输出诊断或交给相关检查暴露问题 |

如果确实存在静态分析看不到的声明构建关系，例如代码生成后的连接，可以使用 `liminaOptions.implicitRefs` 显式声明，并写清原因。

```json [packages/app/tsconfig.lib.json]
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],

  "liminaOptions": {
    "implicitRefs": [
      {
        "path": "../core/tsconfig.lib.json",
        "reason": "app 包的路由清单由构建插件生成，生成后会加载 core 包；源码中没有静态导入。"
      }
    ]
  }
}
```

`implicitRefs` 将静态分析看不到、但实际存在的关系加入声明构建图。这些关系仍须满足图规则，不能通过 `implicitRefs` 允许违规。

## 图规则要落到真实导入上

有些架构边界不是靠包名就能表达的，比如浏览器代码不能导入 `Node` 内置模块，公共接口不应该访问内部实现，插件运行时代码不应该依赖命令行代码。Limina 允许把这些边界写成图规则，再用真实导入去验证。

```jsonc [packages/app/src/client/tsconfig.json]
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "include": ["./**/*.ts"],
}
```

```ts [limina.config.mts]
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    rules: {
      'runtime-client': {
        deny: {
          deps: [
            {
              name: 'node:*',
              reason: '客户端运行时必须禁止导入 Node 内置模块',
            },
          ],
        },
      },
    },
  },
});
```

这个范围内的 `node:fs` 导入会命中 `runtime-client` 标签对应的禁止规则，Limina 将其报告为图规则违规。

检查会将已配置的规则应用于带有相应标签的源码配置范围。

## 声明过的工作区依赖应该能被触达

`package.json` 里声明了另一个工作区包，不代表这条依赖一定还在被使用。启用 `source.knip` 时，Limina 的源码检查会结合包入口、`bin`、脚本和显式配置的额外入口，借助 `Knip` 相关能力检查工作区依赖和源码文件的可达性。

```json [packages/app/package.json]
{
  "dependencies": {
    "@acme/core": "workspace:*",
    "@acme/unused": "workspace:*"
  }
}
```

从配置入口无法证明 `@acme/unused` 可达时，Limina 可以将其报告为未使用的工作区依赖。如果生成代码、运行时字符串或分析范围外的路径实际使用了它，应写明忽略原因；否则应删除未使用的依赖。

检查结果限于 Limina 收集到的源码归属、入口配置和 `Knip` 分析范围，不能证明整个仓库没有未使用的代码。

## 产物关系只是依赖图里的限定事实

有些导入并不指向另一个包的源码，而是指向构建产物：

```ts
import { runtimeValue } from '@acme/core/runtime';
```

如果 `@acme/core/runtime` 通过公开入口解析到由 `liminaOptions.outputs` 或已配置包产物条目声明并验证的输出根，且目标没有实际源码归属方，`limina graph export --view artifact` 可以把这段关系导出为产物边。仅有 `dist` 目录名不能证明该分类；`lib` 等自定义输出也可以。这个边来自真实导入及其保留的检查器解析结果，并带有导入文件、导入说明符和解析结果作为证据。

导出的产物边描述消费关系，不决定构建任务顺序。用于任务编排时，外部任务系统或持续集成流程仍需结合自己的构建目标配置。

## 发布前检查只覆盖可报告的产物一致性问题

源码检查通过，不代表发布包一定可用。Limina 的包检查选择已配置的产物条目，读取各输出 `package.json`，仅在选中的工具需要时打包，并运行启用的 `publint`、`Are The Types Wrong` 或包边界检查。未配置的输出不在检查范围内。缺失的可选分析器可以被跳过；禁用（`disabled`）或跳过（`skipped`）的检查没有验证其对象。已安装的分析器加载失败会使检查失败，不会按可选缺失跳过。

包边界检查会扫描发布输出中的 `JavaScript` 文件：浏览器环境的输出不应导入 `Node` 内置模块；输出里的自引用应该落在 `exports` 暴露的入口内；非相对外部导入需要能被输出包的依赖声明解释。

发布一致性检查会检查包归档中的 `package.json`、必要文件、源码映射文件和 `sourceMappingURL`，检查发布依赖中残留的 `workspace:`、`link:`、`file:`、`catalog:` 等本地协议，并对工作区发布依赖校验注册表基线或内容哈希。

这些检查报告从包归档、输出清单、依赖范围和已启用分析器中发现的问题。发布流程、包管理器校验和真实消费者测试仍需单独执行。

## 根据问题选择修复位置 {#使用时可以按这条路径排查}

| 问题                           | 应检查的输入                                          |
| ------------------------------ | ----------------------------------------------------- |
| 文件没有归属、跨越停止区域     | 治理根、激活包、`regions`                             |
| 同一实现文件归多个配置         | 源码叶子的有效文件集合                                |
| 叶子手写了原生引用             | 聚合成员关系与 `implicitRefs` 的职责                  |
| 跨包导入或未声明依赖           | 导入方清单、公开入口、有限的根依赖授权                |
| 声明引用缺失、被禁止或形成循环 | 当前检查器解析、目标归属、检查器身份与图规则          |
| 源码通过但产物检查失败         | 配置的 `outDir`、输出清单、打包文件与实际运行的分析器 |

具体诊断与查询命令见[故障排查](./troubleshooting.md)。
