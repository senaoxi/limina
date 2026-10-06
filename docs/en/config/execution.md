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

A concurrency value can be a positive integer or `'auto'`. Explicit numbers are clamped to the number of runnable tasks or entries at the corresponding level; for example, if only 3 tasks can run, `tasks: 10` still starts at most 3 tasks.

## Fields

| Field                        | Default  | Scope                                                                                                          |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `execution.tasks`            | `'auto'` | Top-level task scheduling. The default check can use it concurrently; named pipelines still follow step order. |
| `execution.checkerBuild`     | `'auto'` | The build-mode checker pool inside `checker:build`.                                                            |
| `execution.checkerTypecheck` | `2`      | The non-build checker pool inside `checker:typecheck`.                                                         |
| `execution.packageEntries`   | `'auto'` | How many package output entries `package:check` checks at once.                                                |
| `execution.releaseEntries`   | `2`      | How many release entries `release:check` checks at once.                                                       |

`'auto'` uses the machine's available parallelism as follows:

- `execution.tasks` and `packageEntries` use `max(2, floor(availableParallelism / 2))`;
- `checkerBuild` uses available parallelism;
- `checkerTypecheck` and `releaseEntries` resolve `'auto'` to `2` (and also default to `2`).

All results are clamped to the current item count. When there is runnable work, the result is at least `1`; with no items, it is `0`.

`tasks: 1` serializes only top-level tasks; a running task can still use its own worker pool. To also limit internal checker processes or output-entry concurrency, set the corresponding fields separately.

## Scheduling and Failure

The default `limina check` schedules built-in tasks as independent work; when `execution.tasks` and resource locks allow it, multiple built-in tasks can run at the same time. Tasks that need the same exclusive resource do not start together.

Named pipelines are always scheduled in array order. `execution.tasks` does not turn ordered pipeline steps into concurrent work.

Concurrency settings do not change failure policy. A completed built-in task failure fails the final result but does not itself stop other tasks or later ordered steps. Failed required `workspace:validate` or `graph:materialize` preparation blocks dependent tasks. An external command failure stops remaining steps and records them as `skipped`. A disabled task or skipped analyzer does not mean that its checks ran.
