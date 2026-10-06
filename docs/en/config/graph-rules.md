# Graph Rules

Graph rules express project boundaries as checkable constraints. Define a label's rules in `graph.rules`, then apply the label through `liminaOptions.graphRules` in a source tsconfig. Only configs using that label are governed by those rules.

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

`allow.refs` uses the same entry shape as `deny.refs`. It applies to the graph check's extra-reference classification: it acknowledges references already present in the declaration build graph that static import analysis cannot prove. These are declaration build references, not instructions to handwrite `references` in source leaves. Each `path` is resolved from `config.rootDir` and must map to a reachable generated declaration leaf; you may use its original source leaf path, including `../` for an external activated package. A solution or an ungoverned config is not a valid rule target. It does not create references or make denied references valid. `deny.refs` still wins if the same path matches both `allow` and `deny`.

Generated references are inferred from source imports and `liminaOptions.implicitRefs` on source tsconfigs. Literal dynamic imports are already analyzed. Use `implicitRefs` for an explicit declaration-build relationship that computed runtime imports, generated manifests, or other unobserved code cannot expose; it does not add a module resolver or make an unsupported virtual module consumable. `allow.refs` only explains existing relationships. To add a relationship static analysis cannot see, use `implicitRefs` without duplicating it in an allow rule. Neither mechanism overrides deny rules or requires edits to generated files in `.limina`. `implicitRefs.path` is relative to the source config declaring it; see the [additional declaration relationship example](../concepts.md#source-config) for the full shape.

## deny.refs

- **Type:** `Array<{ path: string; reason: string }>`

`deny.refs` forbids a labeled project from referencing the declaration build config for a specific source `tsconfig`. It is useful for boundaries such as "client runtime must not depend on server runtime" or "public `API` must not depend on internal tools".

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

These imports match `node:*` and `@acme/internal-node`, respectively. Graph check fails and reports each rule's `reason`. Fix the source imports or reconsider which configs should carry the label, then rerun the check.
