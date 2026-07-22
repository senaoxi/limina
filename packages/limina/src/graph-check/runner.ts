import type { ResolvedLiminaConfig } from '#config/runner';
import type { AnalysisProviderSet } from '#core';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { ImportAnalysisContext } from '#core/import-analysis/runner';
import {
  collectImportsFromFile,
  createFileOwnerLookup,
  findTargetProject,
  formatArtifactDependencyPolicy,
  formatImportRecordLocation,
  formatProjectLabels,
  type ImportRecord,
  inferPackageProject,
  isDtsProjectConfig,
  type ProjectInfo,
  shouldResolveThroughGraph,
} from '#core/import-graph/context';
import { formatReferences } from '#core/tsconfig/actions';
import {
  type ImporterInfo,
  isNamedWorkspacePackage,
  type WorkspacePackage,
} from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import { collectStronglyConnectedComponents } from '#utils/strongly-connected-components';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import {
  type CheckIssueReportOptions,
  formatCheckIssueHumanReport,
} from '../check-reporting/human';
import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import type { LiminaCheckIssue } from '../check-reporting/snapshot';
import {
  type CheckCounter,
  createCheckCounter,
  createCheckItemAccumulator,
} from '../check-reporting/stats';
import { readOutputOptions } from '../core/build-graph/generated/config-readers';
import {
  isDeclarationFileFamily,
  resolveDeclarationProvider,
} from '../core/import-graph/declaration-provider';
import { shouldInferDeclarationReferenceFromImportRecord } from '../core/import-graph/declaration-reference-evidence';
import {
  createManagedOutputDeclarationLookup,
  type ManagedOutputDeclarationLookup,
  type ManagedOutputDeclarationProvider,
  type ManagedOutputProjectContext,
} from '../core/import-graph/managed-output-provider';
import {
  createWorkspaceExportsResolutionIndex,
  type WorkspaceExportsResolutionIndex,
  type WorkspaceExportsResolutionProfile,
  type WorkspacePackageExportResolution,
} from '../core/workspace/exports';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import {
  collectDependencyGraph,
  type DependencyGraphDocument,
  type DependencyGraphView,
  stringifyDependencyGraph,
} from '../dependency-graph/runner';
import type { TaskProgressReporter } from '../execution/progress';
import type { LiminaFlowReporter } from '../flow';
import { GraphLogger } from '../logger';
import { type LiminaPreflightManager, resolvePreflight } from '../preflight';
import {
  addConditionDomainProblems,
  addDefaultCustomConditionProblems,
  createCustomConditionConsistencyContext,
} from './conditions';
import {
  addDtsOptionProblems,
  addTypecheckParityProblems,
} from './dts-options';
import {
  createGraphCheckIssuesFromFindings,
  type GraphAccessDeniedFinding,
  type GraphConfigInvalidFinding,
  type GraphFinding,
  type GraphImportFact,
  type GraphImportTargetUnmappedFinding,
  type GraphReferenceCycleFinding,
  type GraphReferenceExtraFinding,
  type GraphReferenceMissingFinding,
  type GraphTargetUnreachableFinding,
  type GraphWorkspaceDependencyUndeclaredFinding,
  type GraphWorkspaceImportOutsideGraphFinding,
  type GraphWorkspaceImportUnresolvedFinding,
  type GraphWorkspacePackageNameMissingFinding,
} from './findings';
import {
  getAllowedRefRule,
  getDeniedDepRuleForPackage,
  getDeniedDepRuleForSpecifier,
  getDeniedRefRule,
  type GraphRuleDepDeny,
  type GraphRuleRefDeny,
  type NormalizedGraphRules,
  normalizeGraphRules,
} from './rules';

function filterProjectInfoToActivatedRegion(
  project: ProjectInfo,
  workspaceLookup: WorkspaceLookupIndex,
): ProjectInfo {
  return {
    ...project,
    fileNames: project.fileNames.filter((fileName) =>
      workspaceLookup.isInsideActivatedRegion(fileName),
    ),
    ownedFileNames: project.ownedFileNames.filter((fileName) =>
      workspaceLookup.isInsideActivatedRegion(fileName),
    ),
  };
}

export interface RunGraphCheckOptions {
  clearScreen?: boolean;
  providers?: AnalysisProviderSet;
  deferSnapshot?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  issues?: LiminaCheckIssue[];
  onStats?: (stats: LiminaCheckRunTaskStats) => void;
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
}

export interface RunGraphPrepareOptions {
  clearScreen?: boolean;
  providers?: AnalysisProviderSet;
  deferSnapshot?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
  issues?: LiminaCheckIssue[];
  preflight?: LiminaPreflightManager;
  progress?: TaskProgressReporter;
  report?: CheckIssueReportOptions;
}

export interface RunGraphExportOptions {
  preflight?: LiminaPreflightManager;
  providers?: AnalysisProviderSet;
  outputPath?: string;
  view?: DependencyGraphView;
}

const GRAPH_CHECK_ITEM_NAMES = [
  'source graph routes',
  'project references',
  'condition domains',
  'reference completeness',
] as const;

const GRAPH_CHECK_DEFAULT_REASON =
  'Graph check found architecture, dependency, resolver, or config violations.';
const GENERATED_REFERENCE_CYCLE_REASON =
  'Generated declaration project references must be acyclic so build-mode checkers can order declaration builds.';
const GENERATED_REFERENCE_CYCLE_FIX =
  'Break the cycle by merging tightly coupled source scopes, extracting shared contracts, moving runtime wiring to a higher-level entry, or using an intentional declaration boundary.';

function getGeneratedCheckerNamespace(configPath: string): string | null {
  const marker = '/.limina/tsconfig/checkers/';
  const markerIndex = configPath.indexOf(marker);

  if (markerIndex === -1) {
    return null;
  }

  const rest = configPath.slice(markerIndex + marker.length);
  const separatorIndex = rest.indexOf('/');

  return separatorIndex === -1 ? null : rest.slice(0, separatorIndex);
}

function isSameGeneratedCheckerNamespace(
  leftConfigPath: string,
  rightConfigPath: string,
): boolean {
  const leftChecker = getGeneratedCheckerNamespace(leftConfigPath);
  const rightChecker = getGeneratedCheckerNamespace(rightConfigPath);

  return !leftChecker || !rightChecker || leftChecker === rightChecker;
}

interface ReferenceExpectation {
  importRecords: ImportRecord[];
  targetProjectPath: string;
}

type ExpectedReferencesByProjectPath = Map<
  string,
  Map<string, ReferenceExpectation>
>;

interface ExpectedReferenceCollectionOptions {
  config: ResolvedLiminaConfig;
  fileOwnerLookup: Map<string, string[]>;
  generatedGraph: GeneratedTsconfigGraphResult;
  graphRules: NormalizedGraphRules;
  importAnalysis: ImportAnalysisContext;
  managedOutputLookup: ManagedOutputDeclarationLookup;
  packages: WorkspacePackage[];
  projectCheckerNamesByPath: Map<string, string>;
  findings: GraphFinding[];
  projectPaths: string[];
  projects: ProjectInfo[];
  projectsByPath: Map<string, ProjectInfo>;
  selectedProjectPaths?: Set<string>;
  workspaceExports: WorkspaceExportsResolutionIndex;
  workspaceLookup: WorkspaceLookupIndex;
}

interface ExpectedReferenceCollectionContext
  extends ExpectedReferenceCollectionOptions {
  expectedReferencesByProjectPath: ExpectedReferencesByProjectPath;
}

interface GraphImportResolution {
  graphResolvedFilePath: string;
  importer: ImporterInfo | null;
  managedOutputAttribution: ManagedOutputDeclarationProvider | null;
  managedOutputTargetProjectPath: string | null;
  resolvedFilePath: string;
  targetPackage: WorkspacePackage | null;
  targetPackageForGraph: WorkspacePackage | null;
  targetWorkspacePackageForResolved: WorkspacePackage | null;
  workspaceExportResolution: WorkspacePackageExportResolution | null;
}

interface GeneratedReferenceCycleEdge {
  from: string;
  to: string;
}

function createGraphImportFact(importRecord: ImportRecord): GraphImportFact {
  return {
    filePath: importRecord.filePath,
    kind: importRecord.kind,
    line: importRecord.line,
    specifier: importRecord.specifier,
  };
}

function getProjectCheckerName(
  projectCheckerNamesByPath: ReadonlyMap<string, string>,
  projectPath: string,
): string | undefined {
  return projectCheckerNamesByPath.get(projectPath);
}

function addDeniedReferenceProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  projectsByPath: Map<string, ProjectInfo>;
  rules: NormalizedGraphRules;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  if (options.project.labels.length === 0) {
    return;
  }

  for (const referencePath of options.project.references) {
    options.checks.add();

    if (!options.projectsByPath.has(referencePath)) {
      continue;
    }

    const deniedRefRule = getDeniedRefRule(
      options.rules,
      options.project.labels,
      referencePath,
    );
    const targetPackage =
      options.workspaceLookup.findPackageForFile(referencePath);
    const deniedDepRule = targetPackage?.name
      ? getDeniedDepRuleForPackage(
          options.rules,
          options.project.labels,
          targetPackage.name,
        )
      : null;

    if (!deniedRefRule && !deniedDepRule) {
      continue;
    }

    const lines = [
      'Denied graph access:',
      `  rules: ${formatProjectLabels(options.project.labels)}`,
      `  referencing project: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
      `  referenced project: ${toRelativePath(options.config.rootDir, referencePath)}`,
    ];

    if (deniedDepRule) {
      lines.push(
        `  denied dependency: ${deniedDepRule.name}`,
        `  reason: ${deniedDepRule.reason}`,
      );
    } else if (deniedRefRule) {
      lines.push(
        `  denied ref: ${toRelativePath(options.config.rootDir, deniedRefRule.path)}`,
        `  reason: ${deniedRefRule.reason}`,
      );
    }

    options.findings.push({
      checkerName: getProjectCheckerName(
        options.projectCheckerNamesByPath,
        options.project.configPath,
      ),
      code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
      evidence: [
        {
          label: 'referenced project',
          value: referencePath,
        },
        {
          label: deniedDepRule ? 'denied dependency' : 'denied reference',
          value: deniedDepRule?.name ?? deniedRefRule?.path,
        },
      ],
      facts: {
        kind: 'project-reference',
        labels: [...options.project.labels],
        referencedProjectPath: referencePath,
        referencingProjectPath: options.project.configPath,
        ruleKind: deniedDepRule ? 'dependency' : 'reference',
        ruleReason: deniedDepRule?.reason ?? deniedRefRule!.reason,
        ruleValue: deniedDepRule?.name ?? deniedRefRule!.path,
      },
      filePath: options.project.configPath,
      locations: [
        {
          filePath: options.project.configPath,
          label: 'referencing project',
        },
        {
          filePath: referencePath,
          label: 'referenced project',
        },
      ],
      packageName: deniedDepRule?.name,
      presentation: {
        detailLines: lines,
        reason: deniedDepRule?.reason ?? deniedRefRule!.reason,
        title: 'Denied graph access',
      },
      task: 'graph:check',
    } satisfies GraphAccessDeniedFinding);
  }
}

function addDeniedDepImportProblem(options: {
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  importRecord: ImportRecord;
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  rule: GraphRuleDepDeny;
}): void {
  const lines = [
    'Denied graph access:',
    `  rules: ${formatProjectLabels(options.project.labels)}`,
    `  importing project: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  denied dependency: ${options.rule.name}`,
    `  reason: ${options.rule.reason}`,
  ];

  options.findings.push({
    checkerName: getProjectCheckerName(
      options.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
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
      {
        label: 'denied dependency',
        value: options.rule.name,
      },
    ],
    facts: {
      deniedDependency: options.rule.name,
      import: createGraphImportFact(options.importRecord),
      importingProjectPath: options.project.configPath,
      kind: 'import-dependency',
      labels: [...options.project.labels],
      ruleReason: options.rule.reason,
    },
    filePath: options.importRecord.filePath,
    locations: [
      {
        filePath: options.importRecord.filePath,
        label: 'import',
        line: options.importRecord.line,
      },
      {
        filePath: options.project.configPath,
        label: 'importing project',
      },
    ],
    packageName: options.rule.name,
    presentation: {
      detailLines: lines,
      reason: options.rule.reason,
      title: 'Denied graph access',
    },
    task: 'graph:check',
  } satisfies GraphAccessDeniedFinding);
}

function addDeniedRefImportProblem(options: {
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  importRecord: ImportRecord;
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  rule: GraphRuleRefDeny;
  targetProjectPath: string;
}): void {
  const lines = [
    'Denied graph access:',
    `  rules: ${formatProjectLabels(options.project.labels)}`,
    `  importing project: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  target project: ${toRelativePath(options.config.rootDir, options.targetProjectPath)}`,
    `  denied ref: ${toRelativePath(options.config.rootDir, options.rule.path)}`,
    `  reason: ${options.rule.reason}`,
  ];

  options.findings.push({
    checkerName: getProjectCheckerName(
      options.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
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
      {
        label: 'denied reference',
        value: options.rule.path,
      },
    ],
    facts: {
      deniedReferencePath: options.rule.path,
      import: createGraphImportFact(options.importRecord),
      importingProjectPath: options.project.configPath,
      kind: 'import-reference',
      labels: [...options.project.labels],
      ruleReason: options.rule.reason,
      targetProjectPath: options.targetProjectPath,
    },
    filePath: options.importRecord.filePath,
    locations: [
      {
        filePath: options.importRecord.filePath,
        label: 'import',
        line: options.importRecord.line,
      },
      {
        filePath: options.project.configPath,
        label: 'importing project',
      },
      {
        filePath: options.targetProjectPath,
        label: 'target project',
      },
    ],
    presentation: {
      detailLines: lines,
      reason: options.rule.reason,
      title: 'Denied graph access',
    },
    task: 'graph:check',
  } satisfies GraphAccessDeniedFinding);
}

function getNodeModulesPackageName(filePath: string): string | null {
  const parts = filePath.split('/');
  const nodeModulesIndex = parts.lastIndexOf('node_modules');

  if (nodeModulesIndex === -1) {
    return null;
  }

  const packageName = parts[nodeModulesIndex + 1];

  if (!packageName) {
    return null;
  }

  if (packageName.startsWith('@')) {
    const scopedName = parts[nodeModulesIndex + 2];

    return scopedName ? `${packageName}/${scopedName}` : null;
  }

  return packageName;
}

function getResolvedPackageName(
  filePath: string,
  workspaceLookup: WorkspaceLookupIndex,
): string | null {
  return (
    getNodeModulesPackageName(filePath) ??
    workspaceLookup.findPackageForFile(filePath)?.name ??
    null
  );
}

function addNamelessWorkspaceReferenceProblem(options: {
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  packageRole: 'referencing' | 'referenced';
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  referencePath: string;
  workspacePackage: WorkspacePackage;
}): void {
  const packageManifestPath = path.join(
    options.workspacePackage.directory,
    'package.json',
  );
  const lines = [
    'Project reference crosses workspace package without package identity:',
    `  ${options.packageRole} package.json: ${toRelativePath(options.config.rootDir, packageManifestPath)}`,
    `  referencing project: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  referenced project: ${toRelativePath(options.config.rootDir, options.referencePath)}`,
    '  reason: cross-package graph references need non-empty package.json names so Limina can validate dependency identity.',
    '  fix: add a non-empty package.json name when this workspace package should participate in package dependency graph checks.',
  ];

  options.findings.push({
    checkerName: getProjectCheckerName(
      options.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspacePackageNameMissing,
    evidence: [
      {
        label: `${options.packageRole} package manifest`,
        value: packageManifestPath,
      },
    ],
    facts: {
      packageManifestPath,
      packageRole: options.packageRole,
      referencedProjectPath: options.referencePath,
      referencingProjectPath: options.project.configPath,
    },
    filePath: options.project.configPath,
    locations: [
      {
        filePath: options.project.configPath,
        label: 'referencing project',
      },
      {
        filePath: options.referencePath,
        label: 'referenced project',
      },
      {
        label: `${options.packageRole} package`,
        packageManifestPath,
      },
    ],
    packageManifestPath,
    presentation: {
      detailLines: lines,
      fix: 'Add a non-empty package.json name when this workspace package should participate in package dependency graph checks.',
      reason:
        'Cross-package graph references need non-empty package.json names so Limina can validate dependency identity.',
      title:
        'Project reference crosses workspace package without package identity',
    },
    task: 'graph:check',
  } satisfies GraphWorkspacePackageNameMissingFinding);
}

function getResolvedWorkspacePackage(
  filePath: string,
  workspaceLookup: WorkspaceLookupIndex,
): WorkspacePackage | null {
  if (getNodeModulesPackageName(filePath)) {
    return null;
  }

  return workspaceLookup.findPackageForFile(filePath);
}

function addWorkspaceReferenceDependencyProblems(
  config: ResolvedLiminaConfig,
  project: ProjectInfo,
  projectsByPath: Map<string, ProjectInfo>,
  workspaceLookup: WorkspaceLookupIndex,
  findings: GraphFinding[],
  projectCheckerNamesByPath: ReadonlyMap<string, string>,
  checks: CheckCounter,
): void {
  if (!isDtsProjectConfig(project.configPath)) {
    return;
  }

  const sourcePackage = workspaceLookup.findPackageForFile(project.configPath);
  const importer = sourcePackage
    ? workspaceLookup.findImporterForFile(project.configPath)
    : null;

  if (!sourcePackage) {
    return;
  }

  for (const referencePath of project.references) {
    checks.add();

    if (!projectsByPath.has(referencePath)) {
      continue;
    }

    const targetPackage = workspaceLookup.findPackageForFile(referencePath);

    if (!targetPackage || targetPackage.directory === sourcePackage.directory) {
      continue;
    }

    if (!isNamedWorkspacePackage(sourcePackage)) {
      addNamelessWorkspaceReferenceProblem({
        config,
        findings,
        packageRole: 'referencing',
        project,
        projectCheckerNamesByPath,
        referencePath,
        workspacePackage: sourcePackage,
      });
      continue;
    }

    if (!isNamedWorkspacePackage(targetPackage)) {
      addNamelessWorkspaceReferenceProblem({
        config,
        findings,
        packageRole: 'referenced',
        project,
        projectCheckerNamesByPath,
        referencePath,
        workspacePackage: targetPackage,
      });
      continue;
    }

    if (importer?.declaredWorkspaceDependencies.has(targetPackage.name)) {
      continue;
    }

    const packageManifestPath = path.join(
      sourcePackage.directory,
      'package.json',
    );
    const lines = [
      'Project reference crosses workspace packages without a declared dependency:',
      `  referencing project: ${toRelativePath(config.rootDir, project.configPath)}`,
      `  referenced project: ${toRelativePath(config.rootDir, referencePath)}`,
      `  referencing package: ${sourcePackage.name}`,
      `  referenced package: ${targetPackage.name}`,
      `  package manifest: ${toRelativePath(config.rootDir, packageManifestPath)}`,
      `  reason: a cross-package project reference is a source dependency edge, so ${sourcePackage.name} must declare ${targetPackage.name} in dependencies, devDependencies, peerDependencies, or optionalDependencies.`,
      `  fix: declare "${targetPackage.name}" in the referencing package manifest. If this package intentionally consumes built artifacts, remove the project reference; ${formatArtifactDependencyPolicy(targetPackage)}`,
    ];

    findings.push({
      checkerName: getProjectCheckerName(
        projectCheckerNamesByPath,
        project.configPath,
      ),
      code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceDependencyUndeclared,
      evidence: [
        {
          label: 'referenced package',
          value: targetPackage.name,
        },
        {
          label: 'package manifest',
          value: packageManifestPath,
        },
      ],
      facts: {
        packageManifestPath,
        referencedPackageName: targetPackage.name,
        referencedProjectPath: referencePath,
        referencingPackageName: sourcePackage.name,
        referencingProjectPath: project.configPath,
      },
      filePath: project.configPath,
      locations: [
        {
          filePath: project.configPath,
          label: 'referencing project',
        },
        {
          filePath: referencePath,
          label: 'referenced project',
        },
        {
          label: 'referencing package',
          packageManifestPath,
        },
      ],
      packageManifestPath,
      packageName: sourcePackage.name,
      presentation: {
        detailLines: lines,
        fix: `Declare "${targetPackage.name}" in the referencing package manifest. If this package intentionally consumes built artifacts, remove the project reference.`,
        reason: `A cross-package project reference is a source dependency edge, so ${sourcePackage.name} must declare ${targetPackage.name}.`,
        title:
          'Project reference crosses workspace packages without a declared dependency',
      },
      task: 'graph:check',
    } satisfies GraphWorkspaceDependencyUndeclaredFinding);
  }
}

function createGeneratedReferenceGraph(
  projects: ProjectInfo[],
): Map<string, Set<string>> {
  const dtsProjects = projects.filter((project) =>
    isDtsProjectConfig(project.configPath),
  );
  const dtsProjectPaths = new Set(
    dtsProjects.map((project) => project.configPath),
  );
  const graph = new Map<string, Set<string>>();

  for (const project of dtsProjects) {
    graph.set(
      project.configPath,
      new Set(
        [...project.references]
          .filter((referencePath) => dtsProjectPaths.has(referencePath))
          .sort(),
      ),
    );
  }

  return graph;
}

function collectGeneratedReferenceComponents(
  graph: Map<string, Set<string>>,
): string[][] {
  const configPaths = new Set(graph.keys());

  for (const referencePaths of graph.values()) {
    for (const referencePath of referencePaths) {
      configPaths.add(referencePath);
    }
  }

  return collectStronglyConnectedComponents(
    [...configPaths].sort(),
    (configPath) => graph.get(configPath) ?? [],
  );
}

function getGeneratedReferenceCycleEdges(
  graph: Map<string, Set<string>>,
  members: string[],
): GeneratedReferenceCycleEdge[] {
  const memberPaths = new Set(members);

  return members
    .flatMap((from) =>
      [...(graph.get(from) ?? [])]
        .filter((to) => memberPaths.has(to))
        .map((to) => ({ from, to })),
    )
    .sort(
      (left, right) =>
        left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
    );
}

function addGeneratedReferenceCycleProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  projects: ProjectInfo[];
}): void {
  const graph = createGeneratedReferenceGraph(options.projects);

  options.checks.add(graph.size);

  for (const component of collectGeneratedReferenceComponents(graph)) {
    const hasSelfReference = Boolean(
      component[0] && graph.get(component[0])?.has(component[0]),
    );

    if (component.length === 1 && !hasSelfReference) {
      continue;
    }

    const members = [...component].sort();
    const internalEdges = getGeneratedReferenceCycleEdges(graph, members);
    const lines = [
      'Generated project reference cycle:',
      '  projects:',
      ...members.map(
        (member) => `    - ${toRelativePath(options.config.rootDir, member)}`,
      ),
      '  references in cycle:',
      ...internalEdges.map(
        (edge) =>
          `    - ${toRelativePath(options.config.rootDir, edge.from)} -> ${toRelativePath(options.config.rootDir, edge.to)}`,
      ),
      `  reason: ${GENERATED_REFERENCE_CYCLE_REASON}`,
      `  fix: ${GENERATED_REFERENCE_CYCLE_FIX}`,
    ];

    const checkerNames = new Set(
      members
        .map((member) =>
          getProjectCheckerName(options.projectCheckerNamesByPath, member),
        )
        .filter((value): value is string => Boolean(value)),
    );

    options.findings.push({
      checkerName: checkerNames.size === 1 ? [...checkerNames][0] : undefined,
      code: LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle,
      evidence: [
        {
          label: 'projects',
          lines: members,
        },
        {
          label: 'references in cycle',
          lines: internalEdges.map((edge) => `${edge.from} -> ${edge.to}`),
        },
      ],
      facts: {
        edges: internalEdges,
        projectPaths: members,
      },
      filePath: members[0],
      locations: members.map((member) => ({
        filePath: member,
        label: 'cycle project',
      })),
      presentation: {
        detailLines: lines,
        fix: GENERATED_REFERENCE_CYCLE_FIX,
        reason: GENERATED_REFERENCE_CYCLE_REASON,
        title: 'Generated project reference cycle',
      },
      task: 'graph:check',
    } satisfies GraphReferenceCycleFinding);
  }
}

function getExpectedReferencesForProject(
  expectedReferencesByProjectPath: Map<
    string,
    Map<string, ReferenceExpectation>
  >,
  project: ProjectInfo,
): Map<string, ReferenceExpectation> {
  const expectedReferences =
    expectedReferencesByProjectPath.get(project.configPath) ?? new Map();

  expectedReferencesByProjectPath.set(project.configPath, expectedReferences);

  return expectedReferences;
}

function addExpectedReference(options: {
  expectedReferencesByProjectPath: Map<
    string,
    Map<string, ReferenceExpectation>
  >;
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

function formatImportRecordLines(
  config: ResolvedLiminaConfig,
  importRecords: ImportRecord[],
): string[] {
  return importRecords
    .slice(0, 5)
    .map(
      (importRecord) =>
        `    - ${formatImportRecordLocation(config.rootDir, importRecord)} imports ${importRecord.specifier}`,
    )
    .concat(
      importRecords.length > 5
        ? [`    ...and ${importRecords.length - 5} more`]
        : [],
    );
}

function addReferenceCompletenessProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  expectedReferencesByProjectPath: Map<
    string,
    Map<string, ReferenceExpectation>
  >;
  findings: GraphFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  graphRules: NormalizedGraphRules;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  projects: ProjectInfo[];
  projectsByPath: Map<string, ProjectInfo>;
}): void {
  for (const project of options.projects) {
    if (!isDtsProjectConfig(project.configPath)) {
      continue;
    }

    const expectedReferences =
      options.expectedReferencesByProjectPath.get(project.configPath) ??
      new Map();

    for (const expectation of [...expectedReferences.values()].sort(
      (left, right) =>
        left.targetProjectPath.localeCompare(right.targetProjectPath),
    )) {
      options.checks.add();

      if (project.references.has(expectation.targetProjectPath)) {
        continue;
      }

      if (
        hasProviderEdgeForReferenceExpectation({
          expectation,
          fromProjectPath: project.configPath,
          generatedGraph: options.generatedGraph,
        })
      ) {
        continue;
      }

      const lines = [
        'Missing project reference for workspace import:',
        `  importing project: ${toRelativePath(options.config.rootDir, project.configPath)}`,
        `  expected reference: ${toRelativePath(options.config.rootDir, expectation.targetProjectPath)}`,
        `  current references: ${formatReferences(options.config.rootDir, project.references)}`,
        '  imports:',
        ...formatImportRecordLines(options.config, expectation.importRecords),
        '  fix: ensure both source tsconfig files are selected by checker.include, then run `limina graph prepare`.',
      ];

      const importFacts: GraphImportFact[] = expectation.importRecords.map(
        createGraphImportFact,
      );

      options.findings.push({
        checkerName: getProjectCheckerName(
          options.projectCheckerNamesByPath,
          project.configPath,
        ),
        code: LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing,
        evidence: [
          {
            label: 'expected reference',
            value: expectation.targetProjectPath,
          },
          {
            label: 'imports',
            lines: importFacts.map(
              (importFact: GraphImportFact) =>
                `${importFact.filePath}:${importFact.line} (${importFact.kind}) imports ${importFact.specifier}`,
            ),
          },
        ],
        facts: {
          expectedReferencePath: expectation.targetProjectPath,
          imports: importFacts,
          projectPath: project.configPath,
        },
        filePath: project.configPath,
        locations: [
          {
            filePath: project.configPath,
            label: 'importing project',
          },
          {
            filePath: expectation.targetProjectPath,
            label: 'expected reference',
          },
          ...importFacts.map((importFact: GraphImportFact) => ({
            filePath: importFact.filePath,
            label: 'import',
            line: importFact.line,
          })),
        ],
        presentation: {
          detailLines: lines,
          fix: 'Ensure both source tsconfig files are selected by checker.include, then run `limina graph prepare`.',
          reason:
            'A static workspace import reaches a declaration project that is not listed in the source declaration references.',
          title: 'Missing project reference for workspace import',
        },
        task: 'graph:check',
      } satisfies GraphReferenceMissingFinding);
    }

    if (project.fileNames.length === 0) {
      continue;
    }

    for (const referencePath of [...project.references].sort()) {
      options.checks.add();

      if (project.configPath.endsWith('/tsconfig.dts.json')) {
        const generatedChecker = getGeneratedCheckerNamespace(
          project.configPath,
        );
        const checkerRootConfigPath = generatedChecker
          ? `/.limina/tsconfig/checkers/${generatedChecker}/projects/tsconfig.dts.json`
          : null;

        if (
          checkerRootConfigPath &&
          project.configPath.endsWith(checkerRootConfigPath)
        ) {
          continue;
        }
      }

      if (
        expectedReferences.has(referencePath) ||
        !options.projectsByPath.has(referencePath)
      ) {
        continue;
      }

      if (
        getGeneratedCheckerNamespace(project.configPath) &&
        isSameGeneratedCheckerNamespace(project.configPath, referencePath)
      ) {
        continue;
      }

      if (
        getAllowedRefRule(options.graphRules, project.labels, referencePath)
      ) {
        continue;
      }

      const lines = [
        'Extra project reference not proven by static imports:',
        `  project: ${toRelativePath(options.config.rootDir, project.configPath)}`,
        `  extra reference: ${toRelativePath(options.config.rootDir, referencePath)}`,
        `  current references: ${formatReferences(options.config.rootDir, project.references)}`,
        '  reason: tsconfig*.dts.json references must match declaration leaves reached by static import/export analysis.',
        '  fix: remove the extra reference, import from the referenced project, or document the exception in graph.rules.<label>.allow.refs.',
      ];

      options.findings.push({
        checkerName: getProjectCheckerName(
          options.projectCheckerNamesByPath,
          project.configPath,
        ),
        code: LIMINA_CHECK_ISSUE_CODES.graphReferenceExtra,
        evidence: [
          {
            label: 'extra reference',
            value: referencePath,
          },
        ],
        facts: {
          extraReferencePath: referencePath,
          projectPath: project.configPath,
        },
        filePath: project.configPath,
        locations: [
          {
            filePath: project.configPath,
            label: 'project',
          },
          {
            filePath: referencePath,
            label: 'extra reference',
          },
        ],
        presentation: {
          detailLines: lines,
          fix: 'Remove the extra reference, import from the referenced project, or document the exception in graph.rules.<label>.allow.refs.',
          reason:
            'tsconfig*.dts.json references must match declaration leaves reached by static import/export analysis.',
          title: 'Extra project reference not proven by static imports',
        },
        task: 'graph:check',
      } satisfies GraphReferenceExtraFinding);
    }
  }
}

function hasProviderEdgeForReferenceExpectation(options: {
  expectation: ReferenceExpectation;
  fromProjectPath: string;
  generatedGraph: GeneratedTsconfigGraphResult;
}): boolean {
  const fromChecker = getGeneratedCheckerNamespace(options.fromProjectPath);
  const toChecker = getGeneratedCheckerNamespace(
    options.expectation.targetProjectPath,
  );
  const fromConfigPath = getGeneratedSourceConfigPath(
    options.generatedGraph,
    options.fromProjectPath,
  );
  const toConfigPath = getGeneratedSourceConfigPath(
    options.generatedGraph,
    options.expectation.targetProjectPath,
  );

  if (!fromChecker || !toChecker || !fromConfigPath || !toConfigPath) {
    return false;
  }

  return options.generatedGraph.providerEdges.some(
    (edge) =>
      edge.fromChecker === fromChecker &&
      edge.toChecker === toChecker &&
      edge.fromConfigPath === fromConfigPath &&
      edge.toConfigPath === toConfigPath,
  );
}

function createExpectedReferenceCollectionContext(
  options: ExpectedReferenceCollectionOptions,
): ExpectedReferenceCollectionContext {
  return {
    ...options,
    expectedReferencesByProjectPath: new Map(),
  };
}

function collectExpectedReferences(
  options: ExpectedReferenceCollectionOptions,
): ExpectedReferencesByProjectPath {
  const context = createExpectedReferenceCollectionContext(options);

  for (const project of context.projects) {
    collectExpectedReferencesForProject(context, project);
  }

  return context.expectedReferencesByProjectPath;
}

function collectExpectedReferencesForProject(
  context: ExpectedReferenceCollectionContext,
  project: ProjectInfo,
): void {
  if (
    context.selectedProjectPaths &&
    !context.selectedProjectPaths.has(project.configPath)
  ) {
    return;
  }

  for (const filePath of project.ownedFileNames) {
    for (const importRecord of collectImportsFromFile(
      filePath,
      context.config.rootDir,
      context.importAnalysis,
    )) {
      collectExpectedReferenceForImport({
        context,
        filePath,
        importRecord,
        project,
      });
    }
  }
}

function collectExpectedReferenceForImport(options: {
  context: ExpectedReferenceCollectionContext;
  filePath: string;
  importRecord: ImportRecord;
  project: ProjectInfo;
}): void {
  const rawDeniedDepRule = getDeniedDepRuleForSpecifier(
    options.context.graphRules,
    options.project.labels,
    options.importRecord.specifier,
  );

  if (rawDeniedDepRule) {
    addDeniedDepImportProblem({
      config: options.context.config,
      findings: options.context.findings,
      importRecord: options.importRecord,
      project: options.project,
      projectCheckerNamesByPath: options.context.projectCheckerNamesByPath,
      rule: rawDeniedDepRule,
    });
    return;
  }

  if (!shouldInferDeclarationReferenceFromImportRecord(options.importRecord)) {
    return;
  }

  const resolution = resolveImportForReferenceExpectation(options);

  if (!resolution) {
    return;
  }

  const targetProjectPath = findExpectedReferenceTargetProjectPath({
    context: options.context,
    importRecord: options.importRecord,
    project: options.project,
    resolution,
  });

  if (!targetProjectPath) {
    return;
  }

  addExpectedReferenceForTarget({
    context: options.context,
    importRecord: options.importRecord,
    project: options.project,
    resolution,
    targetProjectPath,
  });
}

function findManagedOutputTargetProjectPath(options: {
  attribution: ManagedOutputDeclarationProvider;
  context: ExpectedReferenceCollectionContext;
  importingCheckerName: string;
  importRecord: ImportRecord;
  project: ProjectInfo;
}): string | null {
  const sameCheckerTargetProjectPath =
    options.context.generatedGraph.sourceToDts
      .get(options.importingCheckerName)
      ?.get(options.attribution.sourceConfigPath) ?? null;

  if (sameCheckerTargetProjectPath) {
    return sameCheckerTargetProjectPath;
  }

  for (const edge of options.context.generatedGraph.providerEdges) {
    if (
      edge.fromChecker !== options.importingCheckerName ||
      edge.fromConfigPath !== options.project.resolverConfigPath ||
      edge.importedSpecifier !== options.importRecord.specifier ||
      edge.resolvedFilePath !== options.attribution.declarationFilePath ||
      edge.toConfigPath !== options.attribution.sourceConfigPath
    ) {
      continue;
    }

    const crossCheckerTargetProjectPath =
      options.context.generatedGraph.sourceToDts
        .get(edge.toChecker)
        ?.get(edge.toConfigPath) ?? null;

    if (crossCheckerTargetProjectPath) {
      return crossCheckerTargetProjectPath;
    }
  }

  return null;
}

function resolveImportForReferenceExpectation(options: {
  context: ExpectedReferenceCollectionContext;
  filePath: string;
  importRecord: ImportRecord;
  project: ProjectInfo;
}): GraphImportResolution | null {
  const targetPackage = options.context.workspaceLookup.findPackageForSpecifier(
    options.importRecord.specifier,
  );
  const importer = options.context.workspaceLookup.findImporterForFile(
    options.importRecord.filePath,
  );
  const workspaceExportResolution = getWorkspaceExportResolution({
    context: options.context,
    importRecord: options.importRecord,
    project: options.project,
    targetPackage,
  });
  const declarationProvider = resolveDeclarationProvider({
    compilerOptions: options.project.options,
    containingFile: options.filePath,
    fileOwnerLookup: options.context.fileOwnerLookup,
    importAnalysis: options.context.importAnalysis,
    importRecord: options.importRecord,
    project: options.project,
  });
  const workspaceTypeScriptResolvedFilePath =
    workspaceExportResolution?.typeScriptResolvedFileName ?? null;

  if (declarationProvider.kind === 'resource') {
    return null;
  }

  const graphResolvedFilePath =
    declarationProvider.kind === 'declaration' ||
    declarationProvider.kind === 'source'
      ? declarationProvider.typeScriptResolution.resolvedFileName
      : workspaceTypeScriptResolvedFilePath;

  if (
    workspaceExportResolution &&
    !workspaceExportResolution.hasTypeScriptStableEntry
  ) {
    addWorkspacePackageExportWithoutTypeEntryProblem({
      context: options.context,
      importRecord: options.importRecord,
      project: options.project,
      resolution: workspaceExportResolution,
    });
    return null;
  }

  if (!graphResolvedFilePath && declarationProvider.kind === 'oxc-only') {
    addOxcOnlyDeclarationProviderProblem({
      context: options.context,
      importRecord: options.importRecord,
      oxcResolvedFilePath: declarationProvider.oxcResolvedFilePath,
      project: options.project,
    });
    return null;
  }

  if (!graphResolvedFilePath && declarationProvider.kind === 'unresolved') {
    addUnresolvedWorkspaceImportProblem({
      context: options.context,
      importRecord: options.importRecord,
      project: options.project,
      targetPackage,
    });
    return null;
  }

  if (!graphResolvedFilePath) {
    return null;
  }

  let resolvedFilePath = graphResolvedFilePath;
  let managedOutputAttribution: ManagedOutputDeclarationProvider | null = null;
  let managedOutputTargetProjectPath: string | null = null;

  if (isDeclarationFileFamily(graphResolvedFilePath)) {
    const importingCheckerName = options.context.projectCheckerNamesByPath.get(
      options.project.configPath,
    );

    managedOutputAttribution = options.context.managedOutputLookup.resolve(
      graphResolvedFilePath,
      importingCheckerName,
    );

    if (!managedOutputAttribution || !importingCheckerName) {
      return null;
    }

    managedOutputTargetProjectPath = findManagedOutputTargetProjectPath({
      attribution: managedOutputAttribution,
      context: options.context,
      importingCheckerName,
      importRecord: options.importRecord,
      project: options.project,
    });

    if (!managedOutputTargetProjectPath) {
      return null;
    }

    resolvedFilePath = managedOutputAttribution.mappedSourceFilePath;
  }

  const targetWorkspacePackageForResolved = getResolvedWorkspacePackage(
    resolvedFilePath,
    options.context.workspaceLookup,
  );
  const targetPackageForGraph = getTargetPackageForGraph({
    targetPackage,
    targetWorkspacePackageForResolved,
    useWorkspaceExportResolution: Boolean(workspaceExportResolution),
  });
  const deniedDepRule = getDeniedDepRuleForResolvedPackage({
    context: options.context,
    project: options.project,
    resolvedFilePath,
  });

  if (deniedDepRule) {
    addDeniedDepImportProblem({
      config: options.context.config,
      findings: options.context.findings,
      importRecord: options.importRecord,
      project: options.project,
      projectCheckerNamesByPath: options.context.projectCheckerNamesByPath,
      rule: deniedDepRule,
    });
    return null;
  }

  return {
    graphResolvedFilePath: resolvedFilePath,
    importer,
    managedOutputAttribution,
    managedOutputTargetProjectPath,
    resolvedFilePath,
    targetPackage,
    targetPackageForGraph,
    targetWorkspacePackageForResolved,
    workspaceExportResolution,
  };
}

function addWorkspacePackageExportWithoutTypeEntryProblem(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  project: ProjectInfo;
  resolution: WorkspacePackageExportResolution;
}): void {
  const typeScriptResolvedFileName =
    options.resolution.typeScriptResolvedFileName;
  const oxcResolvedFileName = options.resolution.oxcResolvedFileName;
  const reason =
    'governed source imports through package exports must resolve to a stable type or checker source entry.';
  const fix =
    'add a types/declaration branch for this export, import a typed public API, or keep this entry as a runtime-only resource outside governed source imports.';
  const lines = [
    'Workspace source import uses package export without a type entry:',
    `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  package: ${options.resolution.packageName}`,
    `  export: ${options.resolution.subpath}`,
    ...(typeScriptResolvedFileName
      ? [
          `  TypeScript resolved file: ${toRelativePath(options.context.config.rootDir, typeScriptResolvedFileName)}`,
        ]
      : ['  TypeScript resolved file: (none)']),
    ...(oxcResolvedFileName
      ? [
          `  runtime resolved file: ${toRelativePath(options.context.config.rootDir, oxcResolvedFileName)}`,
        ]
      : ['  runtime resolved file: (none)']),
    `  reason: ${reason}`,
    `  fix: ${fix}`,
  ];
  const resolvedFilePath = typeScriptResolvedFileName ?? oxcResolvedFileName;

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
      {
        label: 'package export',
        value: `${options.resolution.packageName}${options.resolution.subpath === '.' ? '' : options.resolution.subpath.slice(1)}`,
      },
    ],
    facts: {
      import: createGraphImportFact(options.importRecord),
      importingProjectPath: options.project.configPath,
      kind: 'missing-type-entry',
      ...(resolvedFilePath ? { resolvedFilePath } : {}),
      targetPackageName: options.resolution.packageName,
    },
    filePath: options.importRecord.filePath,
    locations: [
      {
        filePath: options.importRecord.filePath,
        label: 'import',
        line: options.importRecord.line,
      },
      {
        filePath: options.project.configPath,
        label: 'importing project',
      },
    ],
    packageName: options.resolution.packageName,
    presentation: {
      detailLines: lines,
      fix,
      reason,
      title: 'Workspace source import uses package export without a type entry',
    },
    task: 'graph:check',
  } satisfies GraphWorkspaceImportUnresolvedFinding);
}

function getWorkspaceExportResolution(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  project: ProjectInfo;
  targetPackage: WorkspacePackage | null;
}): WorkspacePackageExportResolution | null {
  if (
    !options.targetPackage ||
    !options.targetPackage.name ||
    !options.context.workspaceExports.hasExports(options.targetPackage.name)
  ) {
    return null;
  }

  return options.context.workspaceExports.get(
    options.project.configPath,
    options.importRecord.specifier,
  );
}

function getTargetPackageForGraph(options: {
  targetPackage: WorkspacePackage | null;
  targetWorkspacePackageForResolved: WorkspacePackage | null;
  useWorkspaceExportResolution: boolean;
}): WorkspacePackage | null {
  if (options.useWorkspaceExportResolution) {
    return options.targetPackage;
  }

  if (
    options.targetPackage?.name &&
    options.targetWorkspacePackageForResolved?.name ===
      options.targetPackage.name
  ) {
    return options.targetPackage;
  }

  return null;
}

function getDeniedDepRuleForResolvedPackage(options: {
  context: ExpectedReferenceCollectionContext;
  project: ProjectInfo;
  resolvedFilePath: string;
}): GraphRuleDepDeny | null {
  const resolvedPackageName = getResolvedPackageName(
    options.resolvedFilePath,
    options.context.workspaceLookup,
  );

  if (!resolvedPackageName) {
    return null;
  }

  return getDeniedDepRuleForPackage(
    options.context.graphRules,
    options.project.labels,
    resolvedPackageName,
  );
}

function addUnresolvedWorkspaceImportProblem(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  project: ProjectInfo;
  targetPackage: WorkspacePackage | null;
}): void {
  if (!options.targetPackage?.name) {
    return;
  }
  const lines = [
    'Unresolved workspace import:',
    `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  matched workspace package: ${options.targetPackage.name}`,
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
      targetPackageName: options.targetPackage.name,
    },
    filePath: options.importRecord.filePath,
    locations: [
      {
        filePath: options.importRecord.filePath,
        label: 'import',
        line: options.importRecord.line,
      },
      {
        filePath: options.project.configPath,
        label: 'importing project',
      },
    ],
    packageName: options.targetPackage.name,
    presentation: {
      detailLines: lines,
      reason: GRAPH_CHECK_DEFAULT_REASON,
      title: 'Unresolved workspace import',
    },
    task: 'graph:check',
  } satisfies GraphWorkspaceImportUnresolvedFinding);
}

function addOxcOnlyDeclarationProviderProblem(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  oxcResolvedFilePath: string;
  project: ProjectInfo;
}): void {
  const targetPackage = options.context.workspaceLookup.findPackageForSpecifier(
    options.importRecord.specifier,
  );

  if (!targetPackage?.name) {
    return;
  }

  const lines = [
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
      {
        label: 'Oxc resolved file',
        value: options.oxcResolvedFilePath,
      },
    ],
    facts: {
      import: createGraphImportFact(options.importRecord),
      importingProjectPath: options.project.configPath,
      kind: 'oxc-only',
      resolvedFilePath: options.oxcResolvedFilePath,
      targetPackageName: targetPackage.name,
    },
    filePath: options.importRecord.filePath,
    locations: [
      {
        filePath: options.importRecord.filePath,
        label: 'import',
        line: options.importRecord.line,
      },
      {
        filePath: options.project.configPath,
        label: 'importing project',
      },
      {
        filePath: options.oxcResolvedFilePath,
        label: 'Oxc resolved file',
      },
    ],
    packageName: targetPackage.name,
    presentation: {
      detailLines: lines,
      fix: 'Check moduleResolution, exports.types/types conditions, paths, customConditions, and package boundaries.',
      reason:
        'Oxc resolved this specifier, but TypeScript could not resolve a declaration provider.',
      title: 'Oxc can resolve this specifier, but TypeScript cannot',
    },
    task: 'graph:check',
  } satisfies GraphWorkspaceImportUnresolvedFinding);
}

function findExpectedReferenceTargetProjectPath(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  project: ProjectInfo;
  resolution: GraphImportResolution;
}): string | null {
  if (options.resolution.managedOutputTargetProjectPath) {
    return options.resolution.managedOutputTargetProjectPath;
  }

  if (shouldSkipWorkspaceExportResolvedOutsideGraph(options)) {
    return null;
  }

  if (addBuildArtifactImportProblem(options)) {
    return null;
  }

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

function shouldSkipWorkspaceExportResolvedOutsideGraph(options: {
  context: ExpectedReferenceCollectionContext;
  resolution: GraphImportResolution;
}): boolean {
  return Boolean(
    options.resolution.targetPackageForGraph &&
      shouldResolveThroughGraph(
        options.resolution.importer,
        options.resolution.targetPackageForGraph,
      ) &&
      options.resolution.workspaceExportResolution &&
      !options.context.fileOwnerLookup.has(
        options.resolution.graphResolvedFilePath,
      ),
  );
}

function addBuildArtifactImportProblem(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  project: ProjectInfo;
  resolution: GraphImportResolution;
}): boolean {
  if (
    !options.resolution.targetPackageForGraph ||
    !shouldResolveThroughGraph(
      options.resolution.importer,
      options.resolution.targetPackageForGraph,
    ) ||
    options.resolution.workspaceExportResolution ||
    options.context.fileOwnerLookup.has(options.resolution.resolvedFilePath)
  ) {
    return false;
  }

  const referencedProjectPath = inferPackageProject(
    options.resolution.resolvedFilePath,
    options.resolution.targetPackageForGraph,
    options.context.projectPaths,
  );
  const hasProjectReference = Boolean(
    referencedProjectPath &&
      options.project.references.has(referencedProjectPath),
  );

  const targetPackageName = options.resolution.targetPackageForGraph.name;

  if (!targetPackageName) {
    return false;
  }

  const title = hasProjectReference
    ? 'Referenced workspace dependency resolves through package exports to a build artifact'
    : 'Workspace source dependency resolved outside the source graph';
  const reason =
    'this import resolved to a file not owned by the source graph, so it is not a source project-reference edge.';
  const fix = `point the dependency package export at source files, or treat this relationship as artifact consumption; ${formatArtifactDependencyPolicy(options.resolution.targetPackageForGraph)}`;
  const lines = [
    `${title}:`,
    `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
    ...(referencedProjectPath
      ? [
          `  referenced project: ${toRelativePath(options.context.config.rootDir, referencedProjectPath)}`,
          `  project reference present: ${hasProjectReference ? 'yes' : 'no'}`,
        ]
      : []),
    `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.context.config.rootDir, options.resolution.resolvedFilePath)}`,
    `  reason: ${reason}`,
    `  fix: ${fix}`,
  ];

  options.context.findings.push({
    checkerName: getProjectCheckerName(
      options.context.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportOutsideGraph,
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
      {
        label: 'resolved file',
        value: options.resolution.resolvedFilePath,
      },
    ],
    facts: {
      import: createGraphImportFact(options.importRecord),
      importingProjectPath: options.project.configPath,
      kind: 'build-artifact',
      ...(referencedProjectPath ? { referencedProjectPath } : {}),
      resolvedFilePath: options.resolution.resolvedFilePath,
      targetPackageName,
    },
    filePath: options.importRecord.filePath,
    locations: [
      {
        filePath: options.importRecord.filePath,
        label: 'import',
        line: options.importRecord.line,
      },
      {
        filePath: options.project.configPath,
        label: 'importing project',
      },
      ...(referencedProjectPath
        ? [
            {
              filePath: referencedProjectPath,
              label: 'referenced project',
            },
          ]
        : []),
      {
        filePath: options.resolution.resolvedFilePath,
        label: 'resolved file',
      },
    ],
    packageName: targetPackageName,
    presentation: {
      detailLines: lines,
      fix,
      reason,
      title,
    },
    task: 'graph:check',
  } satisfies GraphWorkspaceImportOutsideGraphFinding);

  return true;
}

