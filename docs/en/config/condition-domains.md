# Condition Domains

`graph.conditionDomains` declares the expected import resolution conditions
for a source entry. Limina finds the declaration build graph for
that entry, expands its references, and checks that every reachable project uses
the configured `compilerOptions.customConditions`.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    conditionDomains: [
      {
        name: 'web',
        entry: 'apps/web/tsconfig.client.json',
        customConditions: ['browser', 'source'],
      },
      {
        name: 'node',
        entry: 'apps/node/tsconfig.server.json',
        customConditions: ['node', 'source'],
      },
    ],
  },
});
```

## Why This Exists

`compilerOptions.customConditions` decides which branch of a package `exports`
map `TypeScript` and Limina's resolver use inside a governed `tsconfig` domain.
Conditions such as `browser`, `node`, and `source` usually mean "resolve this
code for a different environment or build mode." Other resolvers may instead
use one global condition set, which is a different model.

A declaration reference tree describes the project relationships used by
`tsc -b`; resolution conditions come from each project's configuration. If the
tree mixes different `customConditions`, the same package export can resolve to
different files across projects. Typechecking, runtime resolution, and graph
import analysis may then use different files, affecting emitted declarations,
dependency edges, and workspace export classification.

`graph.conditionDomains` records the condition set expected for an entry.
Limina compares that expectation with the project graph; the resolver continues
to read `compilerOptions.customConditions` from `tsconfig`.

## conditionDomains

- **Type:** `Array<{ name: string; entry: string; customConditions: string[] }>`

`entry` should point to an ordinary source leaf that maps to a generated declaration
project reachable from an active checker entry. For this example, each selected
`apps/*/tsconfig.json` solution references its named client or server leaf. A
source-owning default `tsconfig.json` is also valid. Solutions, build aggregators
such as `tsconfig.build.json`, and Astro/Svelte typecheck leaves do not have the
required declaration-project mapping.

Limina also runs a default check without explicit domains: for every checked
declaration project, that project and all declaration projects reachable through
its references must share the same effective `customConditions`. Explicit
`conditionDomains` let you also write down the condition set expected by a real
entry.

::: danger Note

When you configure `conditionDomains` for an entry, make sure the
`customConditions` listed here match the runtime conditions you actually intend
for that entry. Limina does not read or rewrite other resolver configuration. If
another resolver uses one global condition set while Limina checks several
`tsconfig` domains, a passing Limina check still cannot guarantee that every
runtime path chooses the same `exports` branch.

:::

## How Limina Checks It

Limina first prepares the generated graph and collects every governed generated
declaration project reachable from the active checker entries. The default check
starts from each declaration project, expands declaration `references`, and
requires the entire declaration subtree to share the same effective
`customConditions`.

When `conditionDomains` is configured, Limina also validates each condition
domain:

- `name` and `entry` must be non-empty strings, and `customConditions` must be an
  array of strings.
- `entry` must be config-root-relative and point to an existing source
  `tsconfig` governed by an activated package island. It may contain `../` for
  an external activated package.
- `entry` must already be governed by the active checker entries; a domain does
  not add otherwise unchecked projects to the graph.
- Limina expands the entry's declaration reference subtree and reuses the
  default consistency check.
- The entry project's effective `compilerOptions.customConditions` must equal
  the domain's `customConditions` after sorting and removing duplicates. Order
  and repeated strings do not create separate condition sets.

A condition domain checks the expected resolution conditions. It does not
create references, edit `tsconfig`, or discover projects outside the checker graph.

## What You Get

Graph check reports a mismatch when an entry's effective conditions differ
from its configured condition domain. This helps locate condition differences
that may affect `exports` resolution, dependency edges, or artifact classification.

A workspace with multiple entries can declare a separate condition domain
for each entry. For example, a browser entry can use `['browser', 'source']` while a
`Node` entry uses `['node', 'source']`. Each entry's declaration reference tree
stays internally consistent inside the condition domain Limina checks.
