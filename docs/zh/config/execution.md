# 执行并发

`concurrency` 控制 Limina 同时运行多少项任务或检查。如果检查占用的资源过多，可以降低并发数量。这不会改变检查内容。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  concurrency: {
    tasks: 1,
  },
});
```

上例让默认检查的顶层任务依次运行。任务内部的并发需要分别设置。

并发值可以是正整数，也可以是 `'auto'`。实际并发数不会超过对应的任务或条目数量。例如，只有 3 个可运行任务时，`tasks: 10` 最多也只会同时启动 3 个。

## 字段

| 字段                           | 默认值   | 控制范围                                                     |
| ------------------------------ | -------- | ------------------------------------------------------------ |
| `concurrency.tasks`            | `'auto'` | 默认检查同时运行多少个顶层任务。命名流水线仍按步骤顺序执行。 |
| `concurrency.checkerBuild`     | `'auto'` | `checker:build` 同时运行多少个构建型检查器任务。             |
| `concurrency.checkerTypecheck` | `2`      | `checker:typecheck` 同时运行多少个非构建型检查器任务。       |
| `concurrency.packageEntries`   | `'auto'` | `package:check` 同时检查多少个包输出条目。                   |
| `concurrency.releaseEntries`   | `2`      | `release:check` 同时检查多少个发布条目。                     |

`'auto'` 的计算方式因字段而异。下面的 `availableParallelism` 指 Node.js 进程可用的并行度：

- `concurrency.tasks` 和 `packageEntries` 使用 `max(2, floor(availableParallelism / 2))`；
- `checkerBuild` 使用可用并行度；
- `checkerTypecheck` 和 `releaseEntries` 的 `'auto'` 解析结果是 `2`（默认值也为 `2`）。

所有结果都不会超过当前任务或条目数量。有可运行条目时，并发数至少为 `1`；没有条目时为 `0`。

例如，`tasks: 1` 会让顶层任务一个接一个运行，但每个任务内部仍可并行处理自己的工作。如果也要限制检查器进程或输出条目的并发，需要分别设置对应字段。

## 调度和失败

默认 `limina check` 把内置任务作为独立任务调度。当 `concurrency.tasks` 和资源锁允许时，多个内置任务可以同时运行。需要同一份独占资源的任务不会同时启动。

命名流水线始终按数组顺序调度。`concurrency.tasks` 不会把有顺序依赖的流水线步骤改成并发执行。

并发配置不改变失败策略。已执行内置任务失败会让最终结果失败，但不会因此停止其他任务或后续有序步骤。必要准备步骤 `workspace:validate` 或 `graph:materialize` 失败会阻塞依赖任务。外部命令失败会停止剩余步骤，并记为 `skipped`（已跳过）。任务的 `disabled`（无适用工作）状态或分析器的 `skipped` 状态不表示对应检查已经运行。
