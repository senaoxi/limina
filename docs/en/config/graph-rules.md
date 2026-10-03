# Graph Rules

Graph rules are keyed by labels declared in source `tsconfig*.json` files. Limina carries those labels into the generated build configs and uses them during graph checks to decide which references or dependencies are not allowed.

```js
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    rules: {
      'runtime-client': {
        deny: {
          refs: [
            {
              path: 'packages/app/src/node/tsconfig.lib.json',
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
              path: 'packages/app/src/generated/tsconfig.lib.json',
              reason: 'generated declarations are wired by the build pipeline',
            },
          ],
        },
      },
    },
  },
});
```

## rules.\<label\>

- **Type:** `Record<string, GraphRule>`

Each `rules` key names a label. The rule applies to source configs that list that label in `liminaOptions.graphRules`; a config can list multiple labels and uses their matching rules. An unused label does not apply to any source config.

Pair the rule with labels in the source config:

```jsonc
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "include": ["src/**/*.ts"],
}
```

Source covered by that config now uses `graph.rules.runtime-client`.

## allow.refs

- **Type:** `Array<{ path: string; reason: string }>`

`allow.refs` uses the same entry shape as `deny.refs`, and acknowledges extra declared references that static import analysis cannot prove. Each `path` is resolved from `config.rootDir` and must map to a reachable generated declaration leaf; use its original source leaf path, including `../` for an external activated package. A solution or an ungoverned config is not a valid rule target. It does not create references, it does not make denied references valid, and `deny.refs` still wins if the same path matches both `allow` and `deny`.

Generated references are inferred from source imports and from `liminaOptions.implicitRefs` on source `tsconfig` files. Literal dynamic imports are already analyzed. Use `implicitRefs` for an explicit declaration-build relationship that computed runtime imports, generated manifests, or other unobserved code cannot expose; it does not add a module resolver or make an unsupported virtual module consumable. Use `allow.refs` only to explain extra declared references that already exist.

## deny.refs

- **Type:** `Array<{ path: string; reason: string }>`

`deny.refs` forbids a labeled project from referencing the declaration build config for a specific source `tsconfig`. It is useful for boundaries such as "client runtime must not depend on server runtime" or "public `API` must not depend on internal tools".

For example, if the rule contains:

```jsonc
{
  "path": "packages/app/src/node/tsconfig.lib.json",
  "reason": "client runtime must not depend on Node runtime",
}
```

and a project labeled `runtime-client` references the generated `Node`-only config, `limina graph check` fails and prints the configured reason.

The example repository contains:

```text
packages/app/
  src/client/tsconfig.lib.json
  src/node/tsconfig.lib.json
  src/client/main.ts
  src/node/read-file.ts
```

The client source config is labeled `runtime-client`:

```jsonc
// packages/app/src/client/tsconfig.lib.json
{
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "include": ["main.ts"],
}
```

When `pnpm exec limina graph check` runs, Limina compares the source provider relationship with `graph.rules.runtime-client.deny.refs`, as well as checking actual project references. Reference inference omits a denied import-derived reference from the generated config; that omission does not make the source import valid.

A client import that requires the Node leaf is reported as denied graph access with the configured `reason`. Resolve the source relationship or the policy rather than editing generated files.

## deny.deps

- **Type:** `Array<{ name: string; reason: string }>`

`deny.deps` forbids source imports of selected packages, `#imports`, or `Node` builtins. `name` can be a package name, a `#subpath` such as `#server/*`, `fs`, `node:fs`, or `node:*` for all `Node` builtins.

If source covered by the labeled leaf contains:

```ts
// packages/app/src/client/load.ts
import { readFileSync } from 'node:fs';
import { createServerClient } from '@acme/internal-node';
```

`limina graph check` matches `node:*` and `@acme/internal-node` through the `runtime-client` rule and prints the configured reason.

The matching directory can look like this:

```text
packages/app/
  src/client/tsconfig.lib.json
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

When `pnpm exec limina graph check` runs, Limina parses imports from `src/client/load.ts` with `TypeScript`. Because the file belongs to a leaf configured with `liminaOptions.graphRules: ["runtime-client"]`, Limina compares each resolved specifier with `deny.deps`: `node:fs` matches `node:*`, and `@acme/internal-node` matches the package rule.

Graph check fails and reports the configured reason for each matching rule.
