import { normalizeAbsolutePath } from '#utils/path';
import {
  getDeclarationSuffix,
  normalizeManagedOutputContext,
  resolveManagedOutputContextMatch,
} from './managed-output-matching';
import type {
  ManagedOutputDeclarationLookup,
  ManagedOutputDeclarationProvider,
  ManagedOutputMatch,
  ManagedOutputProjectContext,
  NormalizedManagedOutputProjectContext,
} from './managed-output-types';

export type {
  ManagedOutputDeclarationLookup,
  ManagedOutputDeclarationProvider,
  ManagedOutputProjectContext,
} from './managed-output-types';

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

function appendMatch(
  matchesByIdentity: Map<string, ManagedOutputMatch[]>,
  match: ManagedOutputMatch | null,
): void {
  if (match === null) {
    return;
  }

  const identity = createSourceIdentity(match);
  const matches = matchesByIdentity.get(identity) ?? [];
  matchesByIdentity.set(identity, [...matches, match]);
}

function collectContextMatches(options: {
  contexts: readonly NormalizedManagedOutputProjectContext[];
  declarationFilePath: string;
  declarationSuffix: string;
}): Map<string, ManagedOutputMatch[]> | null {
  const matchesByIdentity = new Map<string, ManagedOutputMatch[]>();

  for (const context of options.contexts) {
    const match = resolveManagedOutputContextMatch(
      context,
      options.declarationFilePath,
      options.declarationSuffix,
    );

    if (match === 'ambiguous') {
      return null;
    }

    appendMatch(matchesByIdentity, match);
  }

  return matchesByIdentity;
}

function createProvider(options: {
  declarationFilePath: string;
  matchesByIdentity: ReadonlyMap<string, ManagedOutputMatch[]> | null;
  preferredCheckerName: string | undefined;
}): ManagedOutputDeclarationProvider | null {
  if (options.matchesByIdentity?.size !== 1) {
    return null;
  }

  const matches = [...options.matchesByIdentity.values()][0]!;
  const firstMatch = matches[0]!;

  return {
    checkerNames: sortCheckerNames(
      matches.map((match) => match.checkerName),
      options.preferredCheckerName,
    ),
    declarationFilePath: options.declarationFilePath,
    mappedSourceFilePath: firstMatch.mappedSourceFilePath,
    reason: 'owned-source',
    sourceConfigPath: firstMatch.sourceConfigPath,
  };
}

function resolveManagedOutputDeclaration(options: {
  contexts: readonly NormalizedManagedOutputProjectContext[];
  declarationFilePath: string;
  preferredCheckerName: string | undefined;
}): ManagedOutputDeclarationProvider | null {
  const normalizedDeclarationFilePath = normalizeAbsolutePath(
    options.declarationFilePath,
  );
  const declarationSuffix = getDeclarationSuffix(normalizedDeclarationFilePath);

  if (declarationSuffix === null) {
    return null;
  }

  const matchesByIdentity = collectContextMatches({
    contexts: options.contexts,
    declarationFilePath: normalizedDeclarationFilePath,
    declarationSuffix,
  });

  return createProvider({
    declarationFilePath: normalizedDeclarationFilePath,
    matchesByIdentity,
    preferredCheckerName: options.preferredCheckerName,
  });
}

export function createManagedOutputDeclarationLookup(
  contexts: readonly ManagedOutputProjectContext[],
): ManagedOutputDeclarationLookup {
  const normalizedContexts = contexts.map(normalizeManagedOutputContext);

  return {
    resolve(
      declarationFilePath: string,
      preferredCheckerName?: string,
    ): ManagedOutputDeclarationProvider | null {
      return resolveManagedOutputDeclaration({
        contexts: normalizedContexts,
        declarationFilePath,
        preferredCheckerName,
      });
    },
  };
}
