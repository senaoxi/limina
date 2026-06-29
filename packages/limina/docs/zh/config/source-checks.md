# 源码检查

::: warning
本页描述顶层 `source` 选项。它配置 `source:check` 中的两类行为：`source.importAuthority` 用于源码导入授权，`source.knip` 用于 Knip 驱动的未使用工作区依赖和未使用源码模块检查。它不同于 `config.source`，后者定义覆盖证明使用的全局源码边界。`config.source` 见 [源码边界](./source-boundary.md)。
:::

`source check` 的主线是让源码导入能被包归属和依赖声明解释。Limina 把 pnpm 发现的工作区包作为源码归属方，包括没有 `name`、只能用路径标识的工作区包。嵌套 `package.json` 仍然影响包解析，也会形成相对导入要遵守的包作用域；但只有被 pnpm 识别为工作区包时才会切分源码归属方。

Knip 驱动分支使用包入口而不是 `include` / `exclude`，报告未使用工作区依赖，以及基于 Limina 源码归属方模块集合识别出的未使用源码模块。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: {
    importAuthority: {
      allow: [],
    },
    knip: {
      workspaces: {},
    },
  },
});
```

## importAuthority

`source.importAuthority` 控制那些没有写在源码归属方清单文件里的裸包导入。

源码导入授权默认严格：最近的 pnpm 工作区源码归属方 `package.json` 必须在 `dependencies`、`devDependencies`、`peerDependencies` 或 `optionalDependencies` 中声明这个包。带 `packages` 的规则可以让 Limina 额外检查工作区根目录 `package.json` 中是否声明了匹配到的包名。根清单文件必须存在，并且仍然要在同样的依赖区里声明这个包。

这里的“源码导入”包括 Limina 能收集到的静态导入、类型导入和再导出。Node 内置模块、虚拟模块、URL/data/file 说明符和注释中的说明符不按普通裸包依赖处理。

如果某些文件的依赖确实由别的地方提供，可以写显式 allow rule：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  source: {
    importAuthority: {
      allow: [
        {
          files: ['packages/create-app/templates/react/**'],
          specifiers: ['react', 'react-dom'],
          reason: '模板文件会在生成后的应用里声明这些依赖。',
        },
      ],
    },
  },
});
```

```ts
interface SourceImportAuthorityAllowRule {
  files: string[];
  packages?: string[];
  specifiers?: string[];
  owner?: string;
  reason: string;
}

interface SourceImportAuthorityConfig {
  allow?: SourceImportAuthorityAllowRule[];
}
```

`files` 是工作区根目录相对 glob。`packages` 匹配 `react`、`@components/shared` 这样的包名；匹配后，工作区根目录 `package.json` 会成为这个包的额外依赖声明候选清单文件。`specifiers` 匹配 `react/jsx-runtime` 这样的完整导入说明符；只有确实不应该由任何清单文件声明的例外才使用它。三者都支持 glob。`owner` 可选；有值时，具名源码归属方用包名匹配，无名源码归属方用工作区根目录相对包目录匹配。

这个配置适合项目模板、文档别名等依赖不由导入方清单文件管理的源码。真正属于这个源码归属方运行时的导入，仍然优先写进清单文件。

## knip

- **类型：** `boolean | SourceKnipCheckConfig`
- **默认值：** `true`

`source.knip` 控制 `source:check` 中由 Knip 驱动的部分：未使用工作区依赖和未使用源码模块。

省略该选项或写 `knip: true` 时，Limina 使用自动生成的默认 Knip 配置。写 `knip: false` 时，会跳过这些 Knip 驱动的检查。对象形式表示按工作区包名配置 Limina 语义 Knip 规则：

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

`source.knip.workspaces` 的 key 是 pnpm 工作区中发现的包名，例如 `@acme/app`。如果 key 对应不到工作区包名，`source check` 会直接失败。没有 `name` 的工作区包仍然可以成为源码归属方，但不能放进 `source.knip.workspaces`，因为它没有稳定的包名 key。

`source.knip.workspaces[pkg]` 只配置额外可达入口和忽略规则。包级 Knip tsconfig 来源来自静态、直接的 `limina build <config>` 脚本；没有这类脚本时，Limina 不传 `--tsConfig`，交给 Knip 使用自己的默认 tsconfig 行为。

