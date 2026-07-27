import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isDtsProjectConfig,
  type ProjectInfo,
} from '#core/import-graph/context';
import { uniqueSortedStrings } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import { isDeepStrictEqual } from 'node:util';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type {
  CustomConditionConsistencyContext,
  CustomConditionSubtreeSummary,
} from './condition-types';
import type {
  GraphConditionDomainMismatchFinding,
  GraphFinding,
} from './findings';

export function normalizeCustomConditions(
  value: readonly string[] | undefined,
): string[] {
  return value === undefined ? [] : uniqueSortedStrings(value);
}

export function getProjectCustomConditions(project: ProjectInfo): string[] {
  return normalizeCustomConditions(project.options.customConditions);
}

export function formatCustomConditions(conditions: readonly string[]): string {
  return JSON.stringify(conditions);
}

export function customConditionsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return isDeepStrictEqual(left, right);
}

function createCycleSummary(
  project: ProjectInfo,
  conditions: string[],
): CustomConditionSubtreeSummary {
  return {
    consistentConditions: conditions,
    mismatchFindings: [],
    projectPaths: new Set([project.configPath]),
  };
}

function resolveExistingSummary(
  project: ProjectInfo,
  conditions: string[],
  context: CustomConditionConsistencyContext,
): CustomConditionSubtreeSummary | null {
  const cached = context.subtreeByProjectPath.get(project.configPath);

  if (cached !== undefined) {
    return cached;
  }

  return context.visitingProjectPaths.has(project.configPath)
    ? createCycleSummary(project, conditions)
    : null;
}

function getReferencedDeclarationProjects(
  project: ProjectInfo,
  context: CustomConditionConsistencyContext,
): ProjectInfo[] {
  return [...project.references]
    .sort()
    .map((referencePath) => context.projectsByPath.get(referencePath))
    .filter(
      (candidate): candidate is ProjectInfo =>
        candidate !== undefined && isDtsProjectConfig(candidate.configPath),
    );
}

