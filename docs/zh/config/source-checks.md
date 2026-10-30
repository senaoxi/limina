# 源码检查

`source` 用来配置源码导入规则、环境声明和可选的未使用代码分析。比如，`packages/app` 导入 `@acme/core` 时，Limina 会检查这条导入能否由 `app` 的包清单授权。默认检查已经包含这些基础规则，不需要为了启用它们而填写配置。

如果报告导入未授权，通常应先在实际使用依赖的包中声明它。只有确实需要共享工作区根目录的依赖声明时，再考虑下文的 `importAuthority`。

省略 `source` 时，Limina 仍会执行基础源码检查。`source: { knip: false }` 同样执行适用的基础检查，但不运行 Knip。`source: { knip: true }` 还会启用 Knip。单独运行 `limina source check` 时使用相同策略。

`source`、`declarations` 和 `importAuthority` 不能写成空对象。需要显式声明空集合时，可以使用 `declarations: { ambient: [] }` 或 `importAuthority: { allow: {} }`。

| 字段                          | 用途                                   | 未配置时                   |
| ----------------------------- | -------------------------------------- | -------------------------- |
| `source.importAuthority`      | 为指定源码授予使用治理根依赖声明的权限 | 裸包依赖须由源码所属包声明 |
| `source.declarations.ambient` | 标记需要显式管理的环境声明角色         | 不增加显式环境声明授权     |
| `source.knip`                 | 检查未使用工作区依赖和未使用源码模块   | 关闭；启用后须安装 `knip`  |

这些字段不选择全局源码集合。文件范围由 [`scope.source`](./source-boundary.md) 决定。

## 包归属与发现范围

Limina 从每个已验证、已激活包的独立治理范围发现源码，包括外部包和无名称包。包根的清单决定源码归属和依赖授权。相对 `config.rootDir` 的源码选择器可以包含 `../`，但只能过滤已发现的候选，不能把未激活目录加入治理。

