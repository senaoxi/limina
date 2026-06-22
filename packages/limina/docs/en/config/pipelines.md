# Pipelines

Pipelines are named workflows for `limina check <name>`.

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

- **Type:** `Record<string, PipelineStep[]>`

`pipelines` maps a name to an ordered list of steps. `pnpm exec limina check <name>` schedules that pipeline's steps in array order, with each step depending on the previous one. This differs from the default `limina check`: the default check schedules built-in tasks as independent work that can run concurrently, while a named pipeline preserves the order you wrote.

Ordered does not mean every failure stops the pipeline immediately. A built-in task failure makes the final pipeline result fail, but later steps are still attempted in order. An external command step failure blocks the remaining steps and records them as skipped.

::: tip
Pipelines are a good place to fix team workflows as named commands. A `publish` pipeline can typecheck, build, and then inspect package output, so local scripts and CI share the same order instead of drifting apart.
:::

## String steps

A string step can be a built-in Limina task:

- `checker:build`
- `checker:typecheck`
- `graph:prepare`
- `graph:check`
- `package:check`
- `proof:check`
- `release:check`
- `source:check`

It can also be a simple external command. Simple commands are split on whitespace; use object form when arguments contain spaces, or when the step needs `cwd` or environment variables.

`graph:prepare` only generates graph files; it does not validate them. Most flows can use `graph:check` directly, because graph checking prepares the graph before it runs.

## Object command step

- **Type:** `{ type: 'command'; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }`

Object form declares an external command explicitly:

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

## Object task step

- **Type:** `{ type: 'task'; name: BuiltinTaskName }` where `BuiltinTaskName` is `'graph:prepare' | 'graph:check' | 'source:check' | 'proof:check' | 'checker:build' | 'checker:typecheck' | 'package:check' | 'release:check'`

Built-in tasks can also be written explicitly:

```js
{
  type: 'task',
  name: 'source:check',
}
```

After configuration, `pnpm exec limina check publish` runs steps in array order. If a change introduces a cross-package relative import:

```ts
// packages/app/src/main.ts
import { createClient } from '../../core/src/index';
```

the pipeline records a failure during `source:check`, and later build, package check, and external test commands are still attempted in order. The final result fails, and the user can fix the check closest to the source of the problem first.

::: details A fuller failure example
The directory can look like this:

```text
packages/app/
  src/main.ts
packages/core/
  src/index.ts
```

The module imports across package folders with a relative path:

```ts
// packages/app/src/main.ts
import { createClient } from '../../core/src/index';
```

When `pnpm exec limina check publish` runs, Limina executes pipeline steps in array order. `graph:check` first validates declaration edges, then `source:check` analyzes source owners and relative import boundaries.

The result is a recorded failure during the source stage; `checker:build`, `package:check`, and `pnpm test` are still attempted in order. The user can fix the closest cause first: replace the cross-package relative import with the `@acme/core` package export, then express the dependency through the manifest and project reference.

If a later external command step such as `pnpm test` fails, steps after it are blocked and recorded as skipped. That blocking behavior comes from external command steps, not built-in check tasks.
:::
