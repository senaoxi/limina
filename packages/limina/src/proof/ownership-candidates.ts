export function isDeclarationInputFile(fileName: string): boolean {
  return (
    fileName.endsWith('.d.ts') ||
    fileName.endsWith('.d.mts') ||
    fileName.endsWith('.d.cts')
  );
}

export function isOrdinarySourceOwnershipCandidate(fileName: string): boolean {
  if (isDeclarationInputFile(fileName)) {
    return false;
  }

  return ['.ts', '.tsx', '.mts', '.cts'].some((extension) =>
    fileName.endsWith(extension),
  );
}

function normalizeExtension(extension: string): string {
  return extension.startsWith('.') ? extension : `.${extension}`;
}

export function isCheckerGraphDeclarationOwnerCandidate(
  fileName: string,
  extensions: readonly string[],
): boolean {
  if (isDeclarationInputFile(fileName)) {
    return false;
  }

  return extensions.some((extension) =>
    fileName.endsWith(normalizeExtension(extension)),
  );
}
