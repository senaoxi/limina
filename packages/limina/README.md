# limina

<p align="center">
  <a href="https://docs.senao.me/docs-islands/limina" target="_blank" rel="noopener noreferrer">
    <img width="180" src="https://docs.senao.me/docs-islands/limina/logo.svg" alt="limina logo">
  </a>
</p>
<p align="center">
  <a href="https://npmjs.com/package/limina"><img src="https://img.shields.io/npm/v/limina.svg" alt="npm package"></a>
  <a href="https://nodejs.org/en/about/previous-releases"><img src="https://img.shields.io/node/v/limina.svg" alt="node compatibility"></a>
  <a href="https://github.com/XiSenao/docs-islands/actions/workflows/ci.yml"><img src="https://github.com/XiSenao/docs-islands/actions/workflows/ci.yml/badge.svg?branch=main" alt="build status"></a>
  <a href="https://github.com/XiSenao/docs-islands/blob/main/packages/limina/LICENSE.md"><img src="https://img.shields.io/npm/l/limina.svg" alt="license"></a>
</p>

English | [简体中文](./README.zh-CN.md)

`limina` is a configurable governance CLI for TypeScript monorepos. It keeps TypeScript project references, source typechecks, compatibility paths, package export policy, and publish-time package checks in one explicit `limina.config.mjs` file.

Limina is not a bundler and does not replace `tsc`, `tsgo`, `vue-tsc`, `vue-tsgo`, tests, or release tooling. It coordinates them and verifies that the architecture they depend on stays consistent.

## Why Limina?

Large TypeScript workspaces often need more than `tsc --noEmit`:

- project references must match real cross-project imports;
- production graph projects should not depend on tools or tests;
- browser/runtime output should not import Node builtins;
- `workspace:*` dependencies should resolve to source during graph checks;
- generated compatibility `paths` should not silently drift;
- built package outputs need consumer-facing checks before release;
- Vue, docs, playground, and smoke checks may need checker-specific tooling outside native `tsc -b`.

Limina makes these rules reviewable, runnable, and suitable for CI.

## Features

- **Project graph validation**: checks reachable TypeScript declaration leaves, references, graph-owned imports, package boundaries, and label-based deny rules.
- **Typecheck coverage proof**: verifies that reachable declaration leaves match strict local typecheck companions and that source files are covered by checker entries or allowlist entries.
- **Compatibility path generation**: writes opt-in `tsconfig.dts.paths.generated.json` files for `workspace:*` dependencies whose package exports still point at build artifacts.
- **Checker target runner**: runs configured TypeScript and UI-framework checker entries in `typecheck` or `build` execution mode.
- **Published package checks**: validates built package outputs with `publint`, Are The Types Wrong, and a runtime import boundary audit.
- **Release checks**: verifies npm tarball hygiene, source/packed manifest consistency, and registry-backed workspace publish order.
- **Composable pipelines**: combines built-in checks and shell commands into named workflows such as `typecheck`, `package`, and `publish`.
- **Typed configuration**: ships `defineConfig(...)` for editor hints and typed user configs.

## Requirements

- Node.js `^20.19.0 || >=22.12.0`
- pnpm workspace with `pnpm-workspace.yaml`
- TypeScript installed in the consuming repository
- ESM-compatible `limina.config.mjs`

## Installation

```sh
pnpm add -D limina typescript
```

## Quick start