function addUnmappedWorkspaceImportProblem(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  project: ProjectInfo;
  resolution: GraphImportResolution;
}): void {
  if (!options.resolution.targetPackageForGraph) {
    return;
  }

  if (options.resolution.graphResolvedFilePath.includes('/dist/')) {
    return;
  }

  if (!options.resolution.targetWorkspacePackageForResolved) {
    addOutsideWorkspaceGraphProblem(options);
    return;
  }

  const targetPackageName = options.resolution.targetPackageForGraph.name;

  if (!targetPackageName) {
    return;
  }

  const lines = [
    'Unable to map workspace import to a graph project:',
    `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.context.config.rootDir, options.resolution.graphResolvedFilePath)}`,
    `  current references: ${formatReferences(options.context.config.rootDir, options.project.references)}`,
  ];

  options.context.findings.push({
    checkerName: getProjectCheckerName(
      options.context.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphImportTargetUnmapped,
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
      {
        label: 'resolved file',
        value: options.resolution.graphResolvedFilePath,
      },
    ],
    facts: {
      import: createGraphImportFact(options.importRecord),
      importingProjectPath: options.project.configPath,
      resolvedFilePath: options.resolution.graphResolvedFilePath,
      targetPackageName,
    },
    filePath: options.importRecord.filePath,
    locations: [
      {
        filePath: options.importRecord.filePath,
        label: 'import',
        line: options.importRecord.line,
      },
      {
        filePath: options.project.configPath,
        label: 'importing project',
      },
      {
        filePath: options.resolution.graphResolvedFilePath,
        label: 'resolved file',
      },
    ],
    packageName: targetPackageName,
    presentation: {
      detailLines: lines,
      reason: GRAPH_CHECK_DEFAULT_REASON,
      title: 'Unable to map workspace import to a graph project',
    },
    task: 'graph:check',
  } satisfies GraphImportTargetUnmappedFinding);
}

