import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { createSourceDiagnosticFinding } from './finding-utils';
import type { SourceFinding } from './findings';

function formatConfigPathList(
  config: ResolvedLiminaConfig,
  configPaths: string[],
): string[] {
  if (configPaths.length === 0) {
    return ['    (none)'];
  }

  return configPaths
    .sort((left, right) =>
      toRelativePath(config.rootDir, left).localeCompare(
        toRelativePath(config.rootDir, right),
      ),
    )
    .map((configPath) => `    - ${toRelativePath(config.rootDir, configPath)}`);
}

function createResolverConfigLines(options: {
  config: ResolvedLiminaConfig;
  tsconfigPath: string | null;
}): string[] {
  return options.tsconfigPath
    ? [
        `  resolver tsconfig: ${toRelativePath(options.config.rootDir, options.tsconfigPath)}`,
      ]
    : [];
}

export function addNearestTsconfigOwnershipProblem(options: {
  config: ResolvedLiminaConfig;
  fileName: string;
  findings: SourceFinding[];
  matchedOwnerConfigPaths: string[];
  reason: string;
  searchedTsconfigPaths: string[];
  status: 'missing' | 'multiple' | 'unmatched';
  tsconfigPath: string | null;
}): void {
  const title = 'Tsconfig search cannot determine module owner';
  const fix =
    'make one tsconfig.json between the module directory and its activated package-island root include the module, or make its ordinary typecheck references reach exactly one owner tsconfig.';
  const lines = [
    `${title}:`,
    `  file: ${toRelativePath(options.config.rootDir, options.fileName)}`,
    ...createResolverConfigLines(options),
    '  searched tsconfigs:',
    ...formatConfigPathList(options.config, options.searchedTsconfigPaths),
    '  matched owner tsconfigs:',
    ...formatConfigPathList(options.config, options.matchedOwnerConfigPaths),
    `  reason: ${options.reason}`,
    `  fix: ${fix}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
      facts: {
        candidateConfigPaths: options.searchedTsconfigPaths,
        filePath: options.fileName,
        kind: 'module-owner-unresolved',
        matchedConfigPaths: options.matchedOwnerConfigPaths,
        resolverConfigPath: options.tsconfigPath ?? undefined,
        status: options.status,
      },
      filePath: options.fileName,
      fix,
      lines,
      reason: options.reason,
      title,
    }),
  );
}
