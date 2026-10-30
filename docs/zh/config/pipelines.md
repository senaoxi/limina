# 流水线

流水线把团队需要一起运行的步骤保存在配置中。例如，发布前先运行项目的生产构建，再检查构建后的包。下面假设项目已有 `pnpm build` 脚本，并已配置[包输出条目](./package-checks.md)。请将 `pipelines` 字段合并到现有 Limina 配置中，保留这些包条目：

`limina.config.mjs`：

```js
import { defineConfig } from 'limina';

export default defineConfig({
  pipelines: {
    publish: [
      { type: 'command', command: 'pnpm', args: ['build'] },
      'package:check',
      'release:check',
    ],
  },
});
```

在项目根目录运行：

```sh
pnpm exec limina check publish --package @acme/core
```

`publish` 只是这条流水线的名称，示例不会执行发布。构建命令和检查按声明顺序执行。如果构建命令失败，后续步骤会被跳过。命名流水线只包含显式写出的任务，不会自动附带默认的五项检查。需要默认检查时，另行运行 `pnpm exec limina check`，或将需要的内置任务写入流水线。

## `pipelines`

- **类型：** `Record<string, PipelineStep[]>`

`pipelines` 把名称对应到一组有序步骤。`pnpm exec limina check <name>` 会按数组顺序运行这些步骤，前一步结束后才开始下一步。默认 `limina check` 则把内置任务作为独立任务调度，可以并发运行。内置任务失败后，命名流水线仍可能继续执行，具体行为见下文。

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

运行内置任务前，Limina 会自动执行必要的准备，例如验证工作区或生成检查器配置。如果准备失败，依赖它的任务会标记为 `blocked`（被阻塞）。

::: details 准备步骤的执行时机

连续的内置任务构成一个任务段，外部命令将任务段分开。Limina 在每个任务段前执行 `workspace:validate`。如果任务段包含 `graph:prepare`、`checker:build` 或 `checker:typecheck`，还会在该任务段的全部内置任务前执行 `graph:materialize`。这些准备步骤由 Limina 自动添加，不能作为 `BuiltinTaskName` 单独配置。准备失败时，依赖任务不会继续使用工作区拓扑或生成文件。

:::

已执行内置任务失败会让最终结果失败，但后续步骤仍按顺序尝试。准备步骤失败只阻塞依赖它的内置任务，不自动取消后面的外部命令。

例如，在 `checker:build → pnpm build → package:check` 中，第一段准备失败会使 `checker:build` 被阻塞，但 `pnpm build` 仍会尝试运行。如果构建成功，后一段会重新进行工作区准备，再尝试包检查。前面的失败仍保留在最终结果中。只有外部命令失败才停止剩余步骤，并将它们记为 `skipped`（已跳过）。

外部命令可能改变后续任务需要读取的文件。因此，进入后续任务前，Limina 会等待当前工作结束并重新建立分析上下文。它仍使用本次运行开始时加载的配置对象，不会在外部命令后重新执行配置模块或函数。

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

也可以是简单外部命令。简单命令会按空白拆分。当参数里有空格、需要 `cwd` 或环境变量时，应使用对象形式。

`graph:prepare` 会验证输入并生成图文件，但不执行完整的图检查或运行编译器。只做检查的流程可使用 `graph:check`，它在内存中计算图，不生成检查器配置。检查器任务会自动获得所需的准备步骤。

`checker:build` 产出 Limina 内部使用的声明文件。如果需要生成供消费者使用的产物，应在 `package:check` 或 `release:check` 前添加项目自己的构建命令。

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

例如，某次改动让源码出现跨包相对导入：

```ts
// packages/app/src/main.ts
import { createClient } from '../../core/src/index';
```

本页开头的 `publish` 流水线没有包含 `source:check`，所以不会因为这条导入运行源码检查。需要在发布前检查源码时，可以先单独运行 `pnpm exec limina check`，也可以在流水线的步骤数组中加入 `source:check`。

如果把 `source:check` 加在构建命令之前，它发现问题后，后面的构建和包检查仍会按顺序尝试执行，但流水线最终会失败。如果希望源码检查失败时不启动构建，请先单独运行检查，并只在检查通过后运行发布流水线。

例如，在工作区根目录运行：

```sh
pnpm exec limina check && pnpm exec limina check publish --package @acme/core
```

修复这条导入时，应改用已授权的 `@acme/core` 包导出，并在导入方源码所属包的清单中声明依赖。Limina 根据检查器证据推导需要的声明引用，再检查图规则。源码配置无需手写这些引用。