静态包脚本可以覆盖这个默认行为，让 Limina 为这个包推导专用的 Knip tsconfig 来源：

```json
{
  "scripts": {
    "build": "limina build tsconfig.json"
  }
}
```

`<config>` 会从这个包目录解析。它必须是工作区内的 JSON 文件。托管脚本必须指向 Limina 管理且存在输出构建模块的配置。raw 包脚本必须使用 `--raw --preset <tsc|tsgo|vue-tsc>`，配置还必须留在所属包目录里，并且不能指向生成的 `.limina` 配置。Limina 只支持 `limina build tsconfig.json`、`limina build tsconfig.dts.json --raw --preset tsgo`、`pnpm limina build tsconfig.json`、`pnpm exec limina build tsconfig.json` 这类直接静态写法。像 `limina build $CONFIG` 这样的动态 shell 脚本会被报告为不支持。

::: warning
`knip` 是 Limina 的可选 peer dependency。如果启用了 `source.knip`，但运行 Limina 的工作区没有安装 `knip`，`source check` 会直接报缺失 peer dependency。
:::

Limina 会为受治理的源码归属方工作区写入 `entry: []`，从而关闭 Knip 隐式的 `index` / `main` / `cli` 入口猜测。默认可达性仍然包含包清单入口（`exports`、`main`、`module`、`browser`、`bin`、`types`、`typings`）、Knip 插件推断入口、包脚本，以及 Limina 为应用型源码归属方生成的虚拟入口。

当包入口指向构建产物时，Knip 可能需要一个能说明 `rootDir` / `outDir` 的 tsconfig，才能把这些产物映射回源码文件。托管模式下，把这个布局写在源码叶子的 `liminaOptions.outputs` 中，再让包里的静态 `limina build <config>` 脚本指向托管源码配置或 solution 配置。如果使用包内手写构建 tsconfig，则使用 `limina build <config> --raw --preset <checker>`。

这是一种通用的包设计方式：`package.json` 面向消费者，只暴露构建后的 `dist` 文件；被选中的源码 tsconfig 描述会产出这些文件的源码树。例如 `@docs-islands/utils` 可以只写：

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

只要给 Knip 使用的 tsconfig（无论是 Knip 默认选择的，还是 Limina 推导出来的）能说明源码目录和输出目录（例如 `rootDir: "."`、`outDir: "./dist"`），Knip 就能把 `utils/dist/src/env.js` 反推成 `utils/src/env.ts`。这样源码模块就会被视为从包入口可达。

然后用静态包脚本暴露这个意图：

```json
{
  "scripts": {
    "build": "limina build tsconfig.json"
  }
}
```

反过来，如果推导出的 Knip tsconfig 没有清楚说明 `outDir` / `rootDir`，Knip 只能看到 `dist` 入口，却找不到对应的源码模块。这类源码文件可能会被报告为未使用模块。遇到这种情况，优先修正 `liminaOptions.outputs`，或使用显式 raw 的 `limina build <config> --raw --preset <checker>` 包内配置，而不是为了让 Knip 通过而给 `package.json` 补只给工具看的导出条件。

Knip 的 `project` 文件集合也由 Limina 根据受治理源码模块自动确定；用户不配置 `project`。

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

entry 配置必须使用正向的、工作区根相对的 glob，且必须位于 key 指向的包目录内，并提供非空 reason。

### workspaces[pkg].ignoreDependencies

- **类型：** `Array<{ dep: string; reason: string }>`

`source check` 会验证 `package.json` 中声明的工作区依赖能从导入方包的公开入口图触达。这个规则适用于每个工作区包，包括 workspace root。

如果依赖确实由生成代码、运行时字符串或 Knip 看不见的路径使用，可以在导入方包名 key 下添加 ignore entry。

ignore entry 的 `dep` 必须是已存在的工作区包，并且这个依赖关系仍然声明在 key 指向的导入方包清单中。确实需要保留时，把 reason 写在配置旁；不再需要时，应该删除依赖。

### workspaces[pkg].ignoreFiles

- **类型：** `Array<{ file: string; reason: string }>`

`ignoreFiles` 只用于确实要保留、但 Knip 看不见的源码模块。

ignore entry 必须使用工作区根相对文件路径，路径必须留在仓库内，并提供非空 reason。该文件还必须属于 key 指向的包的 Limina 已知源码模块集合。
