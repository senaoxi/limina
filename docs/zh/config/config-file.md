# 配置文件

Limina 会查找项目中的配置文件，例如 `package.json` 旁的 `limina.config.mjs` 或 `limina.config.mts`。初次接入可以保留默认行为，只在需要改变检查范围或规则时添加字段：

`limina.config.mjs`：

```js
import { defineConfig } from 'limina';

export default defineConfig({});
```

使用 `.mts` 或 `.ts` 时，配置文件本身也可能进入默认源码范围；如果没有被项目的 `tsconfig` 覆盖，请按[快速开始](../getting-started.md#最小手动配置)调整覆盖或源码范围。

配置模块可以导出对象、`Promise`，或接收 `{ command, mode }` 的函数。`defineConfig` 提供类型提示并保留传入值；实际加载和格式检查由 Limina 完成。各字段的职责见[配置概览](./index.md)。

## 默认检查 {#default-governance}

默认 `limina check` 固定计划五个任务：`graph:check`、`source:check`、`proof:check`、`checker:build` 和 `checker:typecheck`。`scope` 选择输入和 Checker；顶层 `graph`、`source`、`proof` 配置规则、例外及可选子能力，省略配置域不会关闭对应任务。`package.entries` 和 `release` 不增加默认任务。

将 `source.knip` 设为 `true` 可增加 Knip 分析。`false` 保留源码归属、tsconfig 治理、导入边界及包依赖授权检查。

导出 `{}` 会按默认输入和策略计划全部五个任务，但不保证检查成功：范围内的源码仍需要有合法归属和检查器覆盖。如果要配置 `graph`、`source` 或 `proof`，请提供相应字段，而不是写空对象：

- `graph` 需要 `rules`，没有额外规则时可写 `rules: {}`。
- `proof` 需要 `allowlist`，没有例外时可写 `allowlist: []`。
- `source` 至少需要 `knip`、`declarations` 或 `importAuthority` 之一。其中 `declarations` 需要 `ambient`，`importAuthority` 需要 `allow`；两者可以分别写成 `ambient: []` 和 `allow: {}`。对象形式的 `knip` 至少需要 `root` 或 `workspaces`。

这三个配置域及其内部字段不接受显式 `undefined`；需要使用默认值时，省略对应字段。未知字段、错误的字段类型和空的配置域会在加载时报错；需要结合工作区判断的路径、归属和覆盖问题由相应检查报告。

配置函数和 Promise 会在配置校验、任务选择之前执行。需要按条件省略 `source` 等字段时，可以使用条件对象展开；不要返回 `source: undefined`。动态值应在配置函数中算好，再返回普通数据。

::: details 配置数据有哪些限制

`graph`、`source` 和 `proof` 必须是配置对象自身的数据属性；顶层字段可以是不可枚举属性，内部字段则必须是普通对象或数组上的可枚举数据属性。这些域不接受 getter、setter、Proxy、继承字段或循环结构。校验会保留 `false` 和空集合，不会自动补值或删除字段。Knip 的 `Symbol.toStringTag` 字符串标记只作为元数据，不能让空的 `knip` 对象变为有效配置。

:::

必要准备失败时，依赖它的任务会标记为 `blocked`；没有目标的框架检查会标记为 `disabled`。命名流水线只记录它声明的任务及必要准备。`check --issues` 读取保存的结果，不重新检查；如果错误发生在本次检查尝试登记之前，查询可能仍显示上一次结果，应结合时间和终端输出判断。独立的 `graph check`、`source check` 和 `proof check` 也可以在省略对应顶层配置时执行。

## 配置发现与治理根 {#治理根}

Limina 先选择配置模块。未指定 `--config` 时，从当前工作目录向上逐目录查找，每个目录依次检查 `limina.config.mts`、`limina.config.mjs`、`limina.config.ts`、`limina.config.js`。随后从所选配置的目录寻找最近的 `package.json`，由它固定治理根。最近清单不可读、不是普通文件、JSON 格式错误或顶层不是对象时，在该位置失败，不跳过它。

只有该根自身的工作区声明决定成员集合。没有声明时，区域排除之前的唯一包就是根包。`{}` 已经足够：名称、版本、包管理器和锁文件都可缺省。包管理器元信息缺失、存在歧义或声明无效，不阻断无需包管理器语义的治理。

在选定根目录内，`pnpm-workspace.yaml` 优先；它可以确定 pnpm，除非显式 `packageManager` 与它冲突。`package.json#workspaces` 则需要明确的 npm、Yarn 或 Bun 包管理器：自身的 `packageManager` 优先，否则使用同目录锁文件。无法确定包管理器依据、存在歧义或声明无效时均失败；即使最终只有根包，有效工作区仍按工作区处理。

Limina 可读取的工作区声明形式包括 pnpm 的 `packages: string[]`（缺省表示没有子包）、npm 的 `workspaces: string[]`，以及 Yarn 或 Bun 的该数组或 `{ packages: string[] }`。包管理器适配器保留各自的成员选择和忽略规则。依赖版本目录（`catalog`）是否合法、依赖能否安装、版本是否可用，以及锁文件是否一致，仍由包管理器负责。

文档中的 `config.rootDir` 指加载器确定的治理根目录，是运行时解析结果，不是供用户填写的配置字段，也不是 TypeScript 的 `compilerOptions.rootDir`。除另有说明外，Limina 配置里的路径都相对这个目录。

选定同一个配置后，从不同目录调用会保持同一个治理根。选择仓库根配置治理其工作区，选择子包配置则使用子包最近的包清单；配置文件所在目录不必就是包根。显式 `--config` 相对于命令的当前工作目录解析。

```sh
pnpm exec limina --config ./limina.config.mts check
```

工作区成员的发现与排除规则见[治理区域](./regions.md)。

### 问题查询的定位方式

只读 `check --issues` 不导入配置、不解析包管理器成员关系，也不执行检查。显式 `--config` 只作为定位锚点，因此该模块可以已被删除或重命名；其目录向上最近的 `package.json` 仍须存在且有效。没有 `--config` 时，必须能发现当前存在的默认配置。缺少记录不会触发向祖先工作区回退。

## 配置加载器 {#config-loader}

- **类型：** `'native' | 'tsx'`
- **默认值：** `'native'`
- **CLI：** `--config-loader native` 或 `--config-loader tsx`

`native` 加载器会通过当前运行时直接导入配置，并遵循运行时的模块规则。因此，当 Node 把已有的 `limina.config.js` 视为 CommonJS 时，该文件可以使用 CommonJS；`.mts` 和 `.mjs` 使用 ESM。当配置使用了当前运行时无法原生导入的 TypeScript 语法时，使用 `tsx`。`tsx` 加载器使用 `tsx/esm/api`，因此使用前需要在接入工作区安装 `tsx`。

## `cache` {#cache}

- **类型：** `boolean | CacheOptions`
- **默认值：** `true`

`cache` 控制 Limina 是否在不同命令运行之间复用分析结果，默认开启。设为 `false` 后，Limina 不会读取或保存持久化分析结果，但会保留已有缓存文件，并照常加载配置和检查运行期间的输入变化。内存缓存、TypeScript／Vue 的 `.tsbuildinfo`、问题记录等其他数据有各自的行为，不受这个开关控制。

对象形式启用缓存，并要求显式包含 `dependencies: string[]`。空数组合法，`{}` 非法；`enabled`、`force` 等未知字段会报错。`limina` 公开导出 `CacheOptions`。

`limina check` 可以读取缓存，也可以保存符合条件的新结果；独立的图检查和源码检查只读取缓存。需要跳过本次缓存恢复时，可以运行 `limina check --force`：它通常仍会保存符合条件的新结果。`cache: false` 时，`--force` 不会重新启用缓存写入。

`--force` 不删除本项目、其他配置或其他 Git 工作树的缓存，也不强制重建检查器自己的缓存；它不能与只查询结果的 `--issues` 一起使用。

缓存有效时，Limina 可以复用已保存的分析结果；输入变化时会重新分析受影响的部分。恢复缓存时仍会检查类型入口、源码覆盖、项目引用和输出配置等输入。实际类型诊断和构建由检查器另行执行。

### `cache.dependencies` {#cache-dependencies}

- **类型：** `string[]`（对象形式必填）
- **默认值：** 省略 `cache` 或 `cache: true` 时不声明额外文件

如果配置通过 Node 模块系统之外的方式读取本地文件，并且文件内容会影响配置或检查结果，请在 `cache.dependencies` 中声明它。

例如，在 Limina 配置文件旁创建 `rules.json`：

```json
{
  "browser": {
    "deny": {
      "deps": [{ "name": "node:*", "reason": "浏览器代码不能依赖 Node 内置模块" }]
    }
  }
}
```

下面的 `limina.config.mjs` 用 `fs.readFileSync()` 读取该文件，并将它声明为缓存依赖：

```js
import { defineConfig } from 'limina';
import { readFileSync } from 'node:fs';

const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8'));

export default defineConfig({
  cache: { dependencies: ['./rules.json'] },
  graph: { rules },
});
```

如果项目已有 Limina 配置，请将这些字段合并进去。`browser` 规则只作用于使用该标签的源码配置，具体设置方式见[图规则](./graph-rules.md)。

声明的文件不要求被配置代码实际读取；策略文件、人工维护的失效标记文件也会参与有效性判断。`cache: { dependencies: [] }` 启用缓存但不声明额外文件。

相对路径以选定的配置文件所在目录为基准，即使该目录不同于治理根。支持绝对路径和 `../`；路径会归一化、合并重复声明，并保留符号链接绑定。已作为模块观测的文件保留模块角色。声明允许文件暂时不存在，但不会让直接调用的 `readFileSync()` 自动容忍缺失。缺失状态同样被记录：创建、删除、符号链接改指及声明集合变化都会参与缓存失效判定。目录、glob、URL、空路径和非字符串元素会报错；暂不支持递归监视或回调。

Limina 使用文件修改时间和内容哈希判断缓存是否可复用：修改时间不变时会复用已有哈希；修改时间变化时会重新计算。只是更新时间、内容没有变化，可以继续复用；内容变化会使该配置的分析缓存失效，即使最终配置值相同。如果外部操作可能在改变内容后恢复原来的修改时间和文件绑定，应使用 `--force` 重新分析。

Limina 在配置求值后注册声明，并在分析使用及分析快照发布前重新读取已观测文件，并检查绑定。这些调用内检查直接比较捕获的字节，独立于跨进程的 mtime／hash 快捷判断。发生漂移会中止命令，不重放已完成的 checker 或写操作。这无法证明用户此前直接调用 `fs` 时读到的字节与注册依赖时相同。应协调外部文件生产者，让文件在配置求值和检查期间保持稳定。

### 自动模块观测及其边界

每次启动 CLI 都会重新求值配置。Limina 会在加载阶段观察实际执行的 ESM、CommonJS 和动态导入，以及相应的解析结果。已加载模块或解析关系变化时，缓存会失效；没有执行的动态导入不会因为写在代码里就成为缓存依赖。

自动观察只覆盖能够可靠识别的模块加载，不会发现所有 JavaScript 副作用。通过其他方式读取 JSON、YAML 或文本文件时，请使用 `cache.dependencies`。如果加载器无法提供足够的源码或模块信息，Limina 会重新分析；例如 `tsx` 的 CommonJS 扩展钩子绕过源码观察时就是如此。

无法识别的 Node 启动选项 `--require`、`--import`、`--loader` 及对应的 `NODE_OPTIONS` 覆盖会在配置求值前被拒绝，因为它们可能保留过期的模块解析状态。需要受支持的转换加载时，可使用 `pnpm exec limina --config-loader tsx check`。

配置函数可以在返回数据前执行导入；如果返回的配置仍包含可执行回调或无法可靠识别的值，Limina 不会读取或保存持久化分析结果。观察结束后才加载的模块不在自动依赖范围内。每条 CLI 命令使用新的进程，不提供嵌入进程内的配置热更新保证。

`cache.dependencies` 只描述文件，不能直接记录环境变量、网络请求、时间、随机值或外部服务。可能的话，应让这些输入的影响体现在返回的配置数据中；无法判断缓存是否有效时，使用 `--force` 重新分析。只查询记录的 `check --issues` 仍不执行配置。

## `mode`

- **类型：** `string`
- **优先级：** `--mode` → `NODE_ENV` → `'default'`

`mode` 把环境名称传给配置函数，具体差异由函数决定。例如，`limina --mode ci check` 让函数收到 `mode: 'ci'`，不会自动启用某套 CI 规则。

## `command`

- **类型：** `'check' | 'graph' | 'package' | 'proof' | 'release' | 'source' | (string & {})`

`command` 表示当前加载配置的命令族。开放字符串类型还容纳 `build`、`migration` 等当前值，不代表这些名称都对应同名顶层命令。

| 调用                                                | 配置函数收到的 `command`                |
| --------------------------------------------------- | --------------------------------------- |
| `check`、`check <name>`                             | `'check'`                               |
| `graph ...`、`source check`、`proof check`          | 对应的 `'graph'`、`'source'`、`'proof'` |
| `package check`、`release check`                    | 对应的 `'package'`、`'release'`         |
| 不带配置路径的 `checker build`、`checker typecheck` | `'check'`                               |
| `checker build <config>`、`build <config>`          | `'build'`                               |
| `limina-migrate`                                    | `'migration'`                           |

包输出条目不仅供包检查和发布检查使用，`outDir` 还会参与工作区输出范围的识别和源码过滤。如果日常检查也需要把目录识别为输出，应在日常检查时保留对应条目。

如果项目不需要在日常检查时声明这些输出，可以按命令族提供条目：

```ts
import { defineConfig } from 'limina';

export default defineConfig(({ command }) => ({
  ...(command === 'package' || command === 'release'
    ? {
        package: {
          entries: [{ name: '@acme/core', outDir: 'packages/core/dist' }],
        },
      }
    : {}),
}));
```

这样日常 `check` 不会收到这些条目，独立的 `package check` 和 `release check` 则要求对应输出已经构建。

命名流水线只以 `command: 'check'` 加载一次配置；其中的 `package:check`、`release:check` 步骤不会重新按自己的命令族加载。要在流水线中使用包输出，须在这次配置求值时返回条目。例如，根据 `mode === 'release'` 提供条目，再运行 `limina --mode release check publish`。外部命令执行后也不会重新求值配置。

## 公开 API

公开 `limina` 入口导出 `defineConfig`、配置与问题类型，以及验证错误类。`limina/internal/*` 仅供仓库内部使用，其源码导出会从发布包移除，不属于消费者 API。

## 配置结构 {#config-domains-migration}

`scope` 选择治理区域、源码和检查器入口。`graph`、`source`、`proof`、`package`、`release`、`pipelines`、`concurrency` 和 `cache` 都是顶层字段；可以按需要逐项配置，未填写的字段使用相应默认行为。

配置路径的基准并不完全相同：源码和区域选择器相对于治理根 `config.rootDir`，而 `cache.dependencies` 相对于配置文件所在目录。`package.entries[].outDir` 即使在没有运行包检查时，也会参与输出目录发现和源码过滤。各字段的用途见[配置概览](./index.md)。
