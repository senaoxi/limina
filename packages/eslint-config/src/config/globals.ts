import globals from 'globals';

export const supportedEcmaGlobals: typeof globals.es2023 = globals.es2023;

export const esmRestrictedNodeGlobals: string[] = [
  '__dirname',
  '__filename',
  'exports',
  'module',
  'require',
];

export const nodeEsmGlobals: Record<string, boolean> = Object.fromEntries(
  Object.entries(globals.node).filter(
    ([name]) => !esmRestrictedNodeGlobals.includes(name),
  ),
);

export const commonJsModuleGlobals: Record<string, 'readonly'> = {
  __dirname: 'readonly',
  __filename: 'readonly',
  exports: 'readonly',
  module: 'readonly',
  require: 'readonly',
};