function addOutsideWorkspaceGraphProblem(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  project: ProjectInfo;
  resolution: GraphImportResolution;
}): void {
  const targetPackage = options.resolution.targetPackageForGraph;

  if (
    !targetPackage ||
    !shouldResolveThroughGraph(options.resolution.importer, targetPackage)
  ) {
    return;
  }

  if (!targetPackage.name) {
    return;
  }

  const reason = `source dependency edges must resolve to files owned by the source graph; ${formatArtifactDependencyPolicy(targetPackage)}`;
  const lines = [
    'Workspace source import resolved outside the workspace graph:',
    `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  resolved file: ${toRelativePath(options.context.config.rootDir, options.resolution.graphResolvedFilePath)}`,
    `  reason: ${reason}`,
  ];

  options.context.findings.push({
    checkerName: getProjectCheckerName(
      options.context.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportOutsideGraph,
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
      {
        label: 'resolved file',
        value: options.resolution.graphResolvedFilePath,
      },
    ],
    facts: {
      import: createGraphImportFact(options.importRecord),
      importingProjectPath: options.project.configPath,
      kind: 'outside-workspace-graph',
      resolvedFilePath: options.resolution.graphResolvedFilePath,
      targetPackageName: targetPackage.name,
    },
    filePath: options.importRecord.filePath,
    locations: [
      {
        filePath: options.importRecord.filePath,
        label: 'import',
        line: options.importRecord.line,
      },
      {
        filePath: options.project.configPath,
        label: 'importing project',
      },
      {
        filePath: options.resolution.graphResolvedFilePath,
        label: 'resolved file',
      },
    ],
    packageName: targetPackage.name,
    presentation: {
      detailLines: lines,
      reason,
      title: 'Workspace source import resolved outside the workspace graph',
    },
    task: 'graph:check',
  } satisfies GraphWorkspaceImportOutsideGraphFinding);
}

