declare const require: {
  resolve(specifier: string): string;
};

export const resolvedPath = require.resolve('../fixture/pkg/src/value');
