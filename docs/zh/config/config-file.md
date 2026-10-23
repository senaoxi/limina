# 配置文件

Limina 通常读取项目 `package.json` 旁的 `limina.config.mts`。初次接入可以保留默认行为，只在需要改变检查范围或规则时添加字段：

```ts
import { defineConfig } from 'limina';

export default defineConfig({});
```

配置模块可以导出对象、`Promise`，或接收 `{ command, mode }` 的函数。`defineConfig` 提供类型提示并保留传入值；实际加载和格式检查由 Limina 完成。各字段的职责见[配置概览](./index.md)。

## 默认治理与迁移 {#default-governance}

默认 `limina check` 始终计划 `checker:build` 和 `checker:typecheck`；只有对应顶层域含有合法显式字段时，才加入 `graph:check`、`source:check` 和 `proof:check`。`scope` 选择输入和 Checker，不启用这些治理任务；`package.entries` 和 `release` 也不增加默认任务。

要启用三个治理域，可配置：

```ts
export default {
  graph: { rules: {} },
  source: { knip: false },
  proof: { allowlist: [] },
};
```

将 `source.knip` 设为 `true` 可增加 Knip 分析。`false` 保留源码归属、tsconfig 治理、导入边界及包依赖授权检查。

导出 `{}` 会运行核心工作流及两个 Checker 任务。显式声明上述三个域即可恢复此前五任务的默认覆盖，无需创建流水线。空域（`graph: {}`、`source: {}`、`proof: {}`）、未知字段、非对象域值以及显式 `undefined` 均为配置错误；需要缺省时应省略字段。配置 Graph、Proof 时分别必须声明 `rules`、`allowlist`，允许空集合。Source 至少声明 `knip`、`declarations`、`importAuthority` 之一；后两个包装分别要求 `ambient` 和 `allow`，允许 `ambient: []`、`allow: {}`。Knip 对象必须声明 `root` 或 `workspaces`，因此 `knip: {}` 无效。嵌套未知字段及错误元素类型在加载时失败；依赖工作区事实的规则、owner、路径和覆盖诊断仍属于领域检查。

配置函数及 Promise 在校验和任务选择前执行并等待完成。动态缺省应使用条件展开，不应返回 `source: undefined`。治理域必须是自有数据属性，支持非枚举的顶层域；域内字段须为普通对象或数组上的可枚举数据属性。拒绝 accessor、Proxy、继承字段与循环结构；动态值应在配置函数内计算。验证保留 `false` 和空集合，不补默认值、不剥离字段。既有 Knip `Symbol.toStringTag` 字符串标记仅为元数据，不能使空对象有效。

未选中的治理任务不会出现在本次记录中，也不会生成 `passed`、`disabled` 或 `skipped` 状态。已计划但没有目标的框架检查仍为 `disabled`。`check --issues` 读取保存的调用；新 attempt 发布前的配置错误不会把上一条历史记录变成本次成功。独立的 `graph check`、`source check`、`proof check` 及流水线中显式声明的步骤仍可在缺少顶层域时执行。

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

`cache` 控制 Limina 的持久化分析缓存。省略或设为 `true` 都启用缓存及自动模块依赖观测。设为 `false` 则不恢复、不发布持久化分析模型，保留已有 snapshot，继续执行配置加载、普通输入观测和执行期漂移检查。执行期内存缓存、TypeScript／Vue `.tsbuildinfo` 等 checker 构建缓存、issues 记录及其他独立产物仍遵守各自的正常行为。

对象形式启用缓存，并要求显式包含 `dependencies: string[]`。空数组合法，`{}` 非法；`enabled`、`force` 等未知字段会报错。`limina` 公开导出 `CacheOptions`。旧顶层 `configDependencies` 已移除，继续使用会产生配置错误；应将其数组移到 `cache.dependencies`。

`check` 可以读取并发布具备资格的模型；独立 graph／source 消费者保留原有只读权限。启用 `cache` 不会让所有命令获得发布权限。`limina check [pipeline] --force` 跳过本次恢复，通常仍发布本次具备资格的新结果。配置为 `cache: false` 时，force 在持久化分析缓存层面没有额外效果，也不会开启写入。Force 不删除本配置、其他配置或其他 worktree 的 snapshot，不强制重建 checker，仍不能与 `--issues` 合用。

