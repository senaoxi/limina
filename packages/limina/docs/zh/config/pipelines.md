# 流水线

流水线是 `limina check <name>` 可运行的命名工作流。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  pipelines: {
    publish: [
      'graph:check',
      'source:check',
      'proof:check',
      'checker:build',
      'checker:typecheck',
      'package:check',
      'release:check',
      {
        type: 'command',
        command: 'pnpm',
        args: ['test'],
      },
    ],
  },
});
```

## pipelines

- **类型：** `Record<string, PipelineStep[]>`

`pipelines` 把名称映射到一组有序步骤。`pnpm exec limina check <name>` 会按数组顺序调度该流水线的步骤，每一步都依赖前一步完成。它和默认 `limina check` 不同：默认检查会把内置任务作为可并发的独立任务调度；命名流水线会保留你写下来的顺序。

Limina 会在每个依赖工作区拓扑的内置步骤前插入共享 preparation `workspace:validate`。不要把它写进 `pipelines`，它也不是可配置的 `BuiltinTaskName`。验证失败时，依赖的源码、证明、图、检查器、包、发布或产物生成步骤会在读取或写入拓扑状态前被阻塞。

有序不等于所有失败都会立刻停止。内置任务失败会让最终流水线结果失败，但后续步骤仍会按顺序继续尝试；外部命令步骤失败会阻塞剩余步骤，并把它们记为 `skipped`。

::: tip
团队常用流程可以固定成命名命令，例如 `publish` 先类型检查、构建，再检查包输出。本地和 `CI` 共享同一份顺序，能减少手写脚本漂移。
:::

## 字符串步骤

字符串步骤可以是 Limina 内置任务：

- `checker:build`
- `checker:typecheck`
- `graph:prepare`
- `graph:check`
- `package:check`
- `proof:check`
- `release:check`
- `source:check`

也可以是简单外部命令。简单命令会按空白拆分；当参数里有空格、需要 `cwd` 或环境变量时，用对象形式更清楚。

`graph:prepare` 只负责物化图文件，不做校验。多数只做验证的流程可以直接使用 `graph:check`，因为图检查会在内存中计算所需结果，不会物化检查器配置。只有后续步骤确实需要磁盘文件时才添加 `graph:prepare`；检查器任务本身会自动获得物化 preparation。

## 对象命令步骤

- **类型：** `{ type: 'command'; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }`

对象形式显式声明外部命令：

```js
{
  type: 'command',
  command: 'pnpm',
  args: ['test'],
  cwd: 'packages/app',
  env: {
    NODE_ENV: 'test',
  },
}
```

`cwd` 相对于 `config.rootDir`。

## 对象任务步骤

- **类型：** `{ type: 'task'; name: BuiltinTaskName }`，其中 `BuiltinTaskName` 是 `'graph:prepare' | 'graph:check' | 'source:check' | 'proof:check' | 'checker:build' | 'checker:typecheck' | 'package:check' | 'release:check'`

如果你希望内置任务也保持显式形式，可以写：

```js
{
  type: 'task',
  name: 'source:check',
}
```

配置后，`pnpm exec limina check publish` 会按数组顺序运行。假设某次改动让源码出现跨包相对导入：

```ts
// packages/app/src/main.ts
import { createClient } from '../../core/src/index';
```

流水线会在 `source:check` 阶段记录失败，后面的构建、包检查和外部测试命令仍会按顺序尝试执行。最终结果会失败，用户可以先修最接近问题源头的检查。

::: details 完整一点的失败例子
目录可以是：

```text
packages/app/
  src/main.ts
packages/core/
  src/index.ts
```

模块里直接跨包相对导入：

```ts
// packages/app/src/main.ts
import { createClient } from '../../core/src/index';
```

运行 `pnpm exec limina check publish` 时，Limina 会按流水线数组顺序执行。`graph:check` 会先校验声明边，然后 `source:check` 分析包归属方和相对路径边界。

结果是流程在源码阶段记录失败，`checker:build`、`package:check` 和 `pnpm test` 仍会按顺序继续尝试。用户可以先修最近的源头问题：把跨包相对导入改成 `@acme/core` 包导出，并在清单文件和项目引用中表达这条依赖。

如果后续 `pnpm test` 这样的外部命令步骤失败，排在它后面的步骤会被阻塞并记为 `skipped`。这个阻塞行为只来自外部命令步骤，不来自内置检查任务。
:::
