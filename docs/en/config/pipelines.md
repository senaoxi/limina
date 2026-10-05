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

The name selects only `pipelines[name]`. For example, `limina check graph` requires a configured `pipelines.graph`; it does not implicitly run `limina graph check` or the `graph:check` task. Include `graph:check` explicitly in that pipeline when it belongs to the workflow.

A named pipeline defines a complete workflow. It accepts Limina's declared CLI options, but no additional runtime arguments: extra positional values, unknown options, and a `--` separator are rejected before the config module is evaluated. These commands are invalid:

```sh
limina check lint --fix
limina check commit message.txt
limina check format -- --write
```

For example, the first command reports:

```text
`limina check lint` does not accept runtime arguments.
Configure the pipeline in the Limina config under `pipelines.lint`.
```

Define each external command's `command`, `args`, `cwd`, and `env` in configuration. All `check` options, including `--package`, `--verbose`, and the issue-query options, belong to Limina and are never appended to downstream command arguments. Issue-query options retain their own requirements; `--issues` cannot accompany a pipeline name.

The [config file](./config-file.md) is a JS/TS module loaded and evaluated at runtime. Module evaluation and exported config functions can construct workflow configuration dynamically. Reading `process.argv` to forward extra arguments is outside the CLI contract. Integrations needing per-invocation input, such as a `commit-msg` message file, should use a dedicated entry point with its own input contract.

Limina inserts shared `workspace:validate` preparation before topology-dependent built-in work. A segment containing `graph:prepare`, `checker:build`, or `checker:typecheck` also receives shared `graph:materialize` preparation before all its built-in tasks. Preparations are injected automatically, not accepted as `BuiltinTaskName` steps. A failed required preparation records its dependent tasks as `blocked` before they consume topology or generated files.

After preparations succeed, a completed built-in task failure fails the final result, while later steps are still attempted in order. An external command failure stops the remaining steps and records them as `skipped`.

An external command separates analysis generations. Limina joins current work before the next generation, disposes its default analysis providers, and recreates provider/query caches and the artifact namespace. The next generation reuses the loaded configuration object; it does not rerun the config module or function after the command.

::: tip
Give a shared workflow a pipeline name so local scripts and CI run the same steps in the same order. For example, `publish` can typecheck, build, and then inspect package output.
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

`graph:prepare` validates inputs and materializes graph files; it does not run graph governance checks or the compiler. Validation-only flows can use `graph:check`, which calculates its graph in memory without materializing checker configs. Checker tasks receive automatic materialization. `checker:build` emits Limina's internal declarations; add your project's build command before `package:check` or `release:check` when consumer artifacts need to be produced.

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

`cwd` is relative to `config.rootDir`.

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

the pipeline records a failure during `source:check`, and later build, package check, and external test commands are still attempted in order. The final result fails. Fix the source import before rerunning the pipeline.

::: details Cross-package import example
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

When `pnpm exec limina check publish` runs, Limina executes pipeline steps in array order. `graph:check` first validates declaration edges, then `source:check` analyzes workspace package ownership and relative import boundaries.

Assuming shared preparations pass, the relative cross-package import can produce a source-stage failure. Later built-in steps and `pnpm test` are still attempted in order. Replace it with an authorized `@acme/core` package export and declare the dependency in the importing source owner's manifest; Limina then infers eligible project relations from checker evidence, without requiring handwritten source-leaf `references`.

If a later external command such as `pnpm test` fails, remaining steps are recorded as `skipped`. A failed required preparation can instead record dependent tasks as `blocked`.
:::
