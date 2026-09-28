# Condition Domains

`graph.conditionDomains` tells Limina which condition set a real source entry
should use when resolving imports. Limina finds the declaration build graph for
that entry, expands its references, and checks that every reachable project uses
the configured `compilerOptions.customConditions`.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    conditionDomains: [
      {
        name: 'web',
        entry: 'apps/web/tsconfig.json',
        customConditions: ['browser', 'source'],
      },
      {
        name: 'node',
        entry: 'apps/node/tsconfig.json',
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

A declaration reference tree is only the project graph used by `tsc -b`. It does
not say whether an entry should resolve as browser code, `Node` code, or source
code. If one declaration tree mixes different `customConditions`, the same
package export can resolve to different files in different projects:
typechecking sees one file, while runtime resolution or graph import analysis
sees another. That can quietly split emitted declarations, dependency edges, and
workspace export classification.

`graph.conditionDomains` makes that choice explicit: this entry belongs to this
condition domain and should use this condition set. It does not replace
`tsconfig`; `compilerOptions.customConditions` is still the real resolver input.
Limina only compares the expected condition set with the actual project graph.

## conditionDomains

- **Type:** `Array<{ name: string; entry: string; customConditions: string[] }>`

`entry` should point to an ordinary source `tsconfig` selected by an active
checker. Build aggregators such as `tsconfig.build.json` are not valid entries
because a condition domain describes one concrete declaration reference tree.

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
  the domain's `customConditions`.

In other words, a condition domain only describes and checks "which conditions
should this tree resolve with?" It does not create references, edit `tsconfig`, or
discover projects outside the checker graph.

## What You Get

Explicit condition domains turn "does this entry resolve as web, node, or
source?" into a rule Limina can check. If it is wrong, graph check fails early
instead of letting a package `exports` map choose the wrong branch and later show
up as a missing edge, a false positive, or an incorrect artifact classification.

They also let multi-entry workspaces govern multiple resolution domains in
parallel. For example, a browser entry can use `['browser', 'source']` while a
`Node` entry uses `['node', 'source']`. Each entry's declaration reference tree
stays internally consistent inside the condition domain Limina checks.
