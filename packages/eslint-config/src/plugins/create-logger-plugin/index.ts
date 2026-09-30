import type { ESLint } from 'eslint';
import { unifiedLogEntry } from './rules/create-logger-rule.js';

const loggerPlugin: ESLint.Plugin = {
  rules: {
    'unified-log-entry': unifiedLogEntry,
  },
};

export { loggerPlugin as createLoggerPlugin };
