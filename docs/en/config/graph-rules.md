# Graph Rules

If your project has clear dependency directions, graph rules can help Limina find imports that violate them. For example, browser code should not depend on Node built-in modules.

First, define a rule named `browser` in the Limina config:

`limina.config.mjs`:

```js
import { defineConfig } from 'limina';

export default defineConfig({
  graph: {
    rules: {
      browser: {
        deny: {
          deps: [{ name: 'node:*', reason: 'Browser code cannot depend on Node built-in modules' }],
        },
      },
    },
  },
});
```

Next, add the label to the `tsconfig` **responsible for the browser source**. This example assumes the Limina config is at the workspace root, `apps/web` has its own `package.json`, and the workspace declaration includes it. In a pnpm workspace, for example, `packages` in `pnpm-workspace.yaml` must cover it. In a single-package project, add the label to that project's source config instead.

Here, `apps/web/tsconfig.json` directly includes the browser code under `src`:

`apps/web/tsconfig.json`:

```jsonc
{
  "include": ["src/**/*.ts"],
  "liminaOptions": {
    "graphRules": ["browser"],
  },
}
```

Keep any `compilerOptions` your project needs. If a file covered by that config imports `node:fs`, `pnpm exec limina graph check` reports `LIMINA_GRAPH_ACCESS_DENIED` and the configured reason. Remove or adjust the import, then check again. A rule applies only when a source config references it; naming a directory `web` does not enable it automatically.

The default `limina check` also includes graph checking. Omitting `graph` still runs that check without these custom rules. When `graph` is present, `rules` is required: `rules: {}` declares no additional rules, while `graph: {}` is invalid. Applicable `deny.refs` rules are checked before compiler execution even in a checker-only named pipeline.

## rules.\<label\>

- **Type:** `Record<string, GraphRule>`

Each `rules` key names a label. A source config uses the corresponding rule when it lists the label in `liminaOptions.graphRules`. A config can list multiple labels and use their matching rules. An unused label does not apply to any source config.

Pair the rule with a label in the source config:

```jsonc
{
  "liminaOptions": {
    "graphRules": ["browser"],
  },
  "include": ["src/**/*.ts"],
}
```

Source covered by that config uses `graph.rules.browser`.

## allow.refs

- **Type:** `Array<{ path: string; reason: string }>`

`allow.refs` is used when graph checking classifies extra references. It can acknowledge a reference already present in the declaration graph that static import analysis cannot prove. This is a declaration-build reference; it does not require handwritten `references` in a source leaf.

Each `path` is relative to `config.rootDir` and must map to a reachable generated declaration leaf. You may specify the original source leaf path, including `../` for an external activated package. An aggregator or ungoverned config is not a valid target. `allow.refs` does not create a reference or make a denied reference valid. If the same path matches both `allow` and `deny`, `deny.refs` wins.

Generated references can come from source relationships, a [managed declaration's checking context](../monorepo-constraints.md#choose-a-declaration-configuration-context), or `liminaOptions.implicitRefs` on source configs. Literal dynamic imports are already analyzed. Use `implicitRefs` to add a real declaration-build relationship that computed runtime imports, generated manifests, or other unobserved code cannot expose. It does not add a module resolver or make an unsupported virtual module consumable.

`allow.refs` only explains an existing relationship. To add a relationship static analysis cannot see, use `implicitRefs` without duplicating it in an allow rule. Neither mechanism overrides deny rules or requires edits to generated files in `.limina`. `implicitRefs.path` is relative to the source config declaring it; see the [additional declaration relationship example](../concepts.md#source-config) for the full shape.

## deny.refs

- **Type:** `Array<{ path: string; reason: string }>`

`deny.refs` forbids a labeled project from referencing the declaration build config for a specific source `tsconfig`. It can express boundaries such as “client runtime must not depend on server runtime” or “public API must not depend on internal tools”.

The example layout is:

```text
packages/app/
  package.json
  tsconfig.json
  src/client/tsconfig.lib.json
  src/node/tsconfig.lib.json
  src/client/main.ts
  src/node/read-file.ts
```

Assume `packages/app` is included in the workspace, its manifest sets `"type": "module"`, and the Limina config is at the workspace root. `packages/app/tsconfig.json` is an entry that references both source configs:

`packages/app/tsconfig.json`:

```jsonc
{
  "files": [],
  "references": [
    { "path": "./src/client/tsconfig.lib.json" },
    { "path": "./src/node/tsconfig.lib.json" },
  ],
}
```

Without an entry referencing these named configs, Limina cannot discover the rule target and reports an invalid graph-rule configuration.

Define the prohibited target in the Limina config. The path is relative to the config root. This is a separate example; if you already configured the `browser` rule above, add `runtime-client` to the same `rules` object:

`limina.config.mjs`:

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
              reason: 'Client code cannot depend on Node source',
            },
          ],
        },
      },
    },
  },
});
```

Label the client source config `runtime-client`:

```jsonc
// packages/app/src/client/tsconfig.lib.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "types": [],
  },
  "liminaOptions": {
    "graphRules": ["runtime-client"],
  },
  "include": ["main.ts"],
}
```

The Node source config uses the same `compilerOptions` and includes `read-file.ts`. Here `types: []` only keeps the example independent of other environment types; keep the type environment your own project needs.

```jsonc
// packages/app/src/node/tsconfig.lib.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "types": [],
  },
  "include": ["read-file.ts"],
}
```

Export a function from the Node source and import it from the client:

`packages/app/src/node/read-file.ts`:

```ts
export const read = () => 'node data';
```

`packages/app/src/client/main.ts`:

```ts
import { read } from '../node/read-file.js';

export const message = read();
```

When you run `pnpm exec limina graph check`, Limina compares the source provider relationship with `graph.rules.runtime-client.deny.refs` and checks actual project references. Applicable prohibited references are rejected before execution even when you run only a checker.

The client import that requires the Node source config is reported as denied graph access with the configured `reason`. Resolve the source relationship or the rule, rather than editing generated files.

## deny.deps

- **Type:** `Array<{ name: string; reason: string }>`

`deny.deps` forbids source imports of selected packages, `#imports`, or Node built-in modules. `name` can be a package name, a `#subpath` such as `#server/*`, `fs`, `node:fs`, or `node:*` for all Node built-ins.

For example, the `browser` rule at the start of this page uses `node:*`. If the labeled `apps/web/tsconfig.json` covers this file:

```ts
// apps/web/src/load.ts
import { readFileSync } from 'node:fs';
```

The import matches `node:*` in `graph.rules.browser.deny.deps`. You can also add a rule such as `name: '@acme/internal-node'` to prohibit a particular server-side package. Change the import or reconsider which source configs carry the label, then run the check again.