Create `limina.config.mjs` at the workspace root:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      typescript: {
        preset: 'tsc',
        entry: 'tsconfig.build.json',
      },
      vue: {
        preset: 'vue-tsc',
        entry: 'tsconfig.vue.build.json',
      },
    },
  },

  graph: {
    rules: {
      'runtime-client': {
        deny: {
          refs: [
            {
              path: 'packages/app/src/node/tsconfig.lib.dts.json',
              reason: 'client runtime must not depend on the Node runtime',
            },
          ],
        },
      },
    },
  },

  proof: {
    allowlist: [
      {
        file: 'src/generated/runtime.d.ts',
        reason: 'Generated declaration stub covered by the runtime build process.',
      },
    ],
  },

  package: {
    entries: [
      {
        name: '@acme/core',
        outDir: 'packages/core/dist',
      },
    ],
  },

  pipelines: {
    package: ['package:check'],
    publish: ['graph:check', 'proof:check', 'package:check', 'release:check'],
  },
});
```

Add scripts:

```json
{
  "scripts": {
    "typecheck": "limina check",
    "lint:package": "limina package check",
    "prepublishOnly": "limina check publish"
  }
}
```

Run checks:

```sh
pnpm typecheck
pnpm exec limina graph check
pnpm exec limina package check --package @acme/core
```

## Concepts

### Checker entry

Each checker has one required `config.checkers.<name>.entry`, usually a `tsconfig*.build.json` graph aggregator. Presets with build execution (`tsc`, `tsgo`, and `vue-tsc`) are first-class and participate in graph, source, proof, and build checks. Presets without build execution (`vue-tsgo` and `svelte-check`) are second-class and run direct checker execution through `limina checker typecheck`; `vue-tsgo` still uses its tsconfig entry for Limina graph and proof coverage. Prefer `vue-tsc` for first-class Vue project-reference builds; current `vue-tsgo` build mode does not preserve TypeScript project-reference boundaries or provide incremental build semantics.

### Declaration leaf and local companion

Declaration leaves should have strict local companions. For example, `tsconfig.lib.dts.json` pairs with `tsconfig.lib.json`, and `tsconfig.dts.json` pairs with `tsconfig.json`.

The default `tsconfig.json` is the IDE/typecheck entry for its directory. A single-environment directory should use it as the local leaf; a multi-environment directory should make it a pure aggregator with `files: []` and `references`.

Limina publishes a local tsconfig schema that composes the community SchemaStore tsconfig schema and adds `liminaOptions` completion:

```jsonc
{
  "$schema": "./node_modules/limina/schemas/tsconfig-schema.json",
}
```

The `$schema` path is relative to the tsconfig file that declares it, so nested package configs should adjust the leading `../` segments.

### Source dependencies and artifact dependencies

A dependency declared as `workspace:*` is considered a source dependency. It should be represented by project references and source-facing package exports.

A dependency declared as `link:`, `file:`, `catalog:`, or normal semver is treated as an artifact dependency. It should not be modeled as a project reference unless it is intentionally consumed as source.

### Package checks

Source graph checks do not prove that an installed package works for consumers. `limina package check` inspects built package outputs under `package.entries[].outDir` and checks the actual package manifest, exports, type resolution, and runtime imports with `publint`, `attw`, and `boundary`. `limina release check` owns npm publish hygiene: private-output rejection, required README/license files, source map bans, source/packed manifest consistency, and registry-backed workspace publish order.

## CLI

```sh
limina [--config limina.config.mjs] [--mode mode] <command>
```

| Command                                         | Description                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `limina check`                                  | Run the built-in default check pipeline.                                              |
| `limina check <pipeline>`                       | Run a named user pipeline from `pipelines`.                                           |
| `limina graph check`                            | Validate project references and architecture import rules.                            |
| `limina graph sync [path]`                      | Rewrite declaration-leaf references from TypeScript-resolved source imports.          |
| `limina proof check`                            | Prove declaration configs, local typecheck configs, and source coverage stay aligned. |
| `limina paths generate`                         | Generate compatibility source `paths` configs for artifact-facing workspace exports.  |
| `limina paths apply`                            | Compatibility alias for `paths generate`.                                             |
| `limina paths check`                            | Fail when generated path files are stale.                                             |
| `limina checker build`                          | Run build execution for checker entries that support it.                              |
| `limina checker typecheck`                      | Run second-class checker entries such as `vue-tsgo` and `svelte-check`.               |
| `limina package check`                          | Run configured package output checks.                                                 |
| `limina package check --package <name>`         | Check one configured package entry.                                                   |
| `limina package check --tool <tool>`            | Run only `publint`, `attw`, or `boundary`.                                            |
| `limina package check --attw-profile <profile>` | Override the ATTW profile: `strict`, `node16`, or `esm-only`.                         |
| `limina release check`                          | Check release hygiene and dependency consistency for the cwd package entry.           |
| `limina release check --package <name>`         | Check release hygiene and dependency consistency for one or more package entries.     |

## Configuration reference

### `config`

```js
config: {
  checkers: {
    typescript: {
      preset: 'tsc',
      entry: 'tsconfig.build.json',
    },
    vue: {
      preset: 'vue-tsc',
      entry: 'tsconfig.vue.build.json',
    },
  },
  source: {
    exclude: ['node_modules', 'dist', '.tsbuild'],
  },
}
```

`config.checkers` defines checker entries. Every configured checker must declare a non-empty `entry` and use a built-in preset. Checker `extensions` are fixed by Limina and cannot be configured; if `config.source.include` is omitted, Limina derives the global source boundary from configured checker extensions, then applies `config.source.exclude`.

### `graph`

```js
graph: {
  rules: {
    'runtime-client': {
      deny: {
        refs: [
          {
            path: 'packages/app/src/node/tsconfig.lib.dts.json',
            reason: 'client runtime must stay independent from Node runtime',
          },
        ],
        deps: [
          {
            name: '@acme/internal-node',
            reason: 'client runtime must not consume Node-only packages',
          },
          {
            name: 'node:*',
            reason: 'client runtime must not import Node builtins',
          },
          {
            name: '#server/*',
            reason: 'client runtime must not use server-only package imports',
          },
        ],
      },
    },
  },
}
```

A declaration leaf opts into one or more rules with `liminaOptions.graphRules`:

```jsonc
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "extends": ["./tsconfig.json", "../../tsconfig.dts.base.json"],
  "references": [],
}
```

### `paths`

```js
paths: {
  generatedFileName: 'tsconfig.dts.paths.generated.json',
  conditionPriority: ['source', 'development', 'types'],
  artifactDirectories: ['dist', 'build', 'lib', 'esm', 'cjs', 'out'],
}
```

Use generated paths only when a workspace package must keep artifact-facing exports while still being consumed as a graph-owned source dependency.

### `proof`

```js
proof: {
  allowlist: [
    {
      file: 'src/generated/runtime.d.ts',
      reason: 'Generated file validated by the build pipeline.',
    },
  ],
}
```

Checker entries cover files validated by TypeScript or framework-aware tools. Allowlist entries are the final fallback after all configured checker entries fail to cover a source file; they should be rare and must include a reason.

### `package`

```js
package: {
  entries: [
    {
      name: '@acme/core',
      outDir: 'packages/core/dist',
      checks: ['publint', 'attw', 'boundary'],
      publint: { strict: true },
      attw: { profile: 'esm-only' },
      boundary: {
        environment: (file) => file.startsWith('node/') ? 'node' : 'browser',
        ignoredExternalPackages: ['@acme/runtime-shim'],
      },
    },
  ],
}
```

`outDir` must point at the built package directory that contains the publish-ready `package.json`. `package:check` uses this output for consumer-facing resolver and runtime checks; `release:check` packs the same output and verifies publish hygiene such as README/license files and source map bans.

### `pipelines`

```js
pipelines: {
  package: [
    { type: 'command', command: 'pnpm', args: ['build'] },
    'package:check',
  ],
}
```

`limina check` runs the built-in default pipeline: `graph:check`, `source:check`, `proof:check`, `checker:build`, and `checker:typecheck`. `limina check <pipeline>` only runs user pipelines from `limina.config.mjs#pipelines`; if the name is missing, Limina reports the missing pipeline and asks you to define it there.

