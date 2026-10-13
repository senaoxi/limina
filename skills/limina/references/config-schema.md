# Configuration

Use this reference when editing a Limina config. It is a decision guide, not a
second exhaustive schema. Check the target release's public types and validators
for fields or defaults not covered here; source routes are in
[architecture.md](architecture.md#source-map).

## Module and root

New configs use `limina.config.mts`. Existing `.mjs`, `.ts`, and `.js` config files
are also discovered, in that order after `.mts`, at each directory from cwd
through its ancestors. `--config` selects an explicit file. Config selection
precedes governance-root selection: the nearest `package.json` above the selected
config establishes the root. A child package config therefore need not govern
its parent workspace.

The native loader is the default. `--config-loader tsx` requires a locally
resolvable supported `tsx`. Respect Node's module rules; `.mts`/`.mjs` are ESM,
whereas `.js` can be CommonJS. Do not change module format as an incidental fix.

`defineConfig` accepts an object, a promise, or a function returning either.
Functions receive `{ command, mode }`; mode is the CLI value, then `NODE_ENV`,
then `default`. The helper supplies types; loading and validation enforce the
contract. Config modules execute code, so inspect unfamiliar modules before runs.

## Public domains

Every top-level field is optional:

| Field             | Responsibility                                                 |
| ----------------- | -------------------------------------------------------------- |
| `scope.regions`   | Activated governance regions and explicit owner cuts           |
| `scope.source`    | Source coverage include/exclude selectors                      |
| `scope.checkers`  | Named checker scopes plus automatic discovery policy           |
| `graph.rules`     | Labeled deny/allow rules for project relations and imports     |
| `source`          | Import authority grants, ambient declarations, and Knip policy |
| `proof.allowlist` | Reasoned exceptions for otherwise uncovered files              |
| `package.entries` | Named publishable output roots and per-tool settings           |
| `release`         | Release content comparison and package-manifest lint policy    |
| `pipelines`       | Named ordered task/command sequences                           |
| `concurrency`     | Task, checker, package, and release execution budgets          |
| `cache`           | Persistent analysis cache policy and extra file inputs         |

Do not generate the removed `config`, `regions`, `execution`, `checks`, or
`configDependencies` top-level shapes. Move old `regions` to `scope.regions`,
`config.source` to `scope.source`, `config.checkers` to `scope.checkers`,
`execution` to `concurrency`, and `configDependencies` to `cache.dependencies`.
Do not mechanically move old parser settings such as `config.imports`: current
checker toolchains own semantic discovery.

Most public selectors are relative to the governance root. `cache.dependencies`
is relative to the config file; `liminaOptions` paths are relative to their
declaring tsconfig. Preserve these different anchors.

## Checker selection

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  scope: {
    checkers: {
      auto: { exclude: ['examples/scratch/tsconfig.json'] },
      'vue-tsc': { include: ['apps/web/tsconfig.json'] },
    },
  },
});
```

The web path must be an active default entry. Named scopes select entries first;
automatic discovery remains enabled for the rest. Omission is valid. The legacy
`mode: 'auto'`, custom checker names, and per-scope `preset` fields are invalid.
`auto` accepts `exclude` and `useTsgo`; named scopes accept a nonempty `include`
and optional `exclude`.

| Key            | Execution                    | Prerequisites to inspect                                                |
| -------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `tsc`          | Internal declaration build   | Required TypeScript peer                                                |
| `tsgo`         | Internal declaration build   | `@typescript/native-preview` and TypeScript                             |
| `vue-tsc`      | Internal declaration build   | Supported Vue checker/parser toolchain and TypeScript                   |
| `astro`        | Framework typecheck per leaf | Leaf-local `astro`, `@astrojs/check`, TypeScript, generated Astro types |
| `svelte-check` | Framework typecheck per leaf | Leaf-local `svelte-check`, `svelte2tsx`, `svelte`, TypeScript           |

Use installed manifests and compatibility checks for exact supported versions.
`vue-tsgo` is not a current checker key. `auto.useTsgo: true` changes the ordinary
TypeScript fallback; it does not replace framework owners. Limina does not run
Astro/SvelteKit sync for the project. Run the project's existing generation step
when its framework inputs require it.

Named selectors may select only default `tsconfig.json` entries. A named leaf
such as `tsconfig.lib.json` must be reachable from one. A nested solution must
also use the default name. `exclude` removes direct entries, not valid references
reached from another selected entry. `scope.source.exclude` is a different boundary.
Do not explicitly assign every shared TypeScript leaf: connected build projects
may need one compatible declaration checker; contradictory fixed owners fail.

## Boundaries and exceptions

- `scope.regions.exclude` entries require `kind`, `include`, and `reason`.
  Kinds are `package-scope`, `workspace-package`, and `tsconfig`. Check the actual
  owner cut before adding one; a glob cannot activate an otherwise foreign region.
- Omit `scope.source.exclude` for defaults. An explicit array replaces defaults;
  include `'...'` to extend them. An empty array is invalid.
- Activate a `graph.rules` label in the relevant tsconfig's
  `liminaOptions.graphRules`. A rule definition alone does not select projects.
  `deny.deps` entries use `{ name, reason }`; `deny.refs` and `allow.refs` use
  `{ path, reason }`. Use package names, `#imports` patterns, or Node builtins for
  dependency names, not file paths or URLs.
