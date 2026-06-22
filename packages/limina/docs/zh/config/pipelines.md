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

`pipelines` 把名称映射到一组有序步骤。`pnpm exec limina check <name>` 会按数组顺序运行该流水线的步骤，并在第一个失败处停止。

::: tip
团队常用流程可以固定成命名命令，例如 `publish` 先类型检查、构建，再检查包输出。本地和 CI 共享同一份顺序，能减少手写脚本漂移。
:::

## 字符串步骤

字符串步骤可以是 Limina 内置任务：

- `checker:build`
- `checker:typecheck`
- `graph:check`
- `package:check`
- `proof:check`
- `release:check`
- `source:check`

也可以是简单外部命令。简单命令会按空白拆分；当参数里有空格、需要 `cwd` 或环境变量时，用对象形式更清楚。

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

## 对象任务步骤

- **类型：** `{ type: 'task'; name: BuiltinTaskName }`，其中 `BuiltinTaskName` 是 `'graph:check' | 'source:check' | 'proof:check' | 'checker:build' | 'checker:typecheck' | 'package:check' | 'release:check'`

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

流水线会在 `source:check` 阶段失败，后面的构建、包检查和外部测试命令会被跳过。这样发布流程会停在最接近问题源头的检查上，而不是继续跑一串后续步骤。

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

结果是流程在源码阶段失败，`checker:build`、`package:check` 和 `pnpm test` 不会继续执行。用户可以先修最近的源头问题：把跨包相对导入改成 `@acme/core` 包导出，并在清单文件和项目引用中表达这条依赖。
:::
