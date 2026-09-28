import type { ESLint } from 'eslint';
import { unifiedLogEntry } from './rules/create-logger-rule.js';

export const createLoggerPlugin: ESLint.Plugin = {
  rules: {
    'unified-log-entry': unifiedLogEntry,
  },
};