function addExpectedReferenceForTarget(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  project: ProjectInfo;
  resolution: GraphImportResolution;
  targetProjectPath: string;
}): void {
  if (options.targetProjectPath === options.project.configPath) {
    return;
  }

  const deniedRefRule = getDeniedRefRule(
    options.context.graphRules,
    options.project.labels,
    options.targetProjectPath,
  );

  if (deniedRefRule) {
    addDeniedRefImportProblem({
      config: options.context.config,
      findings: options.context.findings,
      importRecord: options.importRecord,
      project: options.project,
      projectCheckerNamesByPath: options.context.projectCheckerNamesByPath,
      rule: deniedRefRule,
      targetProjectPath: options.targetProjectPath,
    });
    return;
  }

  if (
    options.resolution.targetPackageForGraph &&
    !shouldResolveThroughGraph(
      options.resolution.importer,
      options.resolution.targetPackageForGraph,
    )
  ) {
    return;
  }

  if (!options.context.projectsByPath.has(options.targetProjectPath)) {
    const lines = [
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
        {
          label: 'expected graph project',
          value: options.targetProjectPath,
        },
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
        {
          filePath: options.project.configPath,
          label: 'importing project',
        },
        {
          filePath: options.targetProjectPath,
          label: 'expected graph project',
        },
      ],
      presentation: {
        detailLines: lines,
        reason: GRAPH_CHECK_DEFAULT_REASON,
        title: 'Expected graph target is not reachable from any checker entry',
      },
      task: 'graph:check',
    } satisfies GraphTargetUnreachableFinding);
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