Native 冷分析使用物理截断的 TypeScript Program 收集证据；完整有效的 context/graph 缓存可在新进程中无分析 Program 恢复。输入变化会重新采集受影响 context，实际 Checker 诊断与构建仍单独执行。Schema 9 拒绝旧 Programless 成功快照并按需冷重建，不删除旧缓存、其他命名空间或 Checker 的 `.tsbuildinfo`。类型入口、Coverage、原始 references 和输出投影在恢复时分别验证。

### `cache.dependencies` {#cache-dependencies}

- **类型：** `string[]`（对象形式必填）
- **默认值：** 省略 `cache` 或 `cache: true` 时不声明额外文件

启用缓存时，warm 表示复用通过有效性检查的持久化分析模型，cold 表示重新建立当前分析；两者都会在新的 CLI 进程中求值配置。用它声明绕过 Node 模块系统读取、但会影响配置或检查结果的明确本地文件。例如，通过 `fs.readFileSync()` 读取的 JSON 文件需要显式声明：

```ts
import { defineConfig } from 'limina';
import { readFileSync } from 'node:fs';

const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8'));

export default defineConfig({
  cache: { dependencies: ['./rules.json'] },
  graph: { rules },
});
```

声明的文件不要求被配置代码实际读取；策略文件、人工维护的失效标记文件也会参与有效性判断。`cache: { dependencies: [] }` 启用缓存但不声明额外文件。

相对路径以选定的配置文件所在目录为基准，即使该目录不同于治理根。支持绝对路径和 `../`；路径会归一化、合并重复声明，并保留符号链接绑定。已作为模块观测的文件保留模块角色。声明允许文件暂时不存在，但不会让直接调用的 `readFileSync()` 自动容忍缺失。缺失状态同样被记录：创建、删除、符号链接改指及声明集合变化都会参与缓存失效判定。目录、glob、URL、空路径和非字符串元素会报错；暂不支持递归监视或回调。

声明文件与模块共用配置输入快照。文件 mtime 相同时复用旧 content hash；mtime 变化时重新计算该文件的 hash。因此，只 touch 而字节相同可继续 warm；字节不同则使整个配置的旧 analysis model 失效，即使最终配置值没有变化。恢复旧 mtime 和绑定可能掩盖内容变化；不满足这一信任条件时，使用 `--force` 重建分析快照。

Limina 在配置求值后注册声明，并在分析使用及分析快照发布前重新读取已观测文件，并检查绑定。这些调用内检查直接比较捕获的字节，独立于跨进程的 mtime／hash 快捷判断。发生漂移会中止命令，不重放已完成的 checker 或写操作。这无法证明用户此前直接调用 `fs` 时读到的字节与注册依赖时相同。应协调外部文件生产者，让文件在配置求值和检查期间保持稳定。

### 自动模块观测及其边界

每个独立 CLI 进程都会求值当前配置。同步 Node Runtime Hook 在这一加载阶段观测实际 ESM import、执行到的 `import(variable)`、CJS 与 `createRequire()` 请求，包括原始 specifier、解析目标、conditions、attributes、文件绑定及可观测的 Loader 输出。实际加载的模块或解析关系变化会使旧分析失效。未执行的动态 import 不产生依赖，也不会仅因表达式存在而禁止 warm。

这套机制只覆盖能够可靠观测的模块加载事实，不自动发现所有 JavaScript 副作用。通过模块系统之外的方式读取 JSON、YAML、文本等本地文件时，需要显式声明；普通配置无需接受完整的 JavaScript I/O 审计才能使用缓存。源码未观测、不透明模块 scheme 或其他 Loader 证据不足仍使分析 cold。保留 native 和 tsx 执行能力；tsx CommonJS 的 extension hook 绕过源码观测时仍 cold。无法识别的自定义 Node 启动 `--require`、`--import`、`--loader` 及对应 `NODE_OPTIONS` 覆盖会在求值前被拒绝，因为它们可能留下过期的模块解析状态。移除这些覆盖；需要受支持的转换加载时，运行 `pnpm exec limina --config-loader tsx check`。