默认情况下，嵌套 `package.json` 会停止外层包的遍历。启用 [`scope.regions.extendNestedPackageScopes`](./regions.md#extendnestedpackagescopes) 后，符合条件的无名嵌套作用域可以继续留在外层区域。其中源码使用外层包的依赖声明，嵌套清单仍负责相对导入和 `#imports` 的包作用域。嵌套工作区边界与区域排除的完整规则见[治理区域](./regions.md)。

## 资源模块导入

`source:check` 会检查 CSS、SVG、YAML、文本等资源文件是否存在，以及导入是否符合包授权和边界规则。缺少资源文件时会报告 `LIMINA_SOURCE_RESOURCE_MODULE_NOT_FOUND`。资源的类型是否可用由检查器负责，需要类型诊断时，还应运行相应的类型检查。

例如，给 `*.svg` 写了 TypeScript 环境声明，只能说明类型系统认识这类导入，不能证明某个 SVG 文件实际存在。反过来，文件存在也不能证明类型完整或构建工具支持处理它。资源导入本身不会产生声明提供者或项目引用，资源缺失也不会阻止 `graph prepare`。如果检查器将导入解析到实际实现文件，该实现仍按普通治理规则处理。

导入路径会保持原样：对于 `./foo.svg?raw` 和 `./foo.svg#fragment`，Limina 不会去掉后缀后检查 `./foo.svg`，也不会仅根据资源扩展名报告文件缺失。`package.json#imports` 的 `#assets/logo.svg` 保留完整的映射键名。

Limina 不定义运行环境如何处理这些查询参数。环境声明也不能证明虚拟模块或框架注入模块在运行时存在，Limina 不会把它们当成缺失的物理资源。

## `importAuthority`

`source.importAuthority` 用于处理源码所属包没有直接声明、但需要使用工作区根目录依赖的情况。

默认情况下，源码所属包的 `package.json` 必须在 `dependencies`、`devDependencies`、`peerDependencies` 或 `optionalDependencies` 中声明所导入的包。你可以按源码所属包添加授权，让指定范围使用治理根目录 `package.json` 中的依赖声明。根清单本身仍必须声明该依赖。

这里的“源码导入”包括 Limina 能收集到的静态导入、类型导入、再导出、字面量动态导入及受支持的 CommonJS 调用。`Node` 内置模块、虚拟模块、`URL` / `data` / `file` 说明符和注释中的说明符不按普通裸包依赖处理。

例如，`packages/create-app` 是工作区成员，包名为 `@example/create-app`。它的 `templates/react` 中有需要检查的模板源码。`react` 和 `react-dom` 已声明在工作区根目录的 `package.json` 中，但没有声明在这个包自己的清单中。可以在工作区根目录的 Limina 配置中授予这些模板使用根依赖声明的权限。已有配置时，请将 `importAuthority` 合并到 `source` 中：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: {
    importAuthority: {
      allow: {
        '@example/create-app': [
          {
            include: ['packages/create-app/templates/react/**'],
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
  allow: Record<string, SourceImportAuthorityWorkspaceRootGrant[]>;
}

interface SourceImportAuthorityWorkspaceRootGrant {
  include?: string[];
  workspaceRootDependencies: string[];
  reason: string;
}
```

`allow` 的键名必须对应当前治理区域内的源码所属包。具名工作区包使用包名；没有 `name` 的包使用相对于 `config.rootDir` 的包目录路径，必要时包含 `../`。

`include` 可选，路径相对于 `config.rootDir`，可以包含 `../`。它只能过滤键名对应包中已受治理的源码。省略时，授权适用于这个包下所有被 Limina 管辖的源码模块。

`workspaceRootDependencies` 不是直接导入允许清单。当源码所属包和 `include` 范围都匹配时，它说明哪些包名可以使用工作区根目录清单中的依赖声明。Limina 仍然要求根清单实际声明这个包。如果源码所属包和根目录之间的工作区包清单也声明了同一个包，根目录授权不会绕过这个中间清单。

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
  ambient: SourceAmbientDeclarationConfig[];
}
```

每个 `include` 数组都使用相对于 `config.rootDir` 的模式，外部激活包可以使用 `../`。这些模式只过滤已验证的包中发现的文件，不能让未激活目录或所属包边界之外的路径变得可见。每条规则必须至少匹配一个声明文件，同一个物理文件也不能同时匹配多条规则。

被匹配文件必须确实符合环境声明的结构。Limina 管理的输出声明、包的公开声明入口，以及包含普通导入或导出的外部声明模块，都不能重新归类为环境声明。

`allowSharedAcrossOwners` 默认为 `false`，只有多个源码所属包确实需要共同使用同一份环境声明时才设为 `true`。`allowTripleSlashReferences` 同样默认为 `false`，它只授权通过 `/// <reference path="...">` 访问匹配的声明文件，不会授权普通导入、包依赖或 `/// <reference types>`。

例如，假设 `../shared-types` 是已激活的包，其中的 `globals.d.ts` 是多个源码所属包需要共享的现有环境声明。请将路径改为项目中的实际包和文件：

```js
import { defineConfig } from 'limina';

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

::: warning 注意
`knip` 是 Limina 的可选对等依赖。如果启用了 `source.knip`，但运行 Limina 的工作区没有安装 `knip`，`source check` 会在源码分析开始前以缺少对等依赖错误失败。关闭 `source.knip` 时，Limina 不会解析或运行 Knip。如果持续集成需要覆盖未使用依赖和未使用模块检查，应显式安装并校验 `knip`。
:::

例如，在安装 Limina 的单包项目中安装当前源码版支持的 Knip：

```sh
pnpm add -D 'knip@^6.0.0'
```

在 pnpm 工作区根目录安装时，请加上 `-w`。然后在 Limina 配置中启用它。如果已有配置，请将 `source` 字段合并进去：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: { knip: true },
});
```

运行 `pnpm exec limina source check` 查看结果。分析结果取决于项目入口。报告文件未使用时，应先判断它是否由测试运行器、生成代码或其他工具加载，再决定如何处理。

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

type SourceKnipCheckConfig =
  | { root: SourceKnipWorkspaceConfig; workspaces?: Record<string, SourceKnipWorkspaceConfig> }
  | { root?: SourceKnipWorkspaceConfig; workspaces: Record<string, SourceKnipWorkspaceConfig> };
```

`source.knip` 只接受 `true`、`false` 或上面的对象形式。空对象、`null`、数组、标量、未知字段，以及不是对象的 `root` 或 `workspaces` 值，都会被判定为无效配置。

`source.knip.root` 是单包项目和工作区中配置治理根包的唯一方式，有无包名均可。根包入口、忽略规则、构建脚本推导、多 `tsconfig` 分组和检查结果都保留该包已经验证的归属关系。根包必须已经激活：`root` 不能重新激活已排除的根包。

`source.knip.workspaces` 的键名是已激活的具名非根工作区包名称，例如 `@acme/app`。未知或已排除的名称会让 `source check` 失败。根包请配置在 `root` 下，不能在 `workspaces` 中使用 `"."` 或根包名称。相对目录也不是这里支持的键名。没有名称的非根包仍有源码归属，但不能通过包名配置这个选项。

`source.knip.root` 和 `source.knip.workspaces[pkg]` 只配置额外可达入口和忽略规则。包级 `Knip tsconfig` 由静态、直接的 `limina build <config>` 脚本推导；没有这类脚本时，Limina 不传 `--tsConfig`，交给 `Knip` 使用自己的默认 `tsconfig` 行为。

静态包脚本可以覆盖这个默认行为，让 Limina 为这个包推导专用的 `Knip tsconfig` 来源：

```json
{
  "scripts": {
    "build": "limina build tsconfig.json"
  }
}
```

`<config>` 相对于这个包目录，必须是工作区内的 JSON 文件。使用 Limina 托管构建时，脚本必须指向 Limina 管理且存在输出构建模块的配置。使用原始构建时，脚本必须带上 `--raw --preset <tsc|tsgo|vue-tsc>`，配置还必须留在所属包目录里，并且不能指向生成的 `.limina` 配置。

脚本需要直接写出命令和配置路径，例如 `limina build tsconfig.json`、`limina build tsconfig.dts.json --raw --preset tsgo`、`pnpm limina build tsconfig.json` 或 `pnpm exec limina build tsconfig.json`。像 `limina build $CONFIG` 这样的动态 shell 脚本不受支持。npm、Yarn 或 Bun 项目也可以直接使用 `limina build`，但不支持在这里使用它们的命令包装形式。

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

配合前面的 `"build": "limina build tsconfig.json"` 包脚本，Limina 才会选择该配置作为包入口分析的依据。

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

`entry` 配置必须使用相对于 `config.rootDir` 的正向通配模式，且必须位于 `root` 或 `workspaces[pkg]` 对应的包目录内，并提供非空 `reason`。外部激活包使用 `../`；模式仍然只能过滤对应源码归属方已发现的源码模块集合。

### `root.ignoreDependencies` / `workspaces[pkg].ignoreDependencies`

- **类型：** `Array<{ dep: string; reason: string }>`

`source check` 会验证 `package.json` 中声明的工作区依赖能从导入方包的公开入口图触达。这个规则适用于每个工作区包，包括工作区根目录。

如果依赖确实由生成代码、运行时字符串或 `Knip` 看不见的路径使用，可以添加带原因的忽略条目：治理根包写在 `source.knip.root`，具名非根包写在 `source.knip.workspaces[pkg]`。

忽略条目的 `dep` 必须是已存在的工作区包，并且这个依赖关系仍然声明在 `root` 或 `workspaces[pkg]` 对应的导入方包清单中。确实需要保留时，把 `reason` 写在配置旁；不再需要时，应该删除依赖。

### `root.ignoreFiles` / `workspaces[pkg].ignoreFiles`

- **类型：** `Array<{ file: string; reason: string }>`

`ignoreFiles` 只用于确实要保留、但 `Knip` 看不见的源码模块。

忽略条目必须使用相对于 `config.rootDir` 的文件路径，并提供非空 `reason`。路径可以包含 `../`，但该文件还必须属于 `root` 或 `workspaces[pkg]` 对应包的已知源码模块集合。
