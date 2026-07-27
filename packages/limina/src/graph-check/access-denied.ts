import type { ResolvedLiminaConfig } from '#config/runner';
import {
  formatProjectLabels,
  type ProjectInfo,
} from '#core/import-graph/context';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import { getProjectCheckerName } from './finding-utils';
import type { GraphAccessDeniedFinding, GraphFinding } from './findings';
import {
  getDeniedDepRuleForPackage,
  getDeniedRefRule,
  type GraphRuleDepDeny,
  type GraphRuleRefDeny,
  type NormalizedGraphRules,
} from './rules';

interface DeniedReferenceContext {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  projectsByPath: Map<string, ProjectInfo>;
  rules: NormalizedGraphRules;
  workspaceLookup: WorkspaceLookupIndex;
}

function getDeniedDependencyRule(
  context: DeniedReferenceContext,
  referencePath: string,
): GraphRuleDepDeny | null {
  const packageName =
    context.workspaceLookup.findPackageForFile(referencePath)?.name;

  return packageName
    ? getDeniedDepRuleForPackage(
        context.rules,
        context.project.labels,
        packageName,
      )
    : null;
}

function createReferenceLocations(
  projectPath: string,
  referencePath: string,
): GraphAccessDeniedFinding['locations'] {
  return [
    { filePath: projectPath, label: 'referencing project' },
    { filePath: referencePath, label: 'referenced project' },
  ];
}

function addDeniedDependencyReference(
  context: DeniedReferenceContext,
  referencePath: string,
  rule: GraphRuleDepDeny,
): void {
  const projectPath = context.project.configPath;
  const detailLines = [
    'Denied graph access:',
    `  rules: ${formatProjectLabels(context.project.labels)}`,
    `  referencing project: ${toRelativePath(context.config.rootDir, projectPath)}`,
    `  referenced project: ${toRelativePath(context.config.rootDir, referencePath)}`,
    `  denied dependency: ${rule.name}`,
    `  reason: ${rule.reason}`,
  ];

  context.findings.push({
    checkerName: getProjectCheckerName(
      context.projectCheckerNamesByPath,
      projectPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
    evidence: [
      { label: 'referenced project', value: referencePath },
      { label: 'denied dependency', value: rule.name },
    ],
    facts: {
      kind: 'project-reference',
      labels: [...context.project.labels],
      referencedProjectPath: referencePath,
      referencingProjectPath: projectPath,
      ruleKind: 'dependency',
      ruleReason: rule.reason,
      ruleValue: rule.name,
    },
    filePath: projectPath,
    locations: createReferenceLocations(projectPath, referencePath),
    packageName: rule.name,
    presentation: {
      detailLines,
      reason: rule.reason,
      title: 'Denied graph access',
    },
    task: 'graph:check',
  } satisfies GraphAccessDeniedFinding);
}

function addDeniedProjectReference(
  context: DeniedReferenceContext,
  referencePath: string,
  rule: GraphRuleRefDeny,
): void {
  const projectPath = context.project.configPath;
  const detailLines = [
    'Denied graph access:',
    `  rules: ${formatProjectLabels(context.project.labels)}`,
    `  referencing project: ${toRelativePath(context.config.rootDir, projectPath)}`,
    `  referenced project: ${toRelativePath(context.config.rootDir, referencePath)}`,
    `  denied ref: ${toRelativePath(context.config.rootDir, rule.path)}`,
    `  reason: ${rule.reason}`,
  ];

  context.findings.push({
    checkerName: getProjectCheckerName(
      context.projectCheckerNamesByPath,
      projectPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
    evidence: [
      { label: 'referenced project', value: referencePath },
      { label: 'denied reference', value: rule.path },
    ],
    facts: {
      kind: 'project-reference',
      labels: [...context.project.labels],
      referencedProjectPath: referencePath,
      referencingProjectPath: projectPath,
      ruleKind: 'reference',
      ruleReason: rule.reason,
      ruleValue: rule.path,
    },
    filePath: projectPath,
    locations: createReferenceLocations(projectPath, referencePath),
    presentation: {
      detailLines,
      reason: rule.reason,
      title: 'Denied graph access',
    },
    task: 'graph:check',
  } satisfies GraphAccessDeniedFinding);
}

function addDeniedProjectReferenceIfNeeded(
  context: DeniedReferenceContext,
  referencePath: string,
): void {
  const rule = getDeniedRefRule(
    context.rules,
    context.project.labels,
    referencePath,
  );
  if (rule) {
    addDeniedProjectReference(context, referencePath, rule);
  }
}

function checkDeniedReference(
  context: DeniedReferenceContext,
  referencePath: string,
): void {
  context.checks.add();
  if (!context.projectsByPath.has(referencePath)) {
    return;
  }

  const dependencyRule = getDeniedDependencyRule(context, referencePath);
  if (dependencyRule) {
    addDeniedDependencyReference(context, referencePath, dependencyRule);
    return;
  }

  addDeniedProjectReferenceIfNeeded(context, referencePath);
}

export function addDeniedReferenceProblems(
  context: DeniedReferenceContext,
): void {
  if (context.project.labels.length === 0) {
    return;
  }

  for (const referencePath of context.project.references) {
    checkDeniedReference(context, referencePath);
  }
}
