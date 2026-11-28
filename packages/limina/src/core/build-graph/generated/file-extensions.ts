import path from 'pathe';

export { capabilityDiscoveryExtensions } from '../../tsconfig/capability-discovery-extensions';

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
