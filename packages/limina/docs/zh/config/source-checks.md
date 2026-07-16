# 源码检查

::: warning
顶层 `source` 选项配置 `source:check` 中的三类行为：`source.importAuthority` 用于源码导入授权，`source.declarations` 管理显式 ambient declaration 角色，`source.knip` 用于 `Knip` 驱动的未使用工作区依赖和未使用源码模块检查。它不同于 `config.source`，后者定义覆盖证明使用的全局源码边界。`config.source` 见 [源码边界](./source-boundary.md)。
:::

`source check` 的主线是让源码导入能被包归属和依赖声明解释。Limina 会从每个已验证激活 package island 独立发现源码，包括外部包和没有 `name`、只能用路径标识的工作区包；每个工作区包根目录的清单是它的源码 owner。显式源码 selector 相对于 `config.rootDir`，可以包含 `../`，并且只过滤这些 island 已经产生的 candidate。

默认情况下，嵌套 `package.json` 会停止当前治理区域，嵌套 `pnpm-workspace.yaml` 则永远是自动生效的 owner-local boundary。启用 [`regions.extendNestedPackageScopes`](./regions.md#extendnestedpackagescopes) 后，满足条件的无名嵌套清单可以继续留在外层区域：其中源码继承外层工作区 owner 和依赖授权，这份嵌套清单仍负责相对导入和 `#imports` 的包作用域。[`regions.exclude`](./regions.md#exclude) 可以从当前运行中裁剪激活包或已识别的嵌套包作用域；导入任何已停止或被排除的区域都会按跨边界访问处理。

`Knip` 驱动分支使用包入口而不是 `include` / `exclude`，报告未使用工作区依赖，以及基于 Limina 源码归属方模块集合识别出的未使用源码模块。

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

## importAuthority

`source.importAuthority` 控制那些没有写在源码归属方清单文件里的裸包导入。

源码导入授权默认严格：最近的 `pnpm` 工作区源码归属方 `package.json` 必须在 `dependencies`、`devDependencies`、`peerDependencies` 或 `optionalDependencies` 中声明这个包。按源码归属方分组的授权可以让同一个源码归属方在指定范围内使用工作区根目录 `package.json` 的依赖声明。根清单文件必须存在，并且仍然要在同样的依赖区里声明这个包。

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

`allow` 的 key 必须匹配应用 `regions` 后仍留在当前治理区域内的源码归属方身份。具名工作区包使用包名；没有 `name` 的源码归属方使用相对于 `config.rootDir` 的词法包目录，必要时包含 `../`。`include` 可选并相对于 `config.rootDir`；它可以包含 `../`，但只能过滤 key 对应 owner 已受治理的源码。省略时，授权适用于这个源码归属方下所有被 Limina 管辖的源码模块。

`workspaceRootDependencies` 不是直接导入白名单。它只说明当源码归属方和 `include` 范围都匹配时，哪些包名可以读取工作区根目录清单中的依赖声明。Limina 仍然要求根清单实际声明这个包；如果源码归属方和根目录之间存在中间工作区包清单声明了同一个包，根目录授权不会绕过这个中间清单。

真正属于这个源码归属方运行时的导入，仍然优先写进归属方自己的清单文件。

## declarations.ambient

`source.declarations.ambient` 用于明确标记承担 TypeScript ambient 角色的声明文件，避免把它们当成普通的包归属声明 API。

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

每个 `include` 数组都使用相对于 `config.rootDir` 的 pattern；外部激活包可以使用 `../`。这些 pattern 只过滤已验证 package island 发现的文件，不能让未激活目录或 owner-local boundary 后方的路径变得可见。每条规则必须至少匹配一个声明文件，同一个物理文件也不能同时匹配多条规则。

被匹配文件必须确实符合 ambient declaration 的结构。Limina 管理的输出声明、包的公开声明入口，以及包含普通导入或导出的外部声明模块，都不能重新归类为 ambient declaration。

`allowSharedAcrossOwners` 默认为 `false`；只有多个源码 owner 确实需要共同使用同一份 ambient declaration 时才设为 `true`。`allowTripleSlashReferences` 同样默认为 `false`；它只授权通过 `/// <reference path="...">` 访问匹配的声明文件，不会授权普通导入、包依赖或 `/// <reference types>`。

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

## knip

- **类型：** `boolean | SourceKnipCheckConfig`
- **默认值：** `true`

`source.knip` 控制 `source:check` 中由 `Knip` 驱动的部分：未使用工作区依赖和未使用源码模块。

省略该选项或写 `knip: true` 时，Limina 使用自动生成的默认 `Knip` 配置。写 `knip: false` 时，会跳过这些 `Knip` 驱动的检查。对象形式表示按工作区包名配置 Limina 语义 `Knip` 规则：

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
  workspaces?: Record<string, SourceKnipWorkspaceConfig>;
}
```

`source.knip.workspaces` 的 `key` 是当前治理区域内的具名源码归属方，例如 `@acme/app`。未知或已排除的包名会让 `source check` 失败。没有 `name` 的工作区包仍然可以成为源码归属方，但不能放进 `source.knip.workspaces`，因为它没有稳定的包名 `key`。

`source.knip.workspaces[pkg]` 只配置额外可达入口和忽略规则。包级 `Knip tsconfig` 来源来自静态、直接的 `limina build <config>` 脚本；没有这类脚本时，Limina 不传 `--tsConfig`，交给 `Knip` 使用自己的默认 `tsconfig` 行为。

静态包脚本可以覆盖这个默认行为，让 Limina 为这个包推导专用的 `Knip tsconfig` 来源：

```json
{
  "scripts": {
    "build": "limina build tsconfig.json"
  }
}
```

`<config>` 会从这个包目录解析。它必须是工作区内的 `JSON` 文件。托管脚本必须指向 Limina 管理且存在输出构建模块的配置。原始包脚本必须使用 `--raw --preset <tsc|tsgo|vue-tsc>`，配置还必须留在所属包目录里，并且不能指向生成的 `.limina` 配置。Limina 只支持 `limina build tsconfig.json`、`limina build tsconfig.dts.json --raw --preset tsgo`、`pnpm limina build tsconfig.json`、`pnpm exec limina build tsconfig.json` 这类直接静态写法。像 `limina build $CONFIG` 这样的动态 Shell 脚本会被报告为不支持。

::: warning
`knip` 是 Limina 的可选对等依赖。如果启用了 `source.knip`，但运行 Limina 的工作区没有安装 `knip`，`source check` 会直接报缺失对等依赖。
:::

Limina 会为受治理的源码归属方工作区写入 `entry: []`，从而关闭 `Knip` 隐式的 `index` / `main` / `cli` 入口猜测。默认可达性仍然包含包清单入口（`exports`、`main`、`module`、`browser`、`bin`、`types`、`typings`）、`Knip` 插件推断入口、包脚本，以及 Limina 为应用型源码归属方生成的虚拟入口。

当包入口指向构建产物时，`Knip` 可能需要一个能说明 `rootDir` / `outDir` 的 `tsconfig`，才能把这些产物映射回源码文件。托管模式下，把这个布局写在源码叶子的 `liminaOptions.outputs` 中，再让包里的静态 `limina build <config>` 脚本指向托管源码配置或聚合配置。如果使用包内手写构建 `tsconfig`，则使用 `limina build <config> --raw --preset <checker>`。

这是一种通用的包设计方式：`package.json` 面向消费者，只暴露构建后的 `dist` 文件；被选中的源码 `tsconfig` 描述会产出这些文件的源码树。例如 `@docs-islands/utils` 可以只写：

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

只要给 `Knip` 使用的 `tsconfig`（无论是 `Knip` 默认选择的，还是 Limina 推导出来的）能说明源码目录和输出目录（例如 `rootDir: "."`、`outDir: "./dist"`），`Knip` 就能把 `utils/dist/src/env.js` 反推成 `utils/src/env.ts`。这样源码模块就会被视为从包入口可达。

然后用静态包脚本暴露这个意图：

```json
{
  "scripts": {
    "build": "limina build tsconfig.json"
  }
}
```

反过来，如果推导出的 `Knip tsconfig` 没有清楚说明 `outDir` / `rootDir`，`Knip` 只能看到 `dist` 入口，却找不到对应的源码模块。这类源码文件可能会被报告为未使用模块。遇到这种情况，优先修正 `liminaOptions.outputs`，或使用显式原始构建的 `limina build <config> --raw --preset <checker>` 包内配置，而不是为了让 `Knip` 通过而给 `package.json` 补只给工具看的导出条件。

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
              reason: 'Vitest 会直接加载 spec 模块。',
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
              reason: '框架会加载这个生成 runtime 模块。',
            },
          ],
        },
      },
    },
  },
});
```

