import path from 'pathe';

export const capabilityDiscoveryExtensions: string[] = [
  '.astro',
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

const compoundDeclarationExtensions = ['.d.cts', '.d.mts', '.d.ts'];

function findCompoundDeclarationExtension(
  fileName: string,
): string | undefined {
  return compoundDeclarationExtensions.find((extension) =>
    fileName.endsWith(extension),
  );
}

export function getFileExtension(fileName: string): string {
  const baseName = path.basename(fileName);
  return findCompoundDeclarationExtension(baseName) ?? path.extname(baseName);
}