- `proof.allowlist` uses `{ file, reason }` only for uncovered files inside the
  source boundary. Already-covered or outside-boundary files are errors.
- `source.importAuthority.allow` grants specific owners access to specified
  workspace-root dependencies, with reasons and optional file selectors. It is
  not a blanket permission to consume any root dependency.
- `source.declarations.ambient` identifies justified ambient declarations; it
  does not turn them into implementation modules.
- `source.knip` can be `false`, `true`, or a Limina policy object containing
  `root` and `workspaces`. Read the current source validator before adding
  `entry`, `ignoreDependencies`, or `ignoreFiles`; these entries require reasons.
  Limina policy is not arbitrary Knip config passthrough. Do not disable Knip
  just to hide missing reachability or dependency evidence.

## Ordered pipelines

Example for a project whose existing `build` script produces the configured
package outputs:

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  pipelines: {
    artifacts: [
      'graph:check',
      'source:check',
      'proof:check',
      { type: 'command', command: 'pnpm', args: ['run', 'build'] },
      'package:check',
    ],
  },
});
```

Run it with `limina check artifacts`; it does not implicitly add the default
pipeline. Built-in task names are `graph:prepare`, `graph:check`, `source:check`,
`proof:check`, `checker:build`, `checker:typecheck`, `package:check`, and
`release:check`. A task object uses `{ type: 'task', name }`.

External command objects accept `command`, `args`, `cwd`, and `env`. Relative
`cwd` resolves from the governance root and `env` extends the process environment.
String commands split on whitespace; use an argument array for spaces and do not
assume shell quoting or shell operators. Named pipelines reject extra runtime
arguments, including `--` forwarding. Put tool flags in the configured step.

Named steps keep their configured order. The default plan may schedule independent
tasks concurrently. External commands separate analysis generations; they do not
reevaluate the config function. Avoid recursively calling a pipeline from the
build script it invokes.

`concurrency` accepts positive integers or `'auto'` for `tasks`, `checkerBuild`,
`checkerTypecheck`, `packageEntries`, and `releaseEntries`. Tune only after
observing resource pressure; concurrency is not an ordering contract.

## Analysis cache

Omission or `cache: true` enables persistent analysis caching. `cache: false`
prevents analysis restoration/publication and leaves existing snapshots in place.
It does not disable checker `.tsbuildinfo`, in-memory caches, or issue records.

For files read outside normal module loading, use exact file paths:

```ts
import { defineConfig } from 'limina';

export default defineConfig({
  cache: { dependencies: ['./rules.json'] },
});
```

The object requires `dependencies`; `[]` is valid, `{}` is not. Paths are relative
to the selected config file, may be absolute or use `../`, and may name a missing
file. Directories, globs, URLs, and fields such as `enabled` or `force` are invalid.
This models file inputs, not environment variables, network state, or clocks.

`limina check [pipeline] --force` requests cold analysis, normally refreshing an
eligible snapshot. It neither forces checker rebuilds nor overrides `cache: false`.
It cannot be combined with `--issues`. Do not claim that enabling caching makes
every framework or command eligible for persistent restoration/publication.
