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
      },
    },
  },
});
```

## `rules.<label>`

The `rules` key must match the `limina` label in a declaration leaf. Only `tsconfig*.dts.json` files with the same label enable that rule.

Pair the rule with a label in the declaration leaf:

```jsonc
{
  "limina": "runtime-client",
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
  "limina": "runtime-client",
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

When `pnpm exec limina graph check` runs, Limina parses imports from `src/client/load.ts` with TypeScript. Because the file belongs to a leaf labeled `"limina": "runtime-client"`, Limina compares each resolved specifier with `deny.deps`: `node:fs` matches `node:*`, and `@acme/internal-node` matches the package rule.

The result is a graph check failure with the configured reason for each match. Reviewers can immediately see that browser runtime code imported Node-only capabilities instead of guessing whether those imports will break in the browser.