function createReferenceMismatchFinding(options: {
  config: ResolvedLiminaConfig;
  context: CustomConditionConsistencyContext;
  project: ProjectInfo;
  projectConditions: string[];
  referencedConditions: string[];
  referencedProject: ProjectInfo;
}): GraphConditionDomainMismatchFinding | null {
  if (
    customConditionsEqual(
      options.projectConditions,
      options.referencedConditions,
    )
  ) {
    return null;
  }

  const reason =
    'every tsconfig*.dts.json project reachable from a declaration leaf must use the same effective compilerOptions.customConditions.';
  const lines = [
    'Custom conditions mismatch in declaration reference tree:',
    `  root project: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  referenced project: ${toRelativePath(options.config.rootDir, options.referencedProject.configPath)}`,
    `  expected customConditions: ${formatCustomConditions(options.projectConditions)}`,
    `  actual customConditions: ${formatCustomConditions(options.referencedConditions)}`,
    `  reason: ${reason}`,
  ];

  return {
    checkerName: options.context.projectCheckerNamesByPath.get(
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphConditionDomainMismatch,
    evidence: [
      {
        label: 'expected customConditions',
        value: formatCustomConditions(options.projectConditions),
      },
      {
        label: 'actual customConditions',
        value: formatCustomConditions(options.referencedConditions),
      },
    ],
    facts: {
      actualConditions: options.referencedConditions,
      expectedConditions: options.projectConditions,
      kind: 'reference-tree',
      referencedProjectPath: options.referencedProject.configPath,
      rootProjectPath: options.project.configPath,
    },
    filePath: options.project.configPath,
    locations: [
      { filePath: options.project.configPath, label: 'root project' },
      {
        filePath: options.referencedProject.configPath,
        label: 'referenced project',
      },
    ],
    presentation: {
      detailLines: lines,
      reason,
      title: 'Custom conditions mismatch in declaration reference tree',
    },
    task: 'graph:check',
  };
}

function mergeReferencedProject(options: {
  config: ResolvedLiminaConfig;
  context: CustomConditionConsistencyContext;
  mismatchFindings: GraphConditionDomainMismatchFinding[];
  project: ProjectInfo;
  projectConditions: string[];
  projectPaths: Set<string>;
  referencedProject: ProjectInfo;
}): void {
  const summary = collectCustomConditionSubtreeSummary(
    options.config,
    options.referencedProject,
    options.context,
  );

  for (const projectPath of summary.projectPaths) {
    options.projectPaths.add(projectPath);
  }

  options.mismatchFindings.push(...summary.mismatchFindings);
  const referencedConditions = getProjectCustomConditions(
    options.referencedProject,
  );
  options.context.conditionsByProjectPath.set(
    options.referencedProject.configPath,
    referencedConditions,
  );
  const finding = createReferenceMismatchFinding({
    config: options.config,
    context: options.context,
    project: options.project,
    projectConditions: options.projectConditions,
    referencedConditions,
    referencedProject: options.referencedProject,
  });

  if (finding !== null) {
    options.mismatchFindings.push(finding);
  }
}

function resolveConsistentConditions(
  conditions: string[],
  findings: readonly GraphConditionDomainMismatchFinding[],
): string[] | null {
  return findings.length === 0 ? conditions : null;
}

function getStoredProjectConditions(
  project: ProjectInfo,
  context: CustomConditionConsistencyContext,
): string[] {
  const stored = context.conditionsByProjectPath.get(project.configPath);
  return stored === undefined ? getProjectCustomConditions(project) : stored;
}

export function collectCustomConditionSubtreeSummary(
  config: ResolvedLiminaConfig,
  project: ProjectInfo,
  context: CustomConditionConsistencyContext,
): CustomConditionSubtreeSummary {
  const projectConditions = getStoredProjectConditions(project, context);
  const existing = resolveExistingSummary(project, projectConditions, context);

  if (existing !== null) {
    return existing;
  }

  context.conditionsByProjectPath.set(project.configPath, projectConditions);
  context.visitingProjectPaths.add(project.configPath);
  const mismatchFindings: GraphConditionDomainMismatchFinding[] = [];
  const projectPaths = new Set([project.configPath]);

  for (const referencedProject of getReferencedDeclarationProjects(
    project,
    context,
  )) {
    mergeReferencedProject({
      config,
      context,
      mismatchFindings,
      project,
      projectConditions,
      projectPaths,
      referencedProject,
    });
  }

  context.visitingProjectPaths.delete(project.configPath);
  const summary: CustomConditionSubtreeSummary = {
    consistentConditions: resolveConsistentConditions(
      projectConditions,
      mismatchFindings,
    ),
    mismatchFindings,
    projectPaths,
  };
  context.subtreeByProjectPath.set(project.configPath, summary);
  return summary;
}

export function createCustomConditionConsistencyContext(
  projectsByPath: Map<string, ProjectInfo>,
  projectCheckerNamesByPath: ReadonlyMap<string, string> = new Map(),
): CustomConditionConsistencyContext {
  return {
    conditionsByProjectPath: new Map(),
    projectCheckerNamesByPath,
    projectsByPath,
    subtreeByProjectPath: new Map(),
    visitingProjectPaths: new Set(),
  };
}

function getConditionMismatchIdentity(
  finding: GraphConditionDomainMismatchFinding,
): string {
  return finding.facts.kind === 'reference-tree'
    ? `${finding.code}\0reference-tree\0${finding.facts.rootProjectPath}\0${finding.facts.referencedProjectPath}`
    : `${finding.code}\0domain-entry\0${finding.facts.domainName}\0${finding.facts.entryProjectPath}`;
}

export function addUniqueConditionFindings(
  findings: GraphFinding[],
  seenFindingIdentities: Set<string>,
  nextFindings: readonly GraphConditionDomainMismatchFinding[],
): void {
  for (const finding of nextFindings) {
    const identity = getConditionMismatchIdentity(finding);

    if (!seenFindingIdentities.has(identity)) {
      seenFindingIdentities.add(identity);
      findings.push(finding);
    }
  }
}
