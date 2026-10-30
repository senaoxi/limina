# Pipelines

Pipelines store steps your team needs to run together. For example, before release you can run the project's production build and then check the built package. This example assumes a `pnpm build` script and configured [package output entries](./package-checks.md). Merge the `pipelines` field into the existing Limina config so it retains those entries:

`limina.config.mjs`:

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

Run this at the project root:

```sh
pnpm exec limina check publish --package @acme/core
```

`publish` is only the pipeline name; the example does not publish anything. The build and checks run in the declared order. If the build command fails, later steps are skipped. A named pipeline contains only tasks explicitly listed, not the five default checks. To run those checks, run `pnpm exec limina check` separately or include the tasks you need in the pipeline.

## pipelines

- **Type:** `Record<string, PipelineStep[]>`

`pipelines` maps a name to an ordered list of steps. `pnpm exec limina check <name>` runs them in array order, starting each after the preceding step ends. The default `limina check` schedules built-in tasks as independent work that may run concurrently. A named pipeline may continue after a built-in task fails; see the failure policy below.

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

Before running built-in tasks, Limina automatically performs necessary preparation, such as validating the workspace or generating checker configs. If preparation fails, dependent tasks are recorded as `blocked`.

::: details When preparation runs

Consecutive built-in tasks form a task segment, and external commands separate segments. Limina runs `workspace:validate` before each segment. A segment containing `graph:prepare`, `checker:build`, or `checker:typecheck` also receives `graph:materialize` before all its built-in tasks. Limina adds these steps automatically; they cannot be configured as `BuiltinTaskName` steps. When preparation fails, dependent tasks do not proceed to consume workspace topology or generated files.

:::

A built-in task that runs and fails makes the final result fail, but later steps are still attempted in order. Preparation failure blocks only the built-in tasks that depend on it; it does not automatically cancel subsequent external commands.

For example, in `checker:build → pnpm build → package:check`, failure to prepare the first segment blocks `checker:build`, but `pnpm build` is still attempted. If it succeeds, the next segment prepares the workspace again before attempting the package check. The earlier failure remains in the final result. Only an external command failure stops the remaining steps and records them as `skipped`.

An external command may change files needed by later tasks. Limina waits for current work to finish and establishes a fresh analysis context before those tasks. It keeps the config object loaded at the start of the run; it does not rerun the config module or function after the command.

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

`graph:prepare` validates inputs and generates graph files, but does not run the full graph check or a compiler. A check-only workflow can use `graph:check`, which calculates the graph in memory without generating checker configs. Checker tasks receive the necessary preparation automatically.

`checker:build` emits declarations for Limina's internal use. To generate artifacts for consumers, add your project's build command before `package:check` or `release:check`.

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

Suppose a change introduces a cross-package relative import:

```ts
// packages/app/src/main.ts
import { createClient } from '../../core/src/index';
```

The `publish` pipeline at the start of this page does not include `source:check`, so it will not run a source check for this import. To check source before release, run `pnpm exec limina check` separately or add `source:check` to the pipeline.

If you add `source:check` before the build, the build and package checks are still attempted in order after a source failure, but the final pipeline result fails. If a source failure should prevent the build, run the check separately and start the publish pipeline only after it succeeds. For example, at the workspace root:

```sh
pnpm exec limina check && pnpm exec limina check publish --package @acme/core
```

Use an authorized `@acme/core` package export and declare the dependency in the importing source owner's manifest. Limina derives references from checker evidence and checks graph rules separately. Source leaf configs do not need handwritten `references`.
