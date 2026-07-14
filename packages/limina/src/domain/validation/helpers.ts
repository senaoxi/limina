import type {
  GovernanceIssueEvidence,
  GovernanceIssueLocation,
} from './issues';
import type {
  SourceDependencyValidationEdge,
  ValidationEvidence,
  ValidationFile,
  ValidationLocation,
  ValidationProject,
} from './views';

export function locationFromFile(
  file: ValidationFile,
): GovernanceIssueLocation {
  return Object.freeze({ fileId: file.id, path: file.path });
}

export function locationFromProject(
  project: ValidationProject,
): GovernanceIssueLocation {
  return Object.freeze({ path: project.configPath, projectId: project.id });
}

export function locationFromValidationLocation(
  location: ValidationLocation,
  file: ValidationFile,
): GovernanceIssueLocation {
  return Object.freeze({
    column: location.column,
    fileId: file.id,
    line: location.line,
    path: file.path,
  });
}

export function evidenceFromValidationEvidence(
  evidence: ValidationEvidence,
  location?: GovernanceIssueLocation,
): GovernanceIssueEvidence {
  return Object.freeze({
    kind: evidence.kind,
    location,
    value: evidence.value,
  });
}

export function evidenceFromSourceDependencyEdge(
  edge: SourceDependencyValidationEdge,
): GovernanceIssueEvidence {
  return Object.freeze({
    kind: edge.kind,
    value: `${edge.fromProjectId} -> ${edge.target.kind}`,
  });
}