String steps can be built-in task names or simple commands. Use object command steps when arguments, `cwd`, or `env` need to be explicit.

## CI example

```yaml
name: Typecheck

on:
  pull_request:
  push:
    branches: [main]

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20.19.0
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec limina check
```

## Programmatic API

```ts
import { defineConfig, loadConfig } from 'limina';

export default defineConfig({
  pipelines: {
    typecheck: ['graph:check'],
  },
});

const config = await loadConfig();
```

Most users only need `defineConfig(...)`. `loadConfig(...)` is available for custom wrappers and tests.

## Troubleshooting

### `Unable to find limina config`

Run the command from inside the workspace, or pass `--config ./limina.config.mjs`.

### `no pnpm-workspace.yaml was found`

Limina infers the workspace root from `pnpm-workspace.yaml`. Place the config inside the workspace or pass a config path located under the workspace root.

### `package.entries[x].outDir` is invalid

Set `outDir` to the built package directory, not the source package directory, unless that directory is itself the publish-ready package output.

### Generated paths are stale

Run:

```sh
pnpm exec limina paths generate
```

Then add the generated file to the first position of the listed `extends` arrays and commit the generated file if your repository policy requires reproducible `tsc -b` without a pre-generation step.

## Design principles

- Explicit policy is better than hidden presets.
- Source graph checks and package artifact checks validate different surfaces.
- Build graph configs should be strict, small, and directly referenced.
- Generated compatibility paths should be transitional, not the default architecture.
- Limina should fail with actionable messages instead of silently accepting graph drift.

## License

MIT
