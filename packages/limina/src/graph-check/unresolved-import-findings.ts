import {
  formatImportRecordLocation,
  type ImportRecord,
  type ProjectInfo,
} from '#core/import-graph/context';
import { formatReferences } from '#core/tsconfig/actions';
import type { WorkspacePackage } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { createGraphImportFact, getProjectCheckerName } from './finding-utils';
import type { GraphWorkspaceImportUnresolvedFinding } from './findings';
import type { ExpectedReferenceCollectionContext } from './reference-types';

const GRAPH_CHECK_DEFAULT_REASON =
  'Graph check found architecture, dependency, resolver, or config violations.';

function getPackageName(packageInfo: WorkspacePackage | null): string | null {
  if (!packageInfo) {
    return null;
  }

  return packageInfo.name ?? null;
}

export function addUnresolvedWorkspaceImportProblem(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  project: ProjectInfo;
  targetPackage: WorkspacePackage | null;
}): void {
  const packageName = getPackageName(options.targetPackage);
  if (!packageName) {
    return;
  }

  const detailLines = [
    'Unresolved workspace import:',
    `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  matched workspace package: ${packageName}`,
    `  current references: ${formatReferences(options.context.config.rootDir, options.project.references)}`,
  ];

  options.context.findings.push({
    checkerName: getProjectCheckerName(
      options.context.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved,
    evidence: [
      {
        label: 'import',
        lines: [
          `file: ${options.importRecord.filePath}`,
          `line: ${options.importRecord.line}`,
          `kind: ${options.importRecord.kind}`,
        ],
        value: options.importRecord.specifier,
      },
    ],
    facts: {
      import: createGraphImportFact(options.importRecord),
      importingProjectPath: options.project.configPath,
      kind: 'unresolved',
      targetPackageName: packageName,
    },
    filePath: options.importRecord.filePath,
    locations: [
      {
        filePath: options.importRecord.filePath,
        label: 'import',
        line: options.importRecord.line,
      },
      { filePath: options.project.configPath, label: 'importing project' },
    ],
    packageName,
    presentation: {
      detailLines,
      reason: GRAPH_CHECK_DEFAULT_REASON,
      title: 'Unresolved workspace import',
    },
    task: 'graph:check',
  } satisfies GraphWorkspaceImportUnresolvedFinding);
}

function getSpecifierPackageName(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
}): string | null {
  const packageInfo = options.context.workspaceLookup.findPackageForSpecifier(
    options.importRecord.specifier,
  );

  return getPackageName(packageInfo);
}

export function addOxcOnlyDeclarationProviderProblem(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  oxcResolvedFilePath: string;
  project: ProjectInfo;
}): void {
  const packageName = getSpecifierPackageName(options);
  if (!packageName) {
    return;
  }

  const detailLines = [
    'Oxc can resolve this specifier, but TypeScript cannot:',
    `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  Oxc resolved file: ${toRelativePath(options.context.config.rootDir, options.oxcResolvedFilePath)}`,
    '  reason: declaration references follow the checker-aware TypeScript declaration provider, not the Oxc runtime-like resolver.',
    '  fix: check moduleResolution, exports.types/types conditions, paths, customConditions, and package boundaries.',
  ];

  options.context.findings.push({
    checkerName: getProjectCheckerName(
      options.context.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved,
    evidence: [
      {
        label: 'import',
        lines: [
          `file: ${options.importRecord.filePath}`,
          `line: ${options.importRecord.line}`,
          `kind: ${options.importRecord.kind}`,
        ],
        value: options.importRecord.specifier,
      },
      { label: 'Oxc resolved file', value: options.oxcResolvedFilePath },
    ],
    facts: {
      import: createGraphImportFact(options.importRecord),
      importingProjectPath: options.project.configPath,
      kind: 'oxc-only',
      resolvedFilePath: options.oxcResolvedFilePath,
      targetPackageName: packageName,
    },
    filePath: options.importRecord.filePath,
    locations: [
      {
        filePath: options.importRecord.filePath,
        label: 'import',
        line: options.importRecord.line,
      },
      { filePath: options.project.configPath, label: 'importing project' },
      {
        filePath: options.oxcResolvedFilePath,
        label: 'Oxc resolved file',
      },
    ],
    packageName,
    presentation: {
      detailLines,
      fix: 'Check moduleResolution, exports.types/types conditions, paths, customConditions, and package boundaries.',
      reason:
        'Oxc resolved this specifier, but TypeScript could not resolve a declaration provider.',
      title: 'Oxc can resolve this specifier, but TypeScript cannot',
    },
    task: 'graph:check',
  } satisfies GraphWorkspaceImportUnresolvedFinding);
}
