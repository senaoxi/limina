import {
  formatImportRecordLocation,
  type ProjectInfo,
} from '#core/import-graph/context';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import {
  describeWorkspaceConsumptionFailure,
  getWorkspaceConsumptionFailure,
  type WorkspaceConsumption,
  type WorkspaceConsumptionFailure,
} from '../core/project-dependencies/workspace-consumption';
import { createGraphImportFact, getProjectCheckerName } from './finding-utils';
import type { GraphWorkspaceImportUnresolvedFinding } from './findings';
import { getResolvedPackageName } from './import-resolution-utils';
import type { ExpectedReferenceCollectionContext } from './reference-types';
import { getDeniedDepRuleForPackage, type GraphRuleDepDeny } from './rules';

const consumptionMessages = {
  unresolved: {
    title: 'Unresolved workspace import',
    reason: 'The consuming checker could not resolve this workspace import.',
  },
  'missing-type-entry': {
    title: 'Workspace source import uses package export without a type entry',
    reason:
      'Governed source imports through package exports must resolve to a stable type or checker source entry.',
  },
};

function getConsumedSubpath(failure: WorkspaceConsumptionFailure): string {
  const specifier = failure.consumption.importRecord.specifier;
  return specifier === failure.package.name
    ? '.'
    : `.${specifier.slice(failure.package.name.length)}`;
}

function formatResolvedTarget(rootDir: string, target: string | null): string {
  return target === null ? '(none)' : toRelativePath(rootDir, target);
}

export function addWorkspaceConsumptionProblem(options: {
  context: ExpectedReferenceCollectionContext;
  project: ProjectInfo;
  consumption: WorkspaceConsumption;
}): boolean {
  const failure = getWorkspaceConsumptionFailure({
    ...options,
    workspaceLookup: options.context.workspaceLookup,
  });
  if (failure === null) return false;
  const importRecord = options.consumption.importRecord;
  const { title, reason } = consumptionMessages[failure.kind];
  const subpath = getConsumedSubpath(failure);
  const detailLines = [
    `${title}:`,
    ...describeWorkspaceConsumptionFailure(failure),
    `  file: ${formatImportRecordLocation(options.context.config.rootDir, importRecord)}`,
    `  export: ${subpath}`,
    `  TypeScript resolved file: ${formatResolvedTarget(options.context.config.rootDir, failure.resolvedFilePath)}`,
    `  reason: ${reason}`,
  ];
  options.context.findings.push({
    checkerName: getProjectCheckerName(
      options.context.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved,
    evidence: [
      { label: 'import', value: importRecord.specifier, lines: detailLines },
    ],
    facts: {
      import: createGraphImportFact(importRecord),
      importingProjectPath: options.project.configPath,
      kind: failure.kind,
      ...(failure.resolvedFilePath === null
        ? {}
        : { resolvedFilePath: failure.resolvedFilePath }),
      targetPackageName: failure.package.name,
    },
    filePath: importRecord.filePath,
    locations: [
      {
        filePath: importRecord.filePath,
        label: 'import',
        line: importRecord.line,
      },
      { filePath: options.project.configPath, label: 'importing project' },
    ],
    packageName: failure.package.name,
    presentation: { detailLines, reason, title },
    task: 'graph:check',
  } satisfies GraphWorkspaceImportUnresolvedFinding);
  return true;
}

export function getDeniedDepRuleForResolvedPackage(options: {
  context: ExpectedReferenceCollectionContext;
  project: ProjectInfo;
  resolvedFilePath: string;
}): GraphRuleDepDeny | null {
  const packageName = getResolvedPackageName(
    options.resolvedFilePath,
    options.context.workspaceLookup,
  );
  if (!packageName) {
    return null;
  }

  return getDeniedDepRuleForPackage(
    options.context.graphRules,
    options.project.labels,
    packageName,
  );
}
