# 执行并发

顶层 `execution` 用来限制 Limina 同一时间启动多少工作。它不改变检查内容，只改变调度数量。

```js
import { defineConfig } from 'limina';

export default defineConfig({
  execution: {
    tasks: 'auto',
    checkerBuild: 'auto',
    checkerTypecheck: 2,
    packageEntries: 'auto',
    releaseEntries: 2,
  },
});
```

并发值可以是正整数，也可以是 `'auto'`。显式数字会按当前任务数量收窄；例如只有 3 个可运行任务时，`tasks: 10` 实际最多也只会启动 3 个。

## 字段

| 字段                         | 默认值   | 控制范围                                                       |
| ---------------------------- | -------- | -------------------------------------------------------------- |
| `execution.tasks`            | `'auto'` | 顶层任务调度；默认检查可并发使用，命名流水线仍受步骤顺序约束。 |
| `execution.checkerBuild`     | `'auto'` | `checker:build` 内部的构建模式检查器工作池。                   |
| `execution.checkerTypecheck` | `2`      | `checker:typecheck` 内部的非构建型检查器工作池。               |
| `execution.packageEntries`   | `'auto'` | `package:check` 同时检查多少个包输出条目。                     |
| `execution.releaseEntries`   | `2`      | `release:check --package <name>` 同时检查多少个发布条目。      |

`'auto'` 会按机器可用并行度保守计算：

- `execution.tasks` 和 `packageEntries` 使用 `max(2, floor(availableParallelism / 2))`；
- `checkerBuild` 使用可用并行度；
- `checkerTypecheck` 和 `releaseEntries` 的默认值是 `2`。

所有结果都会被当前条目数量限制；有可运行条目时至少为 `1`，没有条目时为 `0`。

## 调度和失败

默认 `limina check` 把内置任务作为独立任务调度；当 `execution.tasks` 和资源锁允许时，多个内置任务可以同时运行。资源锁仍然优先：需要同一份独占资源的任务不会同时启动。

命名流水线始终按数组顺序调度。`execution.tasks` 不会把有顺序依赖的流水线步骤改成并发执行。

并发配置不改变失败策略。内置任务失败会让最终结果失败，但不会阻塞其他内置任务或后续有序步骤；外部命令步骤失败会阻塞剩余步骤，并把它们记为 `skipped`。`execution.failFast` 是布尔字段，但顶层 `limina check` 的停止行为不由它控制。
