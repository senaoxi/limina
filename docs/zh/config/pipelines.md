# 流水线

流水线把团队共用的步骤保存在配置中，通过 `limina check <name>` 按顺序运行。下面的 `publish` 只做发布前检查，假设项目已有 `pnpm build` 和 `pnpm test` 脚本，并已配置待检查的 `package.entries`：

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
      { type: 'command', command: 'pnpm', args: ['build'] },
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

运行 `pnpm exec limina check publish --package @acme/core` 即可选择这条流水线及同名包输出。`checker:build` 生成 `.limina` 内部声明，示例中的 `pnpm build` 才负责准备消费者产物。

## `pipelines`

- **类型：** `Record<string, PipelineStep[]>`

`pipelines` 把名称映射到一组有序步骤。`pnpm exec limina check <name>` 会按数组顺序调度该流水线的步骤，每一步都依赖前一步完成。它和默认 `limina check` 不同：默认检查会把内置任务作为可并发的独立任务调度；命名流水线会保留你写下来的顺序。

名称只选择 `pipelines[name]`。例如，`limina check graph` 要求配置中存在 `pipelines.graph`，不会隐式运行 `limina graph check` 或 `graph:check` 任务。如果该工作流需要图检查，应在流水线中显式包含 `graph:check`。

命名流水线定义完整工作流。它接受 Limina 已声明的 CLI 选项，但不接受额外的运行时参数：多余的位置参数、未知选项和 `--` 分隔符都会在配置模块求值前被拒绝。以下命令属于错误用法：

```sh
limina check lint --fix
limina check commit message.txt
limina check format -- --write
```

例如，第一条命令会报告：

```text
`limina check lint` does not accept runtime arguments.
Configure the pipeline in the Limina config under `pipelines.lint`.
```

每个外部命令的 `command`、`args`、`cwd` 和 `env` 都在配置中定义。所有 `check` 选项，包括 `--package`、`--verbose` 和问题查询选项，都归 Limina 所有，不会追加到下游命令参数中。问题查询选项仍遵循各自的使用条件；`--issues` 不能与流水线名称同时使用。

[配置文件](./config-file.md)是运行时加载并求值的 JS/TS 模块。模块求值和导出的配置函数可以动态构造工作流配置。读取 `process.argv` 以转发额外参数不属于 CLI 契约。`commit-msg` 消息文件这类需要每次调用输入的集成，应使用拥有独立输入契约的专用入口。

连续的内置任务构成一个“任务段”，外部命令将任务段分开。Limina 在每个任务段前插入共享准备步骤 `workspace:validate`。包含 `graph:prepare`、`checker:build` 或 `checker:typecheck` 的任务段，还会在全部内置任务前获得共享准备步骤 `graph:materialize`。准备步骤自动注入，不是可配置的 `BuiltinTaskName` 步骤。必要准备步骤失败时，依赖任务会在消费拓扑或生成文件前记录为 `blocked`（被阻塞）。

已执行内置任务失败会让最终结果失败，但后续步骤仍按顺序尝试。准备步骤失败只阻塞依赖它的内置任务，不自动取消后面的外部命令。

例如 `checker:build → pnpm build → package:check` 中，第一段准备失败会使 `checker:build` 被阻塞，`pnpm build` 仍会尝试运行；它成功后，后一段会重新进行工作区准备，再尝试包检查。前面的失败仍保留在最终结果中。只有外部命令失败才停止剩余步骤，并将它们记为 `skipped`（已跳过）。

外部命令会分隔分析代次。Limina 在进入下一代次前等待当前工作结束，释放默认输入数据提供组件，并重新创建数据提供与查询缓存，以及产物命名空间。下一代次仍复用已加载的配置对象，命令后不会重新执行配置模块或函数。

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

应改用已授权的 `@acme/core` 包导出，并在导入方源码所属包的清单中声明依赖。生成的引用由 Limina 根据检查器证据和图规则推导，源码叶子配置无需手写 `references`。
