import type { ESLint } from 'eslint';
import { portablePathComparison } from './rules/portable-path-comparison-rule.js';

export const portablePathPlugin: ESLint.Plugin = {
  rules: {
    'portable-path-comparison': portablePathComparison,
  },
};
