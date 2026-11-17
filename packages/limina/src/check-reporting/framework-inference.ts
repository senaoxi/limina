import type { FrameworkInferenceAmbiguity } from '../core/build-graph/core-collection-run';
import type { LiminaPreflightManager } from '../preflight/manager';
import { formatCheckIssueInventoryCard } from './human';
import { LIMINA_CHECK_ISSUE_CODES } from './issue-code-values';
import type { CanonicalLiminaCheckIssue, LiminaCheckIssue } from './snapshot';
import { createLiminaCheckIssue } from './structured';

export function createFrameworkInferenceIssue(options: {
  rootDir: string;
  ambiguity: FrameworkInferenceAmbiguity;
}): CanonicalLiminaCheckIssue {
  const { ambiguity } = options;
  return createLiminaCheckIssue({
    rootDir: options.rootDir,
    code: LIMINA_CHECK_ISSUE_CODES.graphFrameworkInferenceAmbiguous,
    task: 'graph:prepare',
    severity: 'warning',
    filePath: ambiguity.sourceConfigPath,
    title: 'Ambiguous framework checker inference',
    summary:
      'Multiple framework checkers were inferred; TypeScript semantic authority was retained.',
    reason:
      'The local owner remains pending for Build Checker Coloring. A valid declaration relationship may select its build checker; otherwise the existing Auto fallback applies.',
    detailLines: [
      `Inferred framework checkers: ${ambiguity.checkers.join(', ')}`,
      'Selected semantic authority: TypeScript',
      'Local owner before Build Checker Coloring: Pending',
    ],
    fix: 'Optionally select a checker with scope.checkers.<checker>.include, or remove the configuration/source features that trigger unwanted inference.',
  });
}

export function collectFrameworkInferenceIssues(
  preflight: LiminaPreflightManager,
): CanonicalLiminaCheckIssue[] {
  return preflight.getFrameworkInferenceAmbiguities().map((ambiguity) =>
    createFrameworkInferenceIssue({
      rootDir: preflight.config.rootDir,
      ambiguity,
    }),
  );
}

export function isFrameworkInferenceWarning(issue: LiminaCheckIssue): boolean {
  return (
    issue.code === LIMINA_CHECK_ISSUE_CODES.graphFrameworkInferenceAmbiguous
  );
}

export function formatFrameworkInferenceWarnings(
  issues: readonly LiminaCheckIssue[],
  shouldUseColor: boolean,
): string {
  return issues
    .filter(isFrameworkInferenceWarning)
    .map((issue) =>
      formatCheckIssueInventoryCard({
        color: shouldUseColor,
        issue,
        representativeLocation: issue.filePath,
        view: 'detailed',
      }),
    )
    .join('\n');
}
