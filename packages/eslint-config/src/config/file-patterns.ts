export const typescriptFiles: string[] = [
  '**/*.ts',
  '**/*.tsx',
  '**/*.mts',
  '**/*.cts',
];
export const javascriptFiles: string[] = ['**/*.js', '**/*.mjs'];
export const markdownVirtualFiles: string[] = ['**/*.md/*'];

export const nodeFilePatterns: string[] = [
  'packages/build-tools/src/{package-plugin,path,logger}.ts',
  '**/.vitepress/**/*.{js,cjs,mjs,ts,cts,mts}',
  '**/*.config.{js,cjs,mjs,ts,cts,mts}',
  '**/bin/**/*.{js,cjs,mjs,ts,cts,mts}',
  '**/docs/**/config.{js,cjs,mjs,ts,cts,mts}',
  '**/scripts/**/*.{js,cjs,mjs,ts,cts,mts}',
  '**/src/node/**/*.{js,cjs,mjs,ts,cts,mts}',
  '**/utils/**/*.{js,cjs,mjs,ts,cts,mts}',
  'bin/**/*.{js,cjs,mjs,ts,cts,mts}',
  'scripts/**/*.{js,cjs,mjs,ts,cts,mts}',
  'src/node/**/*.{js,cjs,mjs,ts,cts,mts}',
  'utils/**/*.{js,cjs,mjs,ts,cts,mts}',
];

export const testFilePatterns: string[] = [
  '**/__tests__/**/*.{js,jsx,ts,tsx,mjs,mjsx,mts,mtsx,cjs,cts}',
  '**/*.{test,spec}.{js,jsx,ts,tsx,mjs,mjsx,mts,mtsx,cjs,cts}',
  '**/tests/**/*.{js,jsx,ts,tsx,mjs,mjsx,mts,mtsx,cjs,cts}',
];
