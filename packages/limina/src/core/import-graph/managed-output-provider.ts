import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';

export interface ManagedOutputProjectContext {
  checkerName: string;
  sourceConfigPath: string;
  outputOptions: {
    outDir: string;
    rootDir: string;
  };
  ownedFileNames: readonly string[];
  extensions: readonly string[];
}

export interface ManagedOutputDeclarationProvider {
  declarationFilePath: string;
  mappedSourceFilePath: string;
  sourceConfigPath: string;
  checkerNames: readonly string[];
  reason: 'owned-source';
}

export interface ManagedOutputDeclarationLookup {
  resolve(
    declarationFilePath: string,
    preferredCheckerName?: string,
  ): ManagedOutputDeclarationProvider | null;
}

interface NormalizedManagedOutputProjectContext {
  checkerName: string;
  sourceConfigPath: string;
  outputOptions: {
    outDir: string;
    rootDir: string;
  };
  ownedFileNames: Set<string>;
  extensions: string[];
}

interface ManagedOutputMatch {
  checkerName: string;
  declarationFilePath: string;
  mappedSourceFilePath: string;
  sourceConfigPath: string;
}

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

function getDeclarationSuffix(filePath: string): string | null {
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

function createSourceExtensionOrder(
  declarationSuffix: string,
  extensions: readonly string[],
): string[] {
  const extensionSet = new Set(
    extensions
      .map(normalizeExtension)
      .filter((extension): extension is string => Boolean(extension))
      .filter((extension) => !isDeclarationFamilyExtension(extension)),
  );
  const orderedExtensions: string[] = [];
  const addExtension = (extension: string): void => {
    if (!extensionSet.has(extension) || orderedExtensions.includes(extension)) {
      return;
    }

    orderedExtensions.push(extension);
  };

  if (declarationSuffix === '.d.mts') {
    addExtension('.mts');
  } else if (declarationSuffix === '.d.cts') {
    addExtension('.cts');
  }

  for (const extension of preferredSourceExtensionOrder) {
    addExtension(extension);
  }

  for (const extension of extensionSet) {
    addExtension(extension);
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

function normalizeContext(
  context: ManagedOutputProjectContext,
): NormalizedManagedOutputProjectContext {
  return {
    checkerName: context.checkerName,
    sourceConfigPath: normalizeAbsolutePath(context.sourceConfigPath),
    outputOptions: {
      outDir: normalizeAbsolutePath(context.outputOptions.outDir),
      rootDir: normalizeAbsolutePath(context.outputOptions.rootDir),
    },
    ownedFileNames: new Set(context.ownedFileNames.map(normalizeAbsolutePath)),
    extensions: context.extensions
      .map(normalizeExtension)
      .filter((extension): extension is string => Boolean(extension)),
  };
}

function resolveContextMatch(
  context: NormalizedManagedOutputProjectContext,
  declarationFilePath: string,
  declarationSuffix: string,
): ManagedOutputMatch | 'ambiguous' | null {
  if (
    !isPathInsideDirectory(declarationFilePath, context.outputOptions.outDir)
  ) {
    return null;
  }

  const relativeDeclarationPath = path.relative(
    context.outputOptions.outDir,
    declarationFilePath,
  );
  const mappedDeclarationPath = normalizeAbsolutePath(
    path.resolve(context.outputOptions.rootDir, relativeDeclarationPath),
  );
  const matchedSourceFilePaths = createSourceExtensionOrder(
    declarationSuffix,
    context.extensions,
  )
    .map((extension) =>
      normalizeAbsolutePath(
        replaceDeclarationSuffix(
          mappedDeclarationPath,
          declarationSuffix,
          extension,
        ),
      ),
    )
    .filter((sourceFilePath) => context.ownedFileNames.has(sourceFilePath));

  if (matchedSourceFilePaths.length === 0) {
    return null;
  }

  if (new Set(matchedSourceFilePaths).size > 1) {
    return 'ambiguous';
  }

  return {
    checkerName: context.checkerName,
    declarationFilePath,
    mappedSourceFilePath: matchedSourceFilePaths[0]!,
    sourceConfigPath: context.sourceConfigPath,
  };
}

function createSourceIdentity(match: ManagedOutputMatch): string {
  return JSON.stringify([match.sourceConfigPath, match.mappedSourceFilePath]);
}

function sortCheckerNames(
  checkerNames: readonly string[],
  preferredCheckerName?: string,
): string[] {
  return [...checkerNames].sort((left, right) => {
    if (left === preferredCheckerName) {
      return -1;
    }

    if (right === preferredCheckerName) {
      return 1;
    }

    return left.localeCompare(right);
  });
}

export function createManagedOutputDeclarationLookup(
  contexts: readonly ManagedOutputProjectContext[],
): ManagedOutputDeclarationLookup {
  const normalizedContexts = contexts.map(normalizeContext);

  return {
    resolve(
      declarationFilePath: string,
      preferredCheckerName?: string,
    ): ManagedOutputDeclarationProvider | null {
      const normalizedDeclarationFilePath =
        normalizeAbsolutePath(declarationFilePath);
      const declarationSuffix = getDeclarationSuffix(
        normalizedDeclarationFilePath,
      );

      if (!declarationSuffix) {
        return null;
      }

      const matchesByIdentity = new Map<string, ManagedOutputMatch[]>();

      for (const context of normalizedContexts) {
        const match = resolveContextMatch(
          context,
          normalizedDeclarationFilePath,
          declarationSuffix,
        );

        if (match === 'ambiguous') {
          return null;
        }

        if (!match) {
          continue;
        }

        const identity = createSourceIdentity(match);

        matchesByIdentity.set(identity, [
          ...(matchesByIdentity.get(identity) ?? []),
          match,
        ]);
      }

      if (matchesByIdentity.size !== 1) {
        return null;
      }

      const matches = [...matchesByIdentity.values()][0]!;
      const firstMatch = matches[0]!;

      return {
        declarationFilePath: normalizedDeclarationFilePath,
        mappedSourceFilePath: firstMatch.mappedSourceFilePath,
        sourceConfigPath: firstMatch.sourceConfigPath,
        checkerNames: sortCheckerNames(
          matches.map((match) => match.checkerName),
          preferredCheckerName,
        ),
        reason: 'owned-source',
      };
    },
  };
}
