import path from 'pathe';

export const capabilityDiscoveryExtensions: string[] = [
  '.cts',
  '.d.cts',
  '.d.mts',
  '.d.ts',
  '.js',
  '.jsx',
  '.json',
  '.mjs',
  '.mts',
  '.svelte',
  '.ts',
  '.tsx',
  '.vue',
];

export function getFileExtension(fileName: string): string {
  const baseName = path.basename(fileName);

  if (baseName.endsWith('.d.cts')) {
    return '.d.cts';
  }

  if (baseName.endsWith('.d.mts')) {
    return '.d.mts';
  }

  if (baseName.endsWith('.d.ts')) {
    return '.d.ts';
  }

  return path.extname(baseName);
}
