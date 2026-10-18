import type { DeclarationClosure } from '../typescript-semantic/declaration-closure';
import { createImportRecordIdentity } from '../typescript-semantic/import-record';
import type {
  ProjectDependencyCollection,
  ProjectDependencyRequest,
} from './contracts';
import { createProjectDependencyFailure } from './failure';

export function addDeclarationProjection(
  collection: ProjectDependencyCollection,
  request: ProjectDependencyRequest,
  closure: DeclarationClosure | undefined,
): void {
  if (closure === undefined) return;
  mergeProjection(collection, closure);
  for (const failure of closure.incomplete)
    collection.failures.push(
      createProjectDependencyFailure({
        request,
        importRecord: failure.occurrence,
        reason: `Declaration closure is incomplete (${failure.reason}): ${failure.fileName}`,
        stage: 'module-resolution',
        identity: JSON.stringify(failure),
      }),
    );
}
function mergeProjection(
  collection: ProjectDependencyCollection,
  closure: DeclarationClosure,
): void {
  const previous = collection.declarationClosure;
  if (previous === undefined)
    collection.declarationClosure = structuredClone(closure);
  else {
    const offset = previous.entries.length;
    previous.entryStates.push(...structuredClone(closure.entryStates));
    previous.entries.push(...structuredClone(closure.entries));
    previous.links.push(
      ...closure.links.map((link) => ({
        ...structuredClone(link),
        entry: link.entry + offset,
      })),
    );
    previous.records.push(...structuredClone(closure.records));
    previous.requirements.push(...structuredClone(closure.requirements));
    previous.incomplete.push(...structuredClone(closure.incomplete));
  }
}

export function collectionReferenceInputs(
  collection: ProjectDependencyCollection,
): void {
  const eligible = new Set(
    collection.declarationClosure?.requirements.map((input) =>
      createImportRecordIdentity(input.occurrence),
    ),
  );
  const candidates = collection.dependencies.filter(
    (dependency) => dependency.referenceRequirement !== null,
  );
  collection.referenceInputs =
    collection.declarationClosure === undefined
      ? candidates
      : candidates.filter((dependency) =>
          eligible.has(createImportRecordIdentity(dependency.importRecord)),
        );
}

export function effectiveReferenceInputs(
  collection: ProjectDependencyCollection,
): ProjectDependencyCollection['dependencies'] {
  return (
    collection.referenceInputs ??
    collection.dependencies.filter(
      (dependency) => dependency.referenceRequirement !== null,
    )
  );
}
