# Execution Concurrency

`concurrency` controls how many tasks or checks Limina runs at once. If checks consume too many resources, reduce the concurrency. This does not change what gets checked.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  concurrency: {
    tasks: 1,
  },
});
```

This example runs the default check's top-level tasks one at a time. Set concurrency within each task separately.

A concurrency value can be a positive integer or `'auto'`. Actual concurrency cannot exceed the corresponding task or entry count. For example, if only 3 tasks can run, `tasks: 10` still starts at most 3 at once.

## Fields

| Field                          | Default  | Scope                                                                                                          |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------- |
| `concurrency.tasks`            | `'auto'` | Top-level task scheduling. The default check can use it concurrently; named pipelines still follow step order. |
| `concurrency.checkerBuild`     | `'auto'` | The build-mode checker pool inside `checker:build`.                                                            |
| `concurrency.checkerTypecheck` | `2`      | The non-build checker pool inside `checker:typecheck`.                                                         |
| `concurrency.packageEntries`   | `'auto'` | How many package output entries `package:check` checks at once.                                                |
| `concurrency.releaseEntries`   | `2`      | How many release entries `release:check` checks at once.                                                       |

The calculation for `'auto'` depends on the field. Here, `availableParallelism` is the parallelism available to the Node.js process:

- `concurrency.tasks` and `packageEntries` use `max(2, floor(availableParallelism / 2))`;
- `checkerBuild` uses available parallelism;
- `checkerTypecheck` and `releaseEntries` resolve `'auto'` to `2` (and also default to `2`).

All results are clamped to the current item count. When there is runnable work, the result is at least `1`; with no items, it is `0`.

`tasks: 1` serializes only top-level tasks; a running task can still use its own worker pool. To also limit internal checker processes or output-entry concurrency, set the corresponding fields separately.

## Scheduling and Failure

The default `limina check` schedules built-in tasks as independent work; when `concurrency.tasks` and resource locks allow it, multiple built-in tasks can run at the same time. Tasks that need the same exclusive resource do not start together.

Named pipelines are always scheduled in array order. `concurrency.tasks` does not turn ordered pipeline steps into concurrent work.

Concurrency settings do not change failure policy. A completed built-in task failure fails the final result but does not itself stop other tasks or later ordered steps. Failed required `workspace:validate` or `graph:materialize` preparation blocks dependent tasks. An external command failure stops remaining steps and records them as `skipped`. A disabled task or skipped analyzer does not mean that its checks ran.
