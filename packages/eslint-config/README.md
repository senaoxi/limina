# @docs-islands/eslint-config

Shared ESLint configuration for the docs-islands monorepo.

## Features

- 🎯 TypeScript-first with strict type checking
- 🔧 Framework support for Vue 3 and React 18+
- 📝 Markdown linting with code block validation
- ♿ Accessibility rules (jsx-a11y)
- 🎨 Prettier integration
- 🔌 Custom plugins for monorepo-specific rules
- 📦 PNPM workspace validation

## Usage

### General Configuration (Default)

```javascript
// eslint.config.mjs
import eslintGeneralConfig from '@docs-islands/eslint-config';
import { defineConfig } from 'eslint/config';

export default defineConfig([...eslintGeneralConfig]);
```

### Core Preset

For core rendering packages with complex logic:

```javascript
import { core } from '@docs-islands/eslint-config/presets';
export default defineConfig([...core]);
```

### Root Preset

For monorepo root directory:

```javascript
import { root } from '@docs-islands/eslint-config/presets';
export default defineConfig([...root]);
```

### Docs Preset

For documentation sites with Vue, React, and Markdown:

```javascript
export { docs as default } from '@docs-islands/eslint-config/presets';
```

### Playground Preset

For E2E test playgrounds:

```javascript
export { playground as default } from '@docs-islands/eslint-config/presets';
```

## Shared Configurations

Import reusable rule sets:

```javascript
import {
  baseTestFileRules,
  baseScriptFileRules,
  untypedTypeScriptRules,
  testFilePatterns,
  nodeFilePatterns,
} from '@docs-islands/eslint-config/config';
```

### baseTestFileRules

Relaxed rules for test files:

- Disables complexity limits
- Allows `any` type and unsafe operations
- Permits console.log

### baseScriptFileRules

Rules for build/automation scripts:

- Moderate complexity limits (30)
- Allows process.exit
- Relaxed TypeScript safety

## Custom Plugins

### create-logger-plugin

Enforces centralized logging through `@docs-islands/utils/logger`.

```javascript
import { createLoggerPlugin } from '@docs-islands/eslint-config/plugins';

export default defineConfig([
  {
    plugins: { '@docs-islands/core': createLoggerPlugin },
    rules: { '@docs-islands/core/unified-log-entry': 'error' },
  },
]);
```

## Complexity Limits

| Preset             | Complexity | Max Lines | Max Lines/Function | Max Depth |
| ------------------ | ---------- | --------- | ------------------ | --------- |
| General            | 20         | -         | -                  | -         |
| Core (client/node) | 25         | 800       | 300                | 6         |
| Core (shared)      | off        | -         | 200                | off       |
| Root (scripts)     | 40         | 1200      | 240                | -         |
| Scripts (shared)   | 30         | 800       | 200                | -         |
| Test files         | off        | off       | off                | off       |

## Development

```bash
pnpm build      # Build
pnpm typecheck  # Type check
pnpm lint       # Lint
pnpm test       # Test
pnpm clean      # Clean
```
