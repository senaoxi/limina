import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import type {
  ExpectedReferencesByProjectPath,
  ReferenceExpectation,
} from './reference-types';

export function getExpectedReferencesForProject(
  expectedReferencesByProjectPath: ExpectedReferencesByProjectPath,
  project: ProjectInfo,
): Map<string, ReferenceExpectation> {
  const expectedReferences =
    expectedReferencesByProjectPath.get(project.configPath) ?? new Map();

  expectedReferencesByProjectPath.set(project.configPath, expectedReferences);
  return expectedReferences;
}

export function addExpectedReference(options: {
  expectedReferencesByProjectPath: ExpectedReferencesByProjectPath;
  importRecord: ImportRecord;
  project: ProjectInfo;
  targetProjectPath: string;
}): void {
  const expectedReferences = getExpectedReferencesForProject(
    options.expectedReferencesByProjectPath,
    options.project,
  );
  const expectation = expectedReferences.get(options.targetProjectPath) ?? {
    importRecords: [],
    targetProjectPath: options.targetProjectPath,
  };

  expectation.importRecords.push(options.importRecord);
  expectedReferences.set(options.targetProjectPath, expectation);
}
