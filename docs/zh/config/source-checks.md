# 源码检查

::: warning 注意
顶层 `source` 选项配置 `source:check` 中的三类行为：`source.importAuthority` 用于源码导入授权，`source.declarations` 管理显式环境声明角色，`source.knip` 用于 `Knip` 驱动的未使用工作区依赖和未使用源码模块检查。它不同于 `config.source`，后者定义覆盖证明使用的全局源码边界。`config.source` 见 [源码边界](./source-boundary.md)。
:::

`source check` 根据包归属和依赖声明检查源码导入是否获得授权。Limina 会从每个已验证、已激活包的独立治理范围（包治理单元）发现源码，包括外部包和没有 `name`、只能用路径标识的工作区包；每个工作区包根目录的清单用于确定其源码归属。显式源码选择器相对于 `config.rootDir`，可以包含 `../`，并且只过滤这些治理单元已经产生的候选文件。

默认情况下，嵌套 `package.json` 会停止当前治理区域，嵌套 `pnpm-workspace.yaml` 则永远是自动生效、仅对所属包生效的边界。启用 [`regions.extendNestedPackageScopes`](./regions.md#extendnestedpackagescopes) 后，满足条件的无名嵌套清单可以继续留在外层区域：其中源码继承外层工作区包的归属和依赖授权，这份嵌套清单仍负责相对导入和 `#imports` 的包作用域。[`regions.exclude`](./regions.md#exclude) 可以从当前运行中裁剪激活包或已识别的嵌套包作用域；导入任何已停止或被排除的区域都会按跨边界访问处理。

`Knip` 检查使用包入口而不是 `include` / `exclude`，根据 Limina 的源码归属方模块集合报告未使用工作区依赖和未使用源码模块。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: {
    importAuthority: {
      allow: {},
    },
    knip: {
      workspaces: {},
    },
  },
});
```

## 资源模块导入

`source:check` 会验证 CSS、SVG、YAML、文本等被导入的物理资源，但不会把它们当成 TypeScript 源码工程。资源导入只有同时满足下面两个条件才算完整：

1. 运行时解析器或文件系统能确认物理资源存在；
2. 当前检查器工程能看到这条导入的类型证据。

类型证据可以来自检查器确认的源码、`button.d.css.ts` 这类具体声明文件，或当前工程确实纳入的环境模块声明。环境声明不能证明物理资源存在；反过来，资源文件存在但当前工程看不到具体声明或环境声明，也不具备完整类型证据。

Limina 只在 `source:check` 中报告这两类问题：

| 规则                                            | 含义                                             |
| ----------------------------------------------- | ------------------------------------------------ |
| `LIMINA_SOURCE_RESOURCE_MODULE_NOT_FOUND`       | 物理资源不存在；这个结果优先于类型证据。         |
| `LIMINA_SOURCE_RESOURCE_MODULE_TYPE_UNDECLARED` | 资源存在，但当前检查器工程看不到对应的类型声明。 |

资源导入不会成为声明提供者、提供者边或项目引用；资源缺失也不会阻止 `graph prepare`。普通 TypeScript、JavaScript、JSON 和框架源码仍由已配置的检查器按原有方式解析。

模块说明符会按原样检查。对于 `./foo.svg?raw` 或 `./foo.svg#fragment`，Limina 不会去掉查询参数或片段标识去检查 `./foo.svg`；完整说明符会原样交给已配置的检查器，只有检查器自己的结果决定类型是否存在。因此这类导入不会仅凭后缀被报告为资源缺失或类型未声明。对于 `#assets/logo.svg` 这类 `package.json#imports` 资源，物理路径查找会保留完整映射键。匹配的类型证据和包导入授权仍然必须满足。物理路径查找成功不表示检查器支持所有键的拼写，也不表示已安装相应打包器转换插件；当前版本也没有提供声明宿主查询语义的方式。

虚拟模块和框架注入模块的运行时行为仍不受支持；只有环境声明不能让这类运行时模块自动变为合法，Limina 也不会把它误报为物理资源缺失。

Vue 资源类型证据与图分析使用同一套有界语义适配器组合：`vue-tsc` 2.2.0–2.2.12 搭配相同版本的 `@vue/language-core` 和 `@volar/typescript` 2.4.11–2.4.28，或 `vue-tsc` 3.2.0–3.2.4 搭配相同版本的 Language Core 和 Volar TypeScript 2.4.27。两个版本系列都接受 TypeScript 5.4.x–5.9.x 或 6.0.x。其他 Vue 检查器组件版本组合会被视为不受支持，不会误报成缺少类型声明。