配置工厂可以在返回数据前执行 import；返回的配置中保留的可执行回调和不透明值无法取得稳定的有效配置版本，因此不恢复或发布持久化 analysis model。观测结束后的模块加载没有自动依赖保证。支持的模型是每条命令使用新的 CLI 进程，不承诺嵌入进程内的配置热更新。

`cache.dependencies` 只描述文件，不能覆盖环境变量、网络请求、时间、随机值或外部服务。有效配置版本只保护它实际表示的结果，无法代表隐藏行为。能够表达时，应把这些输入的影响体现在求值后的数据中；无法建立有效性时，沿用 cold／unknown 策略或使用 `--force`。只查询记录的 `check --issues` 仍不执行配置。

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

只有独立包检查和发布检查需要的输出条目，可以按命令族提供：

```ts
import { defineConfig } from 'limina';

export default defineConfig(({ command }) => ({
  package:
    command === 'package' || command === 'release'
      ? {
          entries: [{ name: '@acme/core', outDir: 'packages/core/dist' }],
        }
      : undefined,
}));
```

这样日常 `check` 不会收到这些条目，独立的 `package check` 和 `release check` 则要求对应输出已经构建。

命名流水线只以 `command: 'check'` 加载一次配置；其中的 `package:check`、`release:check` 步骤不会重新按自己的命令族加载。要在流水线中使用包输出，须在这次配置求值时返回条目。例如，根据 `mode === 'release'` 提供条目，再运行 `limina --mode release check publish`。外部命令执行后也不会重新求值配置。

## 公开 API

公开 `limina` 入口导出 `defineConfig`、配置与问题类型，以及验证错误类。`limina/internal/*` 仅供仓库内部使用，其源码导出会从发布包移除，不属于消费者 API。

## 配置结构迁移 {#config-domains-migration}

这是对已有 beta 公共配置 API 的破坏性变更。旧字段和新旧混合配置都会被拒绝，并给出迁移路径；不会静默忽略或自动转换旧字段。整体移动各字段的原值，保留其中未在示例中列出的选项。

| 旧路径                       | 新路径                         |
| ---------------------------- | ------------------------------ |
| `config.source`              | `scope.source`                 |
| `config.checkers`            | `scope.checkers`               |
| `regions`                    | `scope.regions`                |
| `graph`                      | `graph`                        |
| `source`                     | `source`                       |
| `proof`                      | `proof`                        |
| `package`                    | `package`                      |
| `release`                    | `release`                      |
| `pipelines`                  | `pipelines`                    |
| `execution.tasks`            | `concurrency.tasks`            |
| `execution.checkerBuild`     | `concurrency.checkerBuild`     |
| `execution.checkerTypecheck` | `concurrency.checkerTypecheck` |
| `execution.packageEntries`   | `concurrency.packageEntries`   |
| `execution.releaseEntries`   | `concurrency.releaseEntries`   |
| `cache`                      | `cache`                        |

`scope`、`pipelines`、`concurrency`、`cache` 和各检查字段均可省略。只有治理边界归入 `scope`；`graph`、`source`、`proof`、`package`、`release` 和 `pipelines` 保留顶层路径，`concurrency` 替代原来的 `execution` 字段。不接受 `checks` 或 `execution` 包装层。`scope.source.exclude: []` 仍不合法；省略字段才使用默认排除规则，`...` 仍用于把默认规则带入显式数组。

保留的子字段继续由原消费方处理，包括 `graph.rules`、`source.declarations`、包 entry 的工具选项和 `release.npmPackageJsonLint`。`package.entries[].outDir` 仍参与 workspace 输出根发现、边界校验和源码过滤，即使没有运行 `package:check`。

配置模块仍可导出对象、Promise 或接收 `{ command, mode }` 的函数。文件选择器仍相对于解析后的治理根 `config.rootDir`；`cache.dependencies` 仍相对于所选配置文件所在目录。CLI 命令、pipeline 步骤和并发默认值不变。旧分析实现的快照会冷启动重建；不会清空其他配置、worktree 或 checker 缓存。

旧的 `SharedLiminaConfig` 类型由 `ScopeConfig` 取代。`ExecutionConfig` 继续描述五个并发参数，现用于 `concurrency`。
