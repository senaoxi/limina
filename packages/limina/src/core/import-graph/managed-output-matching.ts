import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import type {
  ManagedOutputMatch,
  ManagedOutputProjectContext,
  NormalizedManagedOutputProjectContext,
} from './managed-output-types';

const declarationSuffixes = ['.d.mts', '.d.cts', '.d.ts'] as const;
const preferredSourceExtensionOrder = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.vue',
  '.svelte',
  '.js',
  '.jsx',
] as const;

export function getDeclarationSuffix(filePath: string): string | null {
  return (
    declarationSuffixes.find((suffix) => filePath.endsWith(suffix)) ?? null
  );
}

function isDeclarationFamilyExtension(extension: string): boolean {
  return declarationSuffixes.includes(
    extension as (typeof declarationSuffixes)[number],
  );
}

function normalizeExtension(extension: string): string | null {
  const trimmed = extension.trim();

  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function getDeclarationPreferredExtensions(
  declarationSuffix: string,
): readonly string[] {
  const preferredBySuffix: Readonly<Record<string, readonly string[]>> = {
    '.d.cts': ['.cts'],
    '.d.mts': ['.mts'],
  };

  return preferredBySuffix[declarationSuffix] ?? [];
}

function shouldAppendExtension(options: {
  available: ReadonlySet<string>;
  extension: string;
  ordered: readonly string[];
}): boolean {
  return (
    options.available.has(options.extension) &&
    !options.ordered.includes(options.extension)
  );
}

function appendAvailableExtensions(options: {
  available: ReadonlySet<string>;
  candidates: Iterable<string>;
  ordered: string[];
}): void {
  for (const extension of options.candidates) {
    if (shouldAppendExtension({ ...options, extension })) {
      options.ordered.push(extension);
    }
  }
}

function createSourceExtensionOrder(
  declarationSuffix: string,
  extensions: readonly string[],
): string[] {
  const extensionSet = new Set(
    extensions
      .map(normalizeExtension)
      .filter((extension): extension is string => extension !== null)
      .filter((extension) => !isDeclarationFamilyExtension(extension)),
  );
  const orderedExtensions: string[] = [];
  const candidateGroups: readonly Iterable<string>[] = [
    getDeclarationPreferredExtensions(declarationSuffix),
    preferredSourceExtensionOrder,
    extensionSet,
  ];

  for (const candidates of candidateGroups) {
    appendAvailableExtensions({
      available: extensionSet,
      candidates,
      ordered: orderedExtensions,
    });
  }

  return orderedExtensions;
}

function replaceDeclarationSuffix(
  declarationFilePath: string,
  declarationSuffix: string,
  sourceExtension: string,
): string {
  const sourceBase = declarationFilePath.slice(0, -declarationSuffix.length);
  return `${sourceBase}${sourceExtension}`;
}

export function normalizeManagedOutputContext(
  context: ManagedOutputProjectContext,
): NormalizedManagedOutputProjectContext {
  return {
    checkerName: context.checkerName,
    extensions: context.extensions
      .map(normalizeExtension)
      .filter((extension): extension is string => extension !== null),
    outputOptions: {
      outDir: normalizeAbsolutePath(context.outputOptions.outDir),
      rootDir: normalizeAbsolutePath(context.outputOptions.rootDir),
    },
    ownedFileNames: new Set(context.ownedFileNames.map(normalizeAbsolutePath)),
    sourceConfigPath: normalizeAbsolutePath(context.sourceConfigPath),
  };
}

function isExactSourcePath(
  sourceBasePath: string,
  extensions: readonly string[],
): boolean {
  return extensions.some(
    (extension) =>
      !isDeclarationFamilyExtension(extension) &&
      sourceBasePath.endsWith(extension),
  );
}

function createExtensionCandidatePaths(options: {
  context: NormalizedManagedOutputProjectContext;
  declarationSuffix: string;
  mappedDeclarationPath: string;
}): string[] {
  return createSourceExtensionOrder(
    options.declarationSuffix,
    options.context.extensions,
  ).map((extension) =>
    normalizeAbsolutePath(
      replaceDeclarationSuffix(
        options.mappedDeclarationPath,
        options.declarationSuffix,
        extension,
      ),
    ),
  );
}

function createSourceCandidatePaths(options: {
  context: NormalizedManagedOutputProjectContext;
  declarationSuffix: string;
  mappedDeclarationPath: string;
}): string[] {
  const sourceBasePath = options.mappedDeclarationPath.slice(
    0,
    -options.declarationSuffix.length,
  );
  const exactSourcePaths = isExactSourcePath(
    sourceBasePath,
    options.context.extensions,
  )
    ? [sourceBasePath]
    : [];

  return [...exactSourcePaths, ...createExtensionCandidatePaths(options)];
}

function collectMatchedSourcePaths(options: {
  context: NormalizedManagedOutputProjectContext;
  declarationFilePath: string;
  declarationSuffix: string;
}): string[] {
  const relativeDeclarationPath = path.relative(
    options.context.outputOptions.outDir,
    options.declarationFilePath,
  );
  const mappedDeclarationPath = normalizeAbsolutePath(
    path.resolve(
      options.context.outputOptions.rootDir,
      relativeDeclarationPath,
    ),
  );

  return createSourceCandidatePaths({
    context: options.context,
    declarationSuffix: options.declarationSuffix,
    mappedDeclarationPath,
  }).filter((sourceFilePath) =>
    options.context.ownedFileNames.has(sourceFilePath),
  );
}

function createContextMatch(options: {
  context: NormalizedManagedOutputProjectContext;
  declarationFilePath: string;
  matchedSourceFilePaths: readonly string[];
}): ManagedOutputMatch | 'ambiguous' | null {
  const uniquePaths = [...new Set(options.matchedSourceFilePaths)];

  if (uniquePaths.length === 0) {
    return null;
  }

  if (uniquePaths.length > 1) {
    return 'ambiguous';
  }

  return {
    checkerName: options.context.checkerName,
    declarationFilePath: options.declarationFilePath,
    mappedSourceFilePath: uniquePaths[0]!,
    sourceConfigPath: options.context.sourceConfigPath,
  };
}

export function resolveManagedOutputContextMatch(
  context: NormalizedManagedOutputProjectContext,
  declarationFilePath: string,
  declarationSuffix: string,
): ManagedOutputMatch | 'ambiguous' | null {
  if (
    !isPathInsideDirectory(declarationFilePath, context.outputOptions.outDir)
  ) {
    return null;
  }

  return createContextMatch({
    context,
    declarationFilePath,
    matchedSourceFilePaths: collectMatchedSourcePaths({
      context,
      declarationFilePath,
      declarationSuffix,
    }),
  });
}
