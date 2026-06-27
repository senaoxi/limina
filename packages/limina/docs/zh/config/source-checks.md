# 源码检查

::: warning
本页描述顶层 `source` 选项，也就是 `source:check` 运行的 **Knip 驱动依赖和模块可达性检查**。它不同于 `config.source`，后者定义 proof coverage 使用的治理文件边界。`config.source` 见 [源码边界](./source-boundary.md)。
:::

`source check` 负责包权限和普通 typecheck 归属检查。Limina 把 pnpm 发现的 workspace package 作为 source owner，包括没有 `name`、只能用路径标识的 workspace package。嵌套 `package.json` 仍然影响 package resolution，也会形成相对导入要遵守的 package scope；但只有被 pnpm 识别为 workspace package 时才会切分 source owner。

Knip 驱动分支使用包入口而不是 `include` / `exclude`，报告未使用工作区依赖，以及基于 Limina source owner 模块集合识别出的未使用源码模块。

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

`source.importAuthority` 控制那些没有写在 source owner manifest 里的裸包导入。

runtime import 默认严格：最近的 pnpm workspace source owner `package.json` 必须在 `dependencies`、`devDependencies`、`peerDependencies` 或 `optionalDependencies` 中声明这个包。带 `packages` 的规则可以让 Limina 额外检查 workspace root `package.json` 中是否声明了匹配到的包名。root manifest 必须存在，并且仍然要在同样的依赖区里声明这个包。

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

`files` 是工作区根相对 glob。`packages` 匹配 `react`、`@components/shared` 这样的包名；匹配后，workspace root `package.json` 会成为这个包的额外依赖声明候选 manifest。`specifiers` 匹配 `react/jsx-runtime` 这样的完整导入 specifier；只有确实不应该由任何 manifest 声明的例外才使用它。三者都支持 glob。`owner` 可选；有值时，具名 source owner 用包名匹配，无名 source owner 用工作区根相对包目录匹配。

这个配置适合项目模板、文档别名等依赖不是由导入方 manifest 管理的源码。真正属于这个 owner runtime 的导入，仍然优先写进 manifest。

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

`source.knip.workspaces` 的 key 是 pnpm workspace 中发现的包名，例如 `@acme/app`。如果 key 对应不到工作区包名，`source check` 会直接失败。没有 `name` 的 workspace package 仍然可以成为 source owner，但不能放进 `source.knip.workspaces`，因为它没有稳定的包名 key。

`source.knip.workspaces[pkg]` 只配置额外可达入口和忽略规则。包级 Knip tsconfig 来源来自静态、直接的 `limina build <config>` 脚本；没有这类脚本时，Limina 不传 `--tsConfig`，交给 Knip 使用自己的默认 tsconfig 行为。

静态 package script 可以覆盖这个默认行为，让 Limina 为这个包推导专用的 Knip tsconfig 来源：

```json
{
  "scripts": {
    "build": "limina build tsconfig.json"
  }
}
```

`<config>` 会从这个包目录解析。它必须是工作区内的 JSON 文件。托管脚本必须指向 Limina 管理且存在 output build module 的配置。raw package script 必须使用 `--raw --preset <tsc|tsgo|vue-tsc>`，配置还必须留在所属包目录里，并且不能指向生成的 `.limina` 配置。Limina 只支持 `limina build tsconfig.json`、`limina build tsconfig.dts.json --raw --preset tsgo`、`pnpm limina build tsconfig.json`、`pnpm exec limina build tsconfig.json` 这类直接静态写法。像 `limina build $CONFIG` 这样的动态 shell 脚本会被报告为不支持。

::: warning
`knip` 是 Limina 的 optional peer dependency。如果启用了 `source.knip`，但运行 Limina 的工作区没有安装 `knip`，`source check` 会直接报缺失 peer dependency。
:::

Limina 会为受治理的 owner workspace 写入 `entry: []`，从而关闭 Knip 隐式的 `index` / `main` / `cli` 入口猜测。默认可达性仍然包含 package manifest 入口（`exports`、`main`、`module`、`browser`、`bin`、`types`、`typings`）、Knip 插件推断入口、package scripts，以及 Limina 为 application-style owner 生成的 virtual entries。

当 package 入口指向构建产物时，Knip 可能需要一个能说明 `rootDir` / `outDir` 的 tsconfig，才能把这些产物映射回源码文件。托管模式下，把这个布局写在源码叶子的 `liminaOptions.outputs` 中，再让包里的静态 `limina build <config>` 脚本指向托管 source 或 solution 配置。如果使用包内手写构建 tsconfig，则使用 `limina build <config> --raw --preset <checker>`。

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

然后用静态 package script 暴露这个意图：

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

`entry` 用于声明包内合法的直接源码入口，但这些入口不应该成为 package exports。例如测试运行器可能会直接加载 `*.spec.ts` 文件。

entry 配置必须使用正向的、工作区根相对的 glob，且必须位于 key 指向的包目录内，并提供非空 reason。

### workspaces[pkg].ignoreDependencies

- **类型：** `Array<{ dep: string; reason: string }>`

`source check` 会验证 `package.json` 中声明的工作区依赖能从导入方包的公开入口图触达。这个规则适用于每个工作区包，包括 workspace root。

如果依赖确实由生成代码、运行时字符串或 Knip 看不见的路径使用，可以在导入方包名 key 下添加 ignore entry。

ignore entry 的 `dep` 必须是已存在的工作区包，并且这个依赖关系仍然声明在 key 指向的 importer package manifest 中。确实需要保留时，把 reason 写在配置旁；不再需要时，应该删除依赖。

### workspaces[pkg].ignoreFiles

- **类型：** `Array<{ file: string; reason: string }>`

`ignoreFiles` 只用于确实要保留、但 Knip 看不见的源码模块。

ignore entry 必须使用工作区根相对文件路径，路径必须留在仓库内，并提供非空 reason。该文件还必须属于 key 指向的包的 Limina 已知源码模块集合。