function getGeneratedSourceConfigPath(
  generatedGraph: GeneratedTsconfigGraphResult,
  projectPath: string,
): string | undefined {
  for (const dtsToSource of generatedGraph.dtsToSource.values()) {
    const sourceConfigPath = dtsToSource.get(projectPath);

    if (sourceConfigPath) {
      return sourceConfigPath;
    }
  }

  return undefined;
}

function getPreferredGeneratedTargetProjectPath(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  importingProjectPath: string;
  targetProjectPath: string;
}): string {
  const importingChecker = getGeneratedCheckerNamespace(
    options.importingProjectPath,
  );

  if (!importingChecker) {
    return options.targetProjectPath;
  }

  const sourceConfigPath = getGeneratedSourceConfigPath(
    options.generatedGraph,
    options.targetProjectPath,
  );

  if (!sourceConfigPath) {
    return options.targetProjectPath;
  }

  return (
    options.generatedGraph.sourceToDts
      .get(importingChecker)
      ?.get(sourceConfigPath) ?? options.targetProjectPath
  );
}

function createWorkspaceExportsResolutionProfiles(
  projects: ProjectInfo[],
): WorkspaceExportsResolutionProfile[] {
  return projects.map((project) => ({
    checkerPresets: project.checkerPresets,
    configPath: project.configPath,
    extensions: project.extensions,
    options: project.options,
    resolverConfigPath: project.resolverConfigPath,
  }));
}