## `importAuthority`

`source.importAuthority` 控制那些没有写在源码归属方清单文件里的裸包导入。

源码导入授权默认严格：已验证的源码所属包清单必须在 `dependencies`、`devDependencies`、`peerDependencies` 或 `optionalDependencies` 中声明这个包。按源码归属方分组的授权可以让同一个源码归属方在指定范围内使用治理根目录 `package.json` 的依赖声明。根清单文件仍然要在同样的依赖区里声明这个包。

这里的“源码导入”包括 Limina 能收集到的静态导入、类型导入和再导出。`Node` 内置模块、虚拟模块、`URL` / `data` / `file` 说明符和注释中的说明符不按普通裸包依赖处理。

当某个源码归属方确实要使用工作区根目录声明的依赖时，可以写 `allow` 授权：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: {
    importAuthority: {
      allow: {
        '@example/create-app': [
          {
            include: ['templates/react/**'],
            workspaceRootDependencies: ['react', 'react-dom'],
            reason: 'React 模板源码使用工作区根目录声明的依赖。',
          },
        ],
      },
    },
  },
});
```

```ts
interface SourceImportAuthorityConfig {
  allow?: Record<string, SourceImportAuthorityWorkspaceRootGrant[]>;
}

interface SourceImportAuthorityWorkspaceRootGrant {
  include?: string[];
  workspaceRootDependencies: string[];
  reason: string;
}
```

`allow` 的键名必须匹配应用 `regions` 后仍留在当前治理区域内的源码归属方身份。具名工作区包使用包名；没有 `name` 的源码归属方使用相对于 `config.rootDir` 的词法包目录，必要时包含 `../`。`include` 可选并相对于 `config.rootDir`；它可以包含 `../`，但只能过滤键名对应的源码归属方已受治理的源码。省略时，授权适用于这个源码归属方下所有被 Limina 管辖的源码模块。

`workspaceRootDependencies` 不是直接导入允许清单。它只说明当源码归属方和 `include` 范围都匹配时，哪些包名可以读取工作区根目录清单中的依赖声明。Limina 仍然要求根清单实际声明这个包；如果源码归属方和根目录之间存在中间工作区包清单声明了同一个包，根目录授权不会绕过这个中间清单。

用于源码归属方运行时的导入，优先在该归属方自己的清单中声明依赖。

## `declarations.ambient`

`source.declarations.ambient` 用于明确标记承担 TypeScript 环境声明角色的声明文件，避免把它们当成普通的包归属声明 API。

```ts
interface SourceAmbientDeclarationConfig {
  include: string[];
  allowSharedAcrossOwners?: boolean;
  allowTripleSlashReferences?: boolean;
  reason: string;
}

interface SourceDeclarationsConfig {
  ambient?: SourceAmbientDeclarationConfig[];
}
```

每个 `include` 数组都使用相对于 `config.rootDir` 的模式；外部激活包可以使用 `../`。这些模式只过滤已验证包治理单元发现的文件，不能让未激活目录或仅对所属包生效的边界后方的路径变得可见。每条规则必须至少匹配一个声明文件，同一个物理文件也不能同时匹配多条规则。

被匹配文件必须确实符合环境声明的结构。Limina 管理的输出声明、包的公开声明入口，以及包含普通导入或导出的外部声明模块，都不能重新归类为环境声明。

`allowSharedAcrossOwners` 默认为 `false`；只有多个源码归属方确实需要共同使用同一份环境声明时才设为 `true`。`allowTripleSlashReferences` 同样默认为 `false`；它只授权通过 `/// <reference path="...">` 访问匹配的声明文件，不会授权普通导入、包依赖或 `/// <reference types>`。

```js
export default defineConfig({
  source: {
    declarations: {
      ambient: [
        {
          include: ['../shared-types/globals.d.ts'],
          allowSharedAcrossOwners: true,
          reason: '多个应用共用宿主环境提供的全局声明。',
        },
      ],
    },
  },
});
```

## `knip`

- **类型：** `boolean | SourceKnipCheckConfig`
- **默认值：** 关闭（省略 `source.knip` 或写为 `false`）

`source.knip` 控制 `source:check` 中由 `Knip` 驱动的部分：未使用工作区依赖和未使用源码模块。

