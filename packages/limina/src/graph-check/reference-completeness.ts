import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  isDtsProjectConfig,
  type ProjectInfo,
} from '#core/import-graph/context';
import { formatReferences } from '#core/tsconfig/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import { getProjectCheckerName } from './finding-utils';
import type { GraphFinding, GraphReferenceExtraFinding } from './findings';
import {
  getGeneratedCheckerNamespace,
  isSameGeneratedCheckerNamespace,
} from './generated-project-paths';
import { addMissingReferencesForProject } from './missing-reference-findings';
import type {
  ExpectedReferencesByProjectPath,
  ReferenceExpectation,
} from './reference-types';
import { getAllowedRefRule, type NormalizedGraphRules } from './rules';

function isGeneratedCheckerRoot(configPath: string): boolean {
  const checkerName = getGeneratedCheckerNamespace(configPath);
  if (!checkerName) {
    return false;
  }

  const suffix = `/.limina/tsconfig/checkers/${checkerName}/projects/tsconfig.dts.json`;
  return configPath.endsWith(suffix);
}

function hasAllowedReference(options: {
  graphRules: NormalizedGraphRules;
  project: ProjectInfo;
  referencePath: string;
}): boolean {
  return Boolean(
    getAllowedRefRule(
      options.graphRules,
      options.project.labels,
      options.referencePath,
    ),
  );
}

function sharesGeneratedCheckerNamespace(options: {
  project: ProjectInfo;
  referencePath: string;
}): boolean {
  if (!getGeneratedCheckerNamespace(options.project.configPath)) {
    return false;
  }

  return isSameGeneratedCheckerNamespace(
    options.project.configPath,
    options.referencePath,
  );
}

function shouldSkipExtraReference(options: {
  expectedReferences: Map<string, ReferenceExpectation>;
  graphRules: NormalizedGraphRules;
  project: ProjectInfo;
  projectsByPath: Map<string, ProjectInfo>;
  referencePath: string;
}): boolean {
  const predicates = [
    isGeneratedCheckerRoot(options.project.configPath),
    options.expectedReferences.has(options.referencePath),
    !options.projectsByPath.has(options.referencePath),
    sharesGeneratedCheckerNamespace(options),
    hasAllowedReference(options),
  ];

  return predicates.includes(true);
}

function createExtraReferenceFinding(options: {
  config: ResolvedLiminaConfig;
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  referencePath: string;
}): GraphReferenceExtraFinding {
  const detailLines = [
    'Extra project reference not proven by static imports:',
    `  project: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  extra reference: ${toRelativePath(options.config.rootDir, options.referencePath)}`,
    `  current references: ${formatReferences(options.config.rootDir, options.project.references)}`,
    '  reason: tsconfig*.dts.json references must match declaration leaves reached by static import/export analysis.',
    '  fix: remove the extra reference, import from the referenced project, or document the exception in graph.rules.<label>.allow.refs.',
  ];

  return {
    checkerName: getProjectCheckerName(
      options.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphReferenceExtra,
    evidence: [{ label: 'extra reference', value: options.referencePath }],
    facts: {
      extraReferencePath: options.referencePath,
      projectPath: options.project.configPath,
    },
    filePath: options.project.configPath,
    locations: [
      { filePath: options.project.configPath, label: 'project' },
      { filePath: options.referencePath, label: 'extra reference' },
    ],
    presentation: {
      detailLines,
      fix: 'Remove the extra reference, import from the referenced project, or document the exception in graph.rules.<label>.allow.refs.',
      reason:
        'tsconfig*.dts.json references must match declaration leaves reached by static import/export analysis.',
      title: 'Extra project reference not proven by static imports',
    },
    task: 'graph:check',
  };
}

function addExtraReferencesForProject(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  expectedReferences: Map<string, ReferenceExpectation>;
  findings: GraphFinding[];
  graphRules: NormalizedGraphRules;
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  projectsByPath: Map<string, ProjectInfo>;
}): void {
  for (const referencePath of [...options.project.references].sort()) {
    options.checks.add();
    if (shouldSkipExtraReference({ ...options, referencePath })) {
      continue;
    }

    options.findings.push(
      createExtraReferenceFinding({ ...options, referencePath }),
    );
  }
}

function getDtsProjects(projects: ProjectInfo[]): ProjectInfo[] {
  return projects.filter((project) => isDtsProjectConfig(project.configPath));
}

function getDtsProjectsWithFiles(projects: ProjectInfo[]): ProjectInfo[] {
  return getDtsProjects(projects).filter(
    (project) => project.fileNames.length > 0,
  );
}

function getExpectedReferences(
  referencesByProject: ExpectedReferencesByProjectPath,
  projectPath: string,
): Map<string, ReferenceExpectation> {
  return referencesByProject.get(projectPath) ?? new Map();
}

function addMissingReferenceProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  expectedReferencesByProjectPath: ExpectedReferencesByProjectPath;
  findings: GraphFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  projects: ProjectInfo[];
}): void {
  for (const project of getDtsProjects(options.projects)) {
    addMissingReferencesForProject({
      checks: options.checks,
      config: options.config,
      expectedReferences: getExpectedReferences(
        options.expectedReferencesByProjectPath,
        project.configPath,
      ),
      findings: options.findings,
      generatedGraph: options.generatedGraph,
      project,
      projectCheckerNamesByPath: options.projectCheckerNamesByPath,
    });
  }
}

function addExtraReferenceProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  expectedReferencesByProjectPath: ExpectedReferencesByProjectPath;
  findings: GraphFinding[];
  graphRules: NormalizedGraphRules;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  projects: ProjectInfo[];
  projectsByPath: Map<string, ProjectInfo>;
}): void {
  for (const project of getDtsProjectsWithFiles(options.projects)) {
    addExtraReferencesForProject({
      checks: options.checks,
      config: options.config,
      expectedReferences: getExpectedReferences(
        options.expectedReferencesByProjectPath,
        project.configPath,
      ),
      findings: options.findings,
      graphRules: options.graphRules,
      project,
      projectCheckerNamesByPath: options.projectCheckerNamesByPath,
      projectsByPath: options.projectsByPath,
    });
  }
}

export function addReferenceCompletenessProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  expectedReferencesByProjectPath: ExpectedReferencesByProjectPath;
  findings: GraphFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  graphRules: NormalizedGraphRules;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  projects: ProjectInfo[];
  projectsByPath: Map<string, ProjectInfo>;
}): void {
  addMissingReferenceProblems(options);
  addExtraReferenceProblems(options);
}