function createGeneratedProjectCheckerNamesByPath(
  generatedGraph: GeneratedTsconfigGraphResult,
): Map<string, string> {
  const checkerNamesByPath = new Map<string, string>();

  for (const [checkerName, sourceToDts] of generatedGraph.sourceToDts) {
    for (const [sourceConfigPath, dtsConfigPath] of sourceToDts) {
      checkerNamesByPath.set(sourceConfigPath, checkerName);
      checkerNamesByPath.set(dtsConfigPath, checkerName);
    }
  }

  return checkerNamesByPath;
}

function createGraphCheckManagedOutputProjectContexts(options: {
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  projectCheckerNamesByPath: Map<string, string>;
  projects: ProjectInfo[];
}): ManagedOutputProjectContext[] {
  const contextsByKey = new Map<string, ManagedOutputProjectContext>();

  for (const project of options.projects) {
    const checkerName = options.projectCheckerNamesByPath.get(
      project.configPath,
    );

    if (!checkerName) {
      continue;
    }

    const outputOptions = readOutputOptions(
      options.config,
      project.resolverConfigPath,
    );

    for (const diagnostic of outputOptions.diagnostics) {
      options.findings.push({
        checkerName,
        code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
        evidence: [
          {
            label: 'field',
            value: diagnostic.field,
          },
          ...(Object.hasOwn(diagnostic, 'value')
            ? [
                {
                  label: 'value',
                  value: JSON.stringify(diagnostic.value),
                },
              ]
            : []),
        ],
        facts: {
          kind: 'output-options',
          projectPath: diagnostic.sourceConfigPath,
        },
        filePath: diagnostic.sourceConfigPath,
        locations: [
          {
            filePath: diagnostic.sourceConfigPath,
            label: 'source config',
          },
        ],
        presentation: {
          detailLines: diagnostic.detailLines,
          reason: diagnostic.reason,
          title: 'Invalid Limina output options',
        },
        task: 'graph:check',
      } satisfies GraphConfigInvalidFinding);
    }

    if (!outputOptions.outputs) {
      continue;
    }

    const key = JSON.stringify([checkerName, project.resolverConfigPath]);

    if (contextsByKey.has(key)) {
      continue;
    }

    contextsByKey.set(key, {
      checkerName,
      sourceConfigPath: project.resolverConfigPath,
      outputOptions: {
        outDir: outputOptions.outputs.outDir,
        rootDir: outputOptions.outputs.rootDir,
      },
      ownedFileNames: project.ownedFileNames,
      extensions: project.extensions,
    });
  }

  return [...contextsByKey.values()];
}

function createGeneratedGraphPathAliases(
  generatedGraph: GeneratedTsconfigGraphResult,
): Map<string, string> {
  return new Map(
    [...generatedGraph.sourceToDts.values()].flatMap((sourceToDts) => [
      ...sourceToDts.entries(),
    ]),
  );
}