写 `knip: true` 时，Limina 使用自动生成的默认 `Knip` 配置。省略该选项或写 `knip: false` 时，会关闭这些 `Knip` 驱动的检查。对象形式会启用检查，并且至少声明 `root` 或 `workspaces` 之一，也可同时声明。治理根包使用 `{ root: {} }`，不需要额外规则时也可使用 `{ workspaces: {} }`：

```ts
interface SourceKnipEntryConfig {
  files: string[];
  reason: string;
}

interface SourceKnipIgnoredDependencyConfig {
  dep: string;
  reason: string;
}

interface SourceKnipIgnoredFileConfig {
  file: string;
  reason: string;
}

interface SourceKnipWorkspaceConfig {
  entry?: SourceKnipEntryConfig[];
  ignoreDependencies?: SourceKnipIgnoredDependencyConfig[];
  ignoreFiles?: SourceKnipIgnoredFileConfig[];
}

interface SourceKnipCheckConfig {
  root?: SourceKnipWorkspaceConfig;
  workspaces?: Record<string, SourceKnipWorkspaceConfig>;
}
```

`source.knip` 只接受 `true`、`false` 或上面的对象形式。空对象、`null`、数组、标量、未知字段，以及不是对象的 `root` 或 `workspaces` 值，都会被判定为无效配置。

`source.knip.root` 是单包项目和工作区中配置治理根包的唯一方式，有无包名均可。根包入口、忽略规则、构建脚本推导、多 `tsconfig` 分组和检查结果都保留该包已经验证的归属关系。根包必须已经激活：`root` 不能重新激活已排除的根包。

`source.knip.workspaces` 的键名是已激活的具名非根工作区包名称，例如 `@acme/app`。未知或已排除的名称会让 `source check` 失败。`"."` 和根包名称两个入口均被拒绝，即使没有声明 `root` 也是如此。已有 `workspaces[rootPackageName]` 配置应整体移到 `root`，保留内部字段。相对目录不是公开寻址方式：Limina 内部把已验证源码归属方映射为 Knip 的 `"."`、相对工作区目录及分析目标，不为适配修改 `package.json#workspaces`。无名称非根包仍有归属身份，但没有公开的名称键。

`source.knip.root` 和 `source.knip.workspaces[pkg]` 只配置额外可达入口和忽略规则。包级 `Knip tsconfig` 由静态、直接的 `limina build <config>` 脚本推导；没有这类脚本时，Limina 不传 `--tsConfig`，交给 `Knip` 使用自己的默认 `tsconfig` 行为。

静态包脚本可以覆盖这个默认行为，让 Limina 为这个包推导专用的 `Knip tsconfig` 来源：

```json
{
  "scripts": {
    "build": "limina build tsconfig.json"
  }
}
```

`<config>` 会从这个包目录解析。它必须是工作区内的 `JSON` 文件。托管脚本必须指向 Limina 管理且存在输出构建模块的配置。原始包脚本必须使用 `--raw --preset <tsc|tsgo|vue-tsc>`，配置还必须留在所属包目录里，并且不能指向生成的 `.limina` 配置。Limina 只支持 `limina build tsconfig.json`、`limina build tsconfig.dts.json --raw --preset tsgo`、`pnpm limina build tsconfig.json`、`pnpm exec limina build tsconfig.json` 这类直接静态写法。像 `limina build $CONFIG` 这样的动态 shell 脚本会被报告为不支持。单包支持没有把解析器接受的调用语法扩大到 npm、Yarn 或 Bun 包装命令；这些项目仍可使用直接的 `limina build`。

::: warning 注意
`knip` 是 Limina 的可选对等依赖。如果启用了 `source.knip`，但运行 Limina 的工作区没有安装 `knip`，`source check` 会在源码分析开始前以缺少对等依赖错误失败。关闭 `source.knip` 时，Limina 不会解析或运行 Knip。如果持续集成需要覆盖未使用依赖和未使用模块检查，应显式安装并校验 `knip`。
:::

Limina 会为受治理的源码归属方工作区写入 `entry: []`，从而关闭 `Knip` 隐式的 `index` / `main` / `cli` 入口猜测。默认可达性仍然包含包清单入口（`exports`、`main`、`module`、`browser`、`bin`、`types`、`typings`）、`Knip` 插件推断入口、包脚本，以及 Limina 为应用型源码归属方生成的虚拟入口。

