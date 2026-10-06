# ESLint entries

The private gates package contains Limina's existing ESLint configuration and
repository rules. Bootstrap with `pnpm run build:tools` before loading compiled
ESLint entries.

```js
import eslintGeneralConfig from '@limina/gates/eslint';
import { rootFileConfigs } from '@limina/gates/eslint/presets';
import { defineConfig } from 'eslint/config';

export default defineConfig([...eslintGeneralConfig, ...rootFileConfigs]);
```

`@limina/gates/eslint/config` exports file patterns, environment/version constants
and shared rule groups. `@limina/gates/eslint/plugins` exports the unified logger
and portable-path plugins. The general configuration includes the pnpm catalog
adapter; the root preset exports `root` and `rootFileConfigs`.

The root [ESLint composition](../../eslint.config.mjs) applies product, test,
script and build-plugin scopes. Keep those scopes and overrides when adjusting
rules. The package tests exercise parser behavior, override ordering and the
repository plugins; run `pnpm --filter @limina/gates test` or root
`pnpm run test:tooling`.