export async function runGraphCheckImpl(
  config: ResolvedLiminaConfig,
  options: {
    providers?: AnalysisProviderSet;
    generatedGraphProvider?: () => Promise<GeneratedTsconfigGraphResult>;
    issues?: LiminaCheckIssue[];
    logSuccess?: boolean;
    onStats?: (stats: LiminaCheckRunTaskStats) => void;
    preflight?: LiminaPreflightManager;
    progress?: TaskProgressReporter;
    report?: CheckIssueReportOptions;
  } = {},
): Promise<boolean> {
  const findings: GraphFinding[] = [];
  const checks = createCheckCounter();
  const checkItems = createCheckItemAccumulator(
    () => findings.length,
    () => checks.value,
    {
      plannedItems: GRAPH_CHECK_ITEM_NAMES,
      progress: options.progress,
    },
  );
  const preflight = resolvePreflight(config, options);
  const core = preflight.providers;
  const generatedGraph = await preflight.ensureGeneratedGraph();
  const graphRoute = await preflight.ensureSourceGraphProjectExtensions();
  const projectPaths = [...graphRoute.projectExtensionsByPath.keys()].sort();
  const workspaceLookup = await preflight.ensureWorkspaceLookupIndex();
  const projects = (
    await Promise.all(
      projectPaths.map((projectPath) =>
        core.tsconfig.getProject(
          projectPath,
          graphRoute.projectContextsByPath.get(projectPath),
        ),
      ),
    )
  ).map((project) =>
    filterProjectInfoToActivatedRegion(project, workspaceLookup),
  );
  const projectsByPath = new Map(
    projects.map((project) => [project.configPath, project]),
  );
  const fileOwnerLookup = createFileOwnerLookup(projects);
  const projectCheckerNamesByPath =
    createGeneratedProjectCheckerNamesByPath(generatedGraph);
  const managedOutputLookup = createManagedOutputDeclarationLookup(
    createGraphCheckManagedOutputProjectContexts({
      config,
      findings,
      projectCheckerNamesByPath,
      projects,
    }),
  );
  const packages = await preflight.ensureWorkspacePackages();

  checkItems.start('source graph routes');
  for (const diagnostic of graphRoute.diagnostics) {
    const filePath = diagnostic.filePath ?? config.configPath;

    findings.push({
      checkerName: diagnostic.checkerName,
      code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
      evidence: [
        {
          label: 'checker',
          value: diagnostic.checkerName,
        },
      ],
      facts: {
        configPath: config.configPath,
        kind: 'route',
      },
      filePath,
      locations: [
        {
          filePath,
          label: 'checker graph route',
        },
      ],
      presentation: {
        detailLines: diagnostic.detailLines,
        reason: diagnostic.reason,
        title: diagnostic.title,
      },
      task: 'graph:check',
    } satisfies GraphConfigInvalidFinding);
  }
  const customConditionConsistencyContext =
    createCustomConditionConsistencyContext(
      projectsByPath,
      projectCheckerNamesByPath,
    );
  const workspaceExports = await createWorkspaceExportsResolutionIndex({
    config,
    importAnalysis: preflight.importAnalysis,
    metrics: preflight.profilingMetrics,
    packages,
    profiles: createWorkspaceExportsResolutionProfiles(projects),
  });

  for (const diagnostic of workspaceExports.diagnostics) {
    findings.push({
      code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
      evidence: [
        {
          label: 'package export',
          value: diagnostic.subpath,
        },
      ],
      facts: {
        configPath: config.configPath,
        kind: 'workspace-export',
        packageManifestPath: diagnostic.packageJsonPath,
        packageName: diagnostic.packageName,
      },
      filePath: diagnostic.packageJsonPath,
      locations: [
        {
          label: 'package manifest',
          packageManifestPath: diagnostic.packageJsonPath,
        },
      ],
      packageManifestPath: diagnostic.packageJsonPath,
      packageName: diagnostic.packageName,
      presentation: {
        detailLines: diagnostic.detailLines,
        fix: diagnostic.fix,
        reason: diagnostic.reason,
        title: diagnostic.title,
      },
      task: 'graph:check',
    } satisfies GraphConfigInvalidFinding);
  }
  checks.add(projectPaths.length);
  checkItems.record('source graph routes');

  checkItems.start('project references');
  const graphRules = normalizeGraphRules({
    config,
    include: {
      deps: true,
      refs: true,
    },
    packages,
    findings,
    projectPathAliases: createGeneratedGraphPathAliases(generatedGraph),
    projectPaths,
  });
  for (const project of projects) {
    if (project.labelDiagnostic) {
      const diagnostic = project.labelDiagnostic;

      findings.push({
        checkerName: getProjectCheckerName(
          projectCheckerNamesByPath,
          project.configPath,
        ),
        code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
        evidence: [
          {
            label: 'field',
            value: diagnostic.field,
          },
          ...(Object.hasOwn(diagnostic, 'value')
            ? [
                {
                  label: 'value',
                  value: JSON.stringify(diagnostic.value),
                },
              ]
            : []),
        ],
        facts: {
          kind: 'project-label',
          projectPath: diagnostic.projectPath,
        },
        filePath: diagnostic.projectPath,
        locations: [
          {
            filePath: diagnostic.projectPath,
            label: 'project',
          },
        ],
        presentation: {
          detailLines: diagnostic.detailLines,
          reason: diagnostic.reason,
          title: diagnostic.title,
        },
        task: 'graph:check',
      } satisfies GraphConfigInvalidFinding);
    }

    const checkerName = getProjectCheckerName(
      projectCheckerNamesByPath,
      project.configPath,
    );

    addDtsOptionProblems(config, project, findings, checks, checkerName);
    addTypecheckParityProblems(config, project, findings, checks, checkerName);
    addDeniedReferenceProblems({
      checks,
      config,
      findings,
      project,
      projectCheckerNamesByPath,
      projectsByPath,
      rules: graphRules,
      workspaceLookup,
    });
    addWorkspaceReferenceDependencyProblems(
      config,
      project,
      projectsByPath,
      workspaceLookup,
      findings,
      projectCheckerNamesByPath,
      checks,
    );
  }
  addGeneratedReferenceCycleProblems({
    checks,
    config,
    findings,
    projectCheckerNamesByPath,
    projects,
  });
  checkItems.record('project references');

  checkItems.start('condition domains');
  addDefaultCustomConditionProblems({
    checks,
    config,
    consistencyContext: customConditionConsistencyContext,
    findings,
    projects,
  });
  addConditionDomainProblems({
    checks,
    config,
    consistencyContext: customConditionConsistencyContext,
    findings,
    generatedGraph,
    projectsByPath,
  });
  checkItems.record('condition domains');

  checkItems.start('reference completeness');
  const expectedReferencesByProjectPath = collectExpectedReferences({
    config,
    fileOwnerLookup,
    generatedGraph,
    graphRules,
    importAnalysis: preflight.importAnalysis,
    managedOutputLookup,
    packages,
    projectCheckerNamesByPath,
    findings,
    projectPaths,
    projects,
    projectsByPath,
    workspaceExports,
    workspaceLookup,
  });

  addReferenceCompletenessProblems({
    checks,
    config,
    expectedReferencesByProjectPath,
    findings,
    generatedGraph,
    graphRules,
    projectCheckerNamesByPath,
    projects,
    projectsByPath,
  });
  checkItems.record('reference completeness');

  if (findings.length > 0) {
    const issues = createGraphCheckIssuesFromFindings({
      config,
      findings,
    });

    options.onStats?.({
      items: checkItems.getItems(),
      passed: 0,
      total: checks.value,
    });
    options.issues?.push(...issues);
    if (!options.report?.defer) {
      GraphLogger.error(
        formatCheckIssueHumanReport({
          command: options.report?.command ?? 'limina graph check',
          issues,
          title: 'Graph check summary',
          verbose: options.report?.verbose,
        }),
      );
    }
    return false;
  }

  if (options.logSuccess ?? true) {
    GraphLogger.success(
      `Checked ${projects.length} graph projects; references are valid.`,
    );
  }

  options.onStats?.({
    items: checkItems.getItems(),
    passed: checks.value,
    total: checks.value,
  });

  return true;
}

export async function runGraphPrepareImpl(
  config: ResolvedLiminaConfig,
  options: RunGraphPrepareOptions = {},
): Promise<GeneratedTsconfigGraphResult> {
  const preflight = resolvePreflight(config, options);
  return (await preflight.ensureGeneratedArtifactsMaterialized()).graph;
}

export async function runGraphExportImpl(
  config: ResolvedLiminaConfig,
  options: RunGraphExportOptions = {},
): Promise<DependencyGraphDocument> {
  const preflight = resolvePreflight(config, options);
  await preflight.ensureWorkspaceValidated();
  const graph = await collectDependencyGraph(config, {
    providers: preflight.providers,
    view: options.view,
  });

  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, stringifyDependencyGraph(graph));
  }

  return graph;
}