当包入口指向构建产物时，`Knip` 可能需要一个能说明 `rootDir` / `outDir` 的 `tsconfig`，才能把这些产物映射回源码文件。托管模式下，把这个布局写在源码叶子的 `liminaOptions.outputs` 中，再让包里的静态 `limina build <config>` 脚本指向托管源码配置或聚合配置。如果使用包内手写构建 `tsconfig`，则使用 `limina build <config> --raw --preset <checker>`。

此例中，`package.json` 暴露构建后的文件，选中的源码 `tsconfig` 描述对应的源码树。`@example/utils` 的导出如下：

```json
{
  "exports": {
    "./env": "./dist/src/env.js"
  }
}
```

同时让源码叶子描述源码到产物的布局：

```json
{
  "liminaOptions": {
    "outputs": {
      "rootDir": ".",
      "outDir": "./dist"
    }
  },
  "compilerOptions": {
    "module": "ESNext"
  },
  "include": ["src/**/*.ts"]
}
```

布局匹配时，`utils/dist/src/env.js` 可以对应 `utils/src/env.ts`。Limina 将受管产物入口映射回源码时，需要已选中的生成 Knip 配置、该配置引用的生成输出项目中明确的 `rootDir` / `outDir`、位于输出根内的包清单目标，以及已属于该源码归属方受检查源码模块集合的候选。仅有目录选项不保证每个产物入口都可达；原始配置和默认配置还依赖 Knip 自身解析。

再用静态包构建脚本指定所选配置：

```json
{
  "scripts": {
    "build": "limina build tsconfig.json"
  }
}
```

如果推导出的 `Knip tsconfig` 未能说明 `outDir` / `rootDir`，`Knip` 可能看到 `dist` 入口却找不到对应源码，进而将源码文件报告为未使用模块。遇到这种情况，优先修正 `liminaOptions.outputs`，或使用显式原始构建的 `limina build <config> --raw --preset <checker>` 包内配置，而不是为了让 `Knip` 通过而给 `package.json` 补只给工具看的导出条件。

`Knip` 的 `project` 文件集合也由 Limina 根据受治理源码模块自动确定；用户不配置 `project`。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: {
    knip: {
      workspaces: {
        '@acme/app': {
          entry: [
            {
              files: ['packages/app/src/**/*.spec.ts'],
              reason: 'Vitest 会直接加载测试模块。',
            },
          ],
          ignoreDependencies: [
            {
              dep: '@acme/runtime',
              reason: '由入口图之外的生成代码加载。',
            },
          ],
          ignoreFiles: [
            {
              file: 'packages/app/src/generated/runtime.ts',
              reason: '框架会加载这个生成的运行时模块。',
            },
          ],
        },
      },
    },
  },
});
```

### `root.entry` / `workspaces[pkg].entry`

- **类型：** `Array<{ files: string[]; reason: string }>`

`entry` 用于补充包导出之外的直接源码入口。例如测试运行器可能会直接加载 `*.spec.ts` 文件。

`entry` 配置必须使用相对于 `config.rootDir` 的正向通配模式，且必须位于键名指向的包目录内，并提供非空 `reason`。外部激活包使用 `../`；模式仍然只能过滤对应源码归属方已发现的源码模块集合。

### `root.ignoreDependencies` / `workspaces[pkg].ignoreDependencies`

- **类型：** `Array<{ dep: string; reason: string }>`

`source check` 会验证 `package.json` 中声明的工作区依赖能从导入方包的公开入口图触达。这个规则适用于每个工作区包，包括工作区根目录。

如果依赖确实由生成代码、运行时字符串或 `Knip` 看不见的路径使用，可以在导入方包名对应的键下添加忽略条目。

忽略条目的 `dep` 必须是已存在的工作区包，并且这个依赖关系仍然声明在键名指向的导入方包清单中。确实需要保留时，把 `reason` 写在配置旁；不再需要时，应该删除依赖。

### `root.ignoreFiles` / `workspaces[pkg].ignoreFiles`

- **类型：** `Array<{ file: string; reason: string }>`

`ignoreFiles` 只用于确实要保留、但 `Knip` 看不见的源码模块。

忽略条目必须使用相对于 `config.rootDir` 的文件路径，并提供非空 `reason`。路径可以包含 `../`，但该文件还必须属于键名指向的包的 Limina 已知源码模块集合。
