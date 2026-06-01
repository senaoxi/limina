# Graph Rules

Graph rules are keyed by labels declared in `tsconfig*.dts.json`.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    rules: {
      'runtime-client': {
        deny: {
          refs: [
            {
              path: 'packages/app/src/node/tsconfig.lib.dts.json',
              reason: 'client runtime must not depend on Node runtime',
            },
          ],
          deps: [
            {
              name: 'node:*',
              reason: 'browser output must stay free of Node builtins',
            },
            {
              name: '@acme/internal-node',
              reason: 'browser output must not consume Node-only packages',
            },
          ],
        },
        allow: {
          refs: [
            {
              path: 'packages/app/src/generated/tsconfig.lib.dts.json',
              reason: 'generated declarations are wired by the build pipeline',
            },
          ],
        },
      },
    },
  },
});
```

## `rules.<label>`

The `rules` key must match an entry in `liminaOptions.graphRules` in a declaration leaf. A leaf can list multiple labels, and Limina merges the matching rules.

Pair the rule with labels in the declaration leaf:

```jsonc
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "extends": ["./tsconfig.lib.json"],
  "references": [],
}
```

Source covered by that leaf now uses `graph.rules.runtime-client`.

## `deny.refs`

`deny.refs` forbids a labeled project from referencing a specific declaration leaf. It is useful for boundaries such as "client runtime must not depend on server runtime" or "public API must not depend on internal tools".

For example, if the rule contains:

```jsonc
{
  "path": "packages/app/src/node/tsconfig.lib.dts.json",
  "reason": "client runtime must not depend on Node runtime",
}
```

and a `runtime-client` leaf references that Node-only leaf, `limina graph check` fails and prints the configured reason.

In a fuller example, the repository can look like this:

```text
packages/app/
  src/client/tsconfig.lib.dts.json
  src/node/tsconfig.lib.dts.json
  src/client/main.ts
  src/node/read-file.ts
```

The client leaf is labeled `runtime-client`, but it incorrectly references the Node leaf:

```jsonc
// packages/app/src/client/tsconfig.lib.dts.json
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "extends": ["./tsconfig.lib.json"],
  "references": [
    {
      "path": "../node/tsconfig.lib.dts.json",
    },
  ],
}
```

When `pnpm exec limina graph check` runs, Limina starts from the checker entry, finds reachable declaration leaves, and reads each leaf's `references`. When it sees the `runtime-client` leaf referencing `packages/app/src/node/tsconfig.lib.dts.json`, it compares that reference with `graph.rules.runtime-client.deny.refs`.

The result is a graph check failure that points at the forbidden project reference and prints the configured `reason`. This means the problem is not just one import line; the TypeScript graph itself now says client runtime depends on Node runtime.

## `allow.refs`

`allow.refs` uses the same entry shape as `deny.refs`, but it only allows extra declared references that static import analysis cannot prove. It does not make denied references valid, and `deny.refs` still wins if the same path is both allowed and denied.

`limina graph sync` keeps currently declared extra references only when they match the merged `allow.refs` rules. It does not add unused allow entries.

## `deny.deps`

`deny.deps` forbids source imports of selected packages, `#imports`, or Node builtins. `name` can be a package name, `#server/*`, `fs`, `node:fs`, or `node:*` for all Node builtins.

If source covered by the labeled leaf contains:

```ts
// packages/app/src/client/load.ts
import { readFileSync } from 'node:fs';
import { createServerClient } from '@acme/internal-node';
```

`limina graph check` matches `node:*` and `@acme/internal-node` through the `runtime-client` rule and prints the configured reason. Browser/runtime boundaries are then verified by config and real imports, not just team convention.

The matching directory can look like this:

```text
packages/app/
  src/client/tsconfig.lib.dts.json
  src/client/load.ts
packages/internal-node/
  src/index.ts
```

The module imports denied dependencies:

```ts
// packages/app/src/client/load.ts
import { readFileSync } from 'node:fs';
import { createServerClient } from '@acme/internal-node';
```

When `pnpm exec limina graph check` runs, Limina parses imports from `src/client/load.ts` with TypeScript. Because the file belongs to a leaf configured with `liminaOptions.graphRules: ["runtime-client"]`, Limina compares each resolved specifier with `deny.deps`: `node:fs` matches `node:*`, and `@acme/internal-node` matches the package rule.

The result is a graph check failure with the configured reason for each match. Reviewers can immediately see that browser runtime code imported Node-only capabilities instead of guessing whether those imports will break in the browser.
