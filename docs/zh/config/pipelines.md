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

## `pipelines`

- **类型：** `Record<string, PipelineStep[]>`

`pipelines` 把名称映射到一组有序步骤。`pnpm exec limina check <name>` 会按数组顺序调度该流水线的步骤，每一步都依赖前一步完成。它和默认 `limina check` 不同：默认检查会把内置任务作为可并发的独立任务调度；命名流水线会保留你写下来的顺序。

Limina 会在依赖工作区拓扑的内置工作前插入共享准备步骤 `workspace:validate`。包含 `graph:prepare`、`checker:build` 或 `checker:typecheck` 的任务段，还会在全部内置任务前获得共享准备步骤 `graph:materialize`。准备步骤自动注入，不是可配置的 `BuiltinTaskName` 步骤。必要准备步骤失败时，依赖任务会在消费拓扑或生成文件前记录为 `blocked`（被阻塞）。

准备步骤成功后，已执行内置任务失败会让最终结果失败，但后续步骤仍按顺序尝试。外部命令失败会停止剩余步骤，并记为 `skipped`（已跳过）。

外部命令会分隔分析代次。Limina 在进入下一代次前等待当前工作结束，释放默认输入数据提供组件，并重新创建数据提供与查询缓存，以及产物命名空间。下一代次仍复用已加载的配置对象，命令后不会重新执行配置模块或函数。

::: tip 提示
将团队共用流程配置为命名流水线，本地脚本和持续集成便可运行相同的步骤与顺序。例如，`publish` 可以先做类型检查和构建，再检查包输出。
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

也可以是简单外部命令。简单命令会按空白拆分；当参数里有空格、需要 `cwd` 或环境变量时，应使用对象形式。

`graph:prepare` 会验证输入并物化图文件，但不执行图治理检查或编译器。只做验证的流程可使用 `graph:check`，它在内存中计算图，不物化检查器配置。检查器任务会自动获得物化准备步骤。`checker:build` 产出 Limina 内部声明；如果需要生成消费者产物，应在 `package:check` 或 `release:check` 前添加项目自己的构建命令。

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

内置任务也可以写成对象：

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

流水线会在 `source:check` 阶段记录失败，后面的构建、包检查和外部测试命令仍会按顺序尝试执行。最终结果会失败。修正源码导入后，再重新运行流水线。

::: details 跨包导入示例
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

共享准备步骤成功时，跨包相对导入可能在源码阶段产生失败，后续内置步骤与 `pnpm test` 仍按顺序尝试。应改用已授权的 `@acme/core` 包导出，并在导入方源码所属包的清单中声明依赖；Limina 再根据检查器证据推导符合条件的项目关系，不要求在源码叶子配置中手写 `references`。

如果后续 `pnpm test` 这样的外部命令失败，剩余步骤记为 `skipped`（已跳过）；必要准备步骤失败则可能把依赖任务记为 `blocked`（被阻塞）。
:::
