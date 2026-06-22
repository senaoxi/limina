# Execution Concurrency

Top-level `execution` limits how much work Limina starts at the same time. It changes scheduling limits, not what gets checked.

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

A concurrency value can be a positive integer or `'auto'`. Explicit numbers are clamped to the number of runnable items; for example, if only 3 tasks can run, `tasks: 10` still starts at most 3 tasks.

## Fields

| Field                        | Default  | Scope                                                                                                          |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `execution.tasks`            | `'auto'` | Top-level task scheduling. The default check can use it concurrently; named pipelines still follow step order. |
| `execution.checkerBuild`     | `'auto'` | The build-mode checker pool inside `checker:build`.                                                            |
| `execution.checkerTypecheck` | `2`      | The typecheck-only checker pool inside `checker:typecheck`.                                                    |
| `execution.packageEntries`   | `'auto'` | How many package output entries `package:check` checks at once.                                                |
| `execution.releaseEntries`   | `2`      | How many release entries `release:check --package <name>` checks at once.                                      |

`'auto'` is resolved conservatively from available parallelism:

- `execution.tasks` and `packageEntries` use `max(2, floor(availableParallelism / 2))`;
- `checkerBuild` uses available parallelism;
- `checkerTypecheck` and `releaseEntries` default to `2`.

All results are clamped to the current item count. When there is runnable work, the result is at least `1`; with no items, it is `0`.

## Scheduling and Failure

The default `limina check` schedules built-in tasks as independent work; when `execution.tasks` and resource locks allow it, multiple built-in tasks can run at the same time. Resource locks still win: tasks that need the same exclusive resource are not started together.

Named pipelines are always scheduled in array order. `execution.tasks` does not turn ordered pipeline steps into concurrent work.

Concurrency settings do not change failure policy. A built-in task failure makes the final result fail, but it does not block other built-in tasks or later ordered steps. An external command step failure blocks the remaining steps and records them as skipped. `execution.failFast` is a boolean field, but top-level `limina check` blocking is not controlled by it.
