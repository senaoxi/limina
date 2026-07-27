import {
  findTargetProject,
  formatImportRecordLocation,
  shouldResolveThroughGraph,
} from '#core/import-graph/context';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import {
  addBuildArtifactImportProblem,
  shouldSkipWorkspaceExportResolvedOutsideGraph,
} from './artifact-import-findings';
import { createGraphImportFact, getProjectCheckerName } from './finding-utils';
import type { GraphTargetUnreachableFinding } from './findings';
import { getPreferredGeneratedTargetProjectPath } from './generated-project-paths';
import { addDeniedRefImportProblem } from './import-access-denied';
import type { ImportTargetOptions } from './import-target-types';
import { addUnmappedWorkspaceImportProblem } from './outside-graph-findings';
import { addExpectedReference } from './reference-expectations';
import { getDeniedRefRule } from './rules';

const GRAPH_CHECK_DEFAULT_REASON =
  'Graph check found architecture, dependency, resolver, or config violations.';

type ReferenceTargetOptions = ImportTargetOptions;

function resolveSourceTargetProjectPath(
  options: ReferenceTargetOptions,
): string | null {
  const targetProjectPath = findTargetProject({
    fileOwnerLookup: options.context.fileOwnerLookup,
    packages: options.context.packages,
    projectPaths: options.context.projectPaths,
    resolvedFilePath: options.resolution.graphResolvedFilePath,
    specifier: options.importRecord.specifier,
  });
  if (!targetProjectPath) {
    addUnmappedWorkspaceImportProblem(options);
    return null;
  }

  return getPreferredGeneratedTargetProjectPath({
    generatedGraph: options.context.generatedGraph,
    importingProjectPath: options.project.configPath,
    targetProjectPath,
  });
}

function resolveNonArtifactTargetProjectPath(
  options: ReferenceTargetOptions,
): string | null {
  if (addBuildArtifactImportProblem(options)) {
    return null;
  }

  return resolveSourceTargetProjectPath(options);
}

export function findExpectedReferenceTargetProjectPath(
  options: ReferenceTargetOptions,
): string | null {
  if (options.resolution.managedOutputTargetProjectPath) {
    return options.resolution.managedOutputTargetProjectPath;
  }

  if (shouldSkipWorkspaceExportResolvedOutsideGraph(options)) {
    return null;
  }

  return resolveNonArtifactTargetProjectPath(options);
}

interface ExpectedTargetOptions extends ReferenceTargetOptions {
  targetProjectPath: string;
}

function shouldIgnoreExpectedTarget(options: ExpectedTargetOptions): boolean {
  const consumesArtifact = Boolean(
    options.resolution.targetPackageForGraph &&
      !shouldResolveThroughGraph(
        options.resolution.importer,
        options.resolution.targetPackageForGraph,
      ),
  );

  return (
    options.targetProjectPath === options.project.configPath || consumesArtifact
  );
}

function addDeniedTargetIfNeeded(options: ExpectedTargetOptions): boolean {
  const deniedRule = getDeniedRefRule(
    options.context.graphRules,
    options.project.labels,
    options.targetProjectPath,
  );
  if (!deniedRule) {
    return false;
  }

  addDeniedRefImportProblem({
    config: options.context.config,
    findings: options.context.findings,
    importRecord: options.importRecord,
    project: options.project,
    projectCheckerNamesByPath: options.context.projectCheckerNamesByPath,
    rule: deniedRule,
    targetProjectPath: options.targetProjectPath,
  });
  return true;
}

function addUnreachableTargetFinding(options: ExpectedTargetOptions): void {
  const detailLines = [
    'Expected graph target is not reachable from any checker entry:',
    `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  expected graph project: ${toRelativePath(options.context.config.rootDir, options.targetProjectPath)}`,
  ];

  options.context.findings.push({
    checkerName: getProjectCheckerName(
      options.context.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphTargetUnreachable,
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
      { label: 'expected graph project', value: options.targetProjectPath },
    ],
    facts: {
      import: createGraphImportFact(options.importRecord),
      importingProjectPath: options.project.configPath,
      targetProjectPath: options.targetProjectPath,
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
        filePath: options.targetProjectPath,
        label: 'expected graph project',
      },
    ],
    presentation: {
      detailLines,
      reason: GRAPH_CHECK_DEFAULT_REASON,
      title: 'Expected graph target is not reachable from any checker entry',
    },
    task: 'graph:check',
  } satisfies GraphTargetUnreachableFinding);
}

function addReachableExpectedTarget(options: ExpectedTargetOptions): void {
  if (!options.context.projectsByPath.has(options.targetProjectPath)) {
    addUnreachableTargetFinding(options);
    return;
  }

  addExpectedReference({
    expectedReferencesByProjectPath:
      options.context.expectedReferencesByProjectPath,
    importRecord: options.importRecord,
    project: options.project,
    targetProjectPath: options.targetProjectPath,
  });
}

export function addExpectedReferenceForTarget(
  options: ExpectedTargetOptions,
): void {
  if (shouldIgnoreExpectedTarget(options)) {
    return;
  }

  if (addDeniedTargetIfNeeded(options)) {
    return;
  }

  addReachableExpectedTarget(options);
}
