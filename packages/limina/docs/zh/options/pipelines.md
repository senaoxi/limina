# Pipelines

Pipelines 是 `limina check <name>` 可运行的命名工作流。

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

## 字符串 step

字符串可以是 Limina 内置 task：

- `checker:build`
- `checker:typecheck`
- `graph:check`
- `nx:check`
- `package:check`
- `proof:check`
- `release:check`
- `source:check`

也可以是简单外部命令。简单命令会按空白拆分；当参数里有空格、需要 `cwd` 或环境变量时，用 object form 更清楚。

## object command step

object form 显式声明外部命令：

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

## object task step

如果你希望内置 task 也保持显式形式，可以写：

```js
{
  type: 'task',
  name: 'source:check',
}
```

团队常用流程可以固定成命名命令，例如 `publish` 先 typecheck、build，再检查 package output。本地和 CI 共享同一份顺序，能减少手写脚本漂移。

配置后，`pnpm exec limina check publish` 会按数组顺序运行。假设某次改动让源码出现跨包相对 import：

```ts
// packages/app/src/main.ts
import { createClient } from '../../core/src/index';
```

pipeline 会在 `source:check` 阶段失败，后面的 build、package check 和外部测试命令会被跳过。这样发布流程会停在最接近问题源头的检查上，而不是继续跑一串后续步骤。

完整一点看，目录可以是：

```text
packages/app/
  src/main.ts
packages/core/
  src/index.ts
```

模块里直接跨包相对 import：

```ts
// packages/app/src/main.ts
import { createClient } from '../../core/src/index';
```

运行 `pnpm exec limina check publish` 时，Limina 会按 pipeline 数组顺序执行。`graph:check` 会先校验 declaration edge，然后 `source:check` 分析 package owner 和相对路径边界。

结果是流程在 source 阶段失败，`checker:build`、`package:check` 和 `pnpm test` 不会继续执行。用户可以先修最近的源头问题：把跨包相对 import 改成 `@acme/core` package export，并在 manifest 和 project reference 中表达这条依赖。
