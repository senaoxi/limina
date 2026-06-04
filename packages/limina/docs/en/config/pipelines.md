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

`pipelines` maps a name to an ordered list of steps. `pnpm exec limina check <name>` runs that pipeline's steps in array order, stopping at the first failure.

::: tip
Pipelines are a good place to fix team workflows as named commands. A `publish` pipeline can typecheck, build, and then inspect package output, so local scripts and CI share the same order instead of drifting apart.
:::

## String steps

A string step can be a built-in Limina task:

- `checker:build`
- `checker:typecheck`
- `graph:check`
- `nx:check`
- `package:check`
- `proof:check`
- `release:check`
- `source:check`

It can also be a simple external command. Simple commands are split on whitespace; use object form when arguments contain spaces, or when the step needs `cwd` or environment variables.

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

- **Type:** `{ type: 'task'; name: BuiltinTaskName }` where `BuiltinTaskName` is `'graph:check' | 'source:check' | 'proof:check' | 'checker:build' | 'checker:typecheck' | 'package:check' | 'release:check' | 'nx:check'`

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

the pipeline fails during `source:check`, and later build, package check, and external test commands are skipped. The release flow stops at the check closest to the source of the problem.

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

When `pnpm exec limina check publish` runs, Limina executes pipeline steps in array order. `graph:check` first validates declaration edges, then `source:check` analyzes package owners and relative import boundaries.

The result is a failure during the source stage; `checker:build`, `package:check`, and `pnpm test` do not continue. The user can fix the closest cause first: replace the cross-package relative import with the `@acme/core` package export, then express the dependency through the manifest and project reference.
:::