### workspaces[pkg].entry

- **类型：** `Array<{ files: string[]; reason: string }>`

`entry` 用于声明包内合法的直接源码入口，但这些入口不应该成为包导出。例如测试运行器可能会直接加载 `*.spec.ts` 文件。

`entry` 配置必须使用相对于 `config.rootDir` 的正向 `glob`，且必须位于 `key` 指向的包目录内，并提供非空 `reason`。外部激活包使用 `../`；模式仍然只能过滤对应 owner 已发现的源码模块集合。

### workspaces[pkg].ignoreDependencies

- **类型：** `Array<{ dep: string; reason: string }>`

`source check` 会验证 `package.json` 中声明的工作区依赖能从导入方包的公开入口图触达。这个规则适用于每个工作区包，包括工作区根目录。

如果依赖确实由生成代码、运行时字符串或 `Knip` 看不见的路径使用，可以在导入方包名 `key` 下添加 `ignore entry`。

`ignore entry` 的 `dep` 必须是已存在的工作区包，并且这个依赖关系仍然声明在 `key` 指向的导入方包清单中。确实需要保留时，把 `reason` 写在配置旁；不再需要时，应该删除依赖。

### workspaces[pkg].ignoreFiles

- **类型：** `Array<{ file: string; reason: string }>`

`ignoreFiles` 只用于确实要保留、但 `Knip` 看不见的源码模块。

`ignore entry` 必须使用相对于 `config.rootDir` 的文件路径，并提供非空 `reason`。路径可以包含 `../`，但该文件还必须属于 `key` 指向的包的 Limina 已知源码模块集合。
