import { toRelativePath } from '#utils/path';
import type { CollectionContext } from './source-config-collection-types';

export function recordCrossCheckerReference(options: {
  context: CollectionContext;
  fromConfigPath: string;
  referencePath: string;
  targetChecker: CollectionContext['checkerName'];
}): void {
  options.context.collection.crossCheckerReferences.push({
    fromConfigPath: options.fromConfigPath,
    toChecker: options.targetChecker,
    toConfigPath: options.referencePath,
  });
}

function getExplicitReferenceOwner(options: {
  context: CollectionContext;
  referencePath: string;
}): CollectionContext['checkerName'] | undefined {
  const explicitOwners = options.context.explicitOwnerByConfigPath;
  if (explicitOwners === undefined) return undefined;
  return explicitOwners.get(options.referencePath);
}

function addInheritedOwnerConflict(options: {
  context: CollectionContext;
  fromConfigPath: string;
  inheritedOwner: CollectionContext['checkerName'];
  referencePath: string;
}): void {
  if (options.inheritedOwner === options.context.checkerName) return;
  options.context.problems.push(
    [
      'Ambiguous inherited checker ownership:',
      `  config: ${toRelativePath(options.context.config.rootDir, options.referencePath)}`,
      `  first checker: ${options.inheritedOwner}`,
      `  conflicting checker: ${options.context.checkerName}`,
      `  referenced from: ${toRelativePath(options.context.config.rootDir, options.fromConfigPath)}`,
      '  fix: assign this config directly to one build checker with config.checkers.<checker>.include.',
    ].join('\n'),
  );
}

function inheritReferenceOwner(
  options: {
    context: CollectionContext;
    fromConfigPath: string;
    referencePath: string;
  },
  inheritedOwners: Map<string, CollectionContext['checkerName']>,
): CollectionContext['checkerName'] {
  const inheritedOwner = inheritedOwners.get(options.referencePath);
  if (inheritedOwner === undefined) {
    inheritedOwners.set(options.referencePath, options.context.checkerName);
    return options.context.checkerName;
  }
  addInheritedOwnerConflict({ ...options, inheritedOwner });
  return inheritedOwner;
}

export function resolveReferenceOwner(options: {
  context: CollectionContext;
  fromConfigPath: string;
  referencePath: string;
}): CollectionContext['checkerName'] {
  const explicitOwner = getExplicitReferenceOwner(options);
  if (explicitOwner !== undefined) return explicitOwner;
  const inheritedOwners = options.context.inheritedOwnerByConfigPath;
  if (inheritedOwners === undefined) return options.context.checkerName;
  return inheritReferenceOwner(options, inheritedOwners);
}
