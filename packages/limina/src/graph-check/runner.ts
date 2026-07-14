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
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import {
  type CheckIssueReportOptions,
  formatCheckIssueHumanReport,
} from '../check-reporting/human';
import type { LiminaCheckRunTaskStats } from '../check-reporting/run-recorder';
import {
  createTaskFailureIssue,
  type LiminaCheckIssue,
} from '../check-reporting/snapshot';
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
  problems: string[];
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

interface GraphProblemIssueHint {
  code: string;
  filePath?: string;
  fix?: string;
  packageManifestPath?: string;
  packageName?: string;
  reason?: string;
  title?: string;
}

interface GeneratedReferenceCycleEdge {
  from: string;
  to: string;
}

const graphProblemIssueHints = new Map<string, GraphProblemIssueHint>();

function addGraphProblem(
  problems: string[],
  lines: readonly string[],
  hint: GraphProblemIssueHint,
): void {
  const problem = lines.join('\n');

  problems.push(problem);
  graphProblemIssueHints.set(problem, hint);
}

function getGraphProblemTitle(problem: string): string {
  const firstLine = problem.split('\n')[0]?.trim() || 'Graph check issue';

  return firstLine.replace(/:+$/u, '');
}

function getGraphProblemCode(title: string): string {
  if (title.startsWith('Missing project reference')) {
    return 'LIMINA_GRAPH_REFERENCE_MISSING';
  }

  if (title.startsWith('Extra project reference')) {
    return 'LIMINA_GRAPH_REFERENCE_EXTRA';
  }

  if (title.startsWith('Denied graph access')) {
    return 'LIMINA_GRAPH_ACCESS_DENIED';
  }

  if (title.includes('without a declared dependency')) {
    return 'LIMINA_GRAPH_WORKSPACE_DEPENDENCY_UNDECLARED';
  }

  if (title.includes('without package identity')) {
    return 'LIMINA_GRAPH_WORKSPACE_PACKAGE_NAME_MISSING';
  }

  if (title.startsWith('Unresolved workspace import')) {
    return 'LIMINA_GRAPH_WORKSPACE_IMPORT_UNRESOLVED';
  }

  if (
    title.includes('outside the source graph') ||
    title.includes('outside the workspace graph') ||
    title.includes('build artifact')
  ) {
    return 'LIMINA_GRAPH_WORKSPACE_IMPORT_OUTSIDE_GRAPH';
  }

  if (title.startsWith('Unable to map workspace import')) {
    return 'LIMINA_GRAPH_IMPORT_TARGET_UNMAPPED';
  }

  if (title.startsWith('Expected graph target is not reachable')) {
    return 'LIMINA_GRAPH_TARGET_UNREACHABLE';
  }

  if (
    title.startsWith('Invalid graph') ||
    title.startsWith('Invalid declaration') ||
    title.startsWith('Missing declaration') ||
    title.startsWith('Missing typecheck') ||
    title.startsWith('Typecheck option') ||
    title.startsWith('Declaration leaf')
  ) {
    return 'LIMINA_GRAPH_CONFIG_INVALID';
  }

  if (title.startsWith('Custom conditions mismatch')) {
    return 'LIMINA_GRAPH_CONDITION_DOMAIN_MISMATCH';
  }

  return 'LIMINA_GRAPH_CHECK_FAILED';
}

function getProblemLineValue(
  problem: string,
  label: string,
): string | undefined {
  const escapedLabel = label.replaceAll(
    /[.*+?^${}()|[\]\\]/gu,
    String.raw`\$&`,
  );
  const match = new RegExp(String.raw`^\s*${escapedLabel}:\s*(.+)$`, 'mu').exec(
    problem,
  );

  return match?.[1]?.trim();
}

function getProblemFilePath(problem: string): string | undefined {
  const rawFile =
    getProblemLineValue(problem, 'file') ??
    getProblemLineValue(problem, 'resolved file') ??
    getProblemLineValue(problem, 'project') ??
    getProblemLineValue(problem, 'importing project') ??
    getProblemLineValue(problem, 'referencing project');

  return rawFile?.replace(/:\d+(?::\d+)?(?:\s+\(.+\))?$/u, '');
}

function createGraphCheckIssue(options: {
  config: ResolvedLiminaConfig;
  problem: string;
}): LiminaCheckIssue {
  const hint = graphProblemIssueHints.get(options.problem);
  const title = hint?.title ?? getGraphProblemTitle(options.problem);
  const reason =
    hint?.reason ??
    getProblemLineValue(options.problem, 'reason') ??
    'Graph check found architecture, dependency, resolver, or config violations.';

  return createTaskFailureIssue({
    code: hint?.code ?? getGraphProblemCode(title),
    detailLines: options.problem.split('\n'),
    filePath: hint?.filePath ?? getProblemFilePath(options.problem),
    fix: hint?.fix ?? getProblemLineValue(options.problem, 'fix'),
    packageManifestPath:
      hint?.packageManifestPath ??
      getProblemLineValue(options.problem, 'package.json') ??
      getProblemLineValue(options.problem, 'package manifest'),
    packageName:
      hint?.packageName ??
      getProblemLineValue(options.problem, 'referencing package') ??
      getProblemLineValue(options.problem, 'matched workspace package') ??
      getProblemLineValue(options.problem, 'package'),
    reason,
    rootDir: options.config.rootDir,
    task: 'graph:check',
    title,
  });
}

function createGraphCheckIssues(options: {
  config: ResolvedLiminaConfig;
  problems: readonly string[];
}): LiminaCheckIssue[] {
  return options.problems.map((problem) =>
    createGraphCheckIssue({
      config: options.config,
      problem,
    }),
  );
}

function addDeniedReferenceProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  problems: string[];
  project: ProjectInfo;
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

    addGraphProblem(options.problems, lines, {
      code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
      filePath: options.project.configPath,
      reason: deniedDepRule?.reason ?? deniedRefRule?.reason,
      title: 'Denied graph access',
    });
  }
}

function addDeniedDepImportProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  project: ProjectInfo;
  problems: string[];
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

  addGraphProblem(options.problems, lines, {
    code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
    filePath: options.importRecord.filePath,
    packageName: options.rule.name,
    reason: options.rule.reason,
    title: 'Denied graph access',
  });
}

function addDeniedRefImportProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  project: ProjectInfo;
  problems: string[];
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

  addGraphProblem(options.problems, lines, {
    code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
    filePath: options.importRecord.filePath,
    reason: options.rule.reason,
    title: 'Denied graph access',
  });
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
  packageRole: 'referencing' | 'referenced';
  problems: string[];
  project: ProjectInfo;
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

  addGraphProblem(options.problems, lines, {
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspacePackageNameMissing,
    filePath: options.project.configPath,
    fix: 'Add a non-empty package.json name when this workspace package should participate in package dependency graph checks.',
    packageManifestPath,
    reason:
      'Cross-package graph references need non-empty package.json names so Limina can validate dependency identity.',
    title:
      'Project reference crosses workspace package without package identity',
  });
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
  problems: string[],
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
        packageRole: 'referencing',
        problems,
        project,
        referencePath,
        workspacePackage: sourcePackage,
      });
      continue;
    }

    if (!isNamedWorkspacePackage(targetPackage)) {
      addNamelessWorkspaceReferenceProblem({
        config,
        packageRole: 'referenced',
        problems,
        project,
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

    addGraphProblem(problems, lines, {
      code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceDependencyUndeclared,
      filePath: project.configPath,
      fix: `Declare "${targetPackage.name}" in the referencing package manifest. If this package intentionally consumes built artifacts, remove the project reference.`,
      packageManifestPath,
      packageName: sourcePackage.name,
      reason: `A cross-package project reference is a source dependency edge, so ${sourcePackage.name} must declare ${targetPackage.name}.`,
      title:
        'Project reference crosses workspace packages without a declared dependency',
    });
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
  const components: string[][] = [];
  const indexByPath = new Map<string, number>();
  const lowLinkByPath = new Map<string, number>();
  const stack: string[] = [];
  const pathsOnStack = new Set<string>();
  let nextIndex = 0;

  function visit(configPath: string): void {
    indexByPath.set(configPath, nextIndex);
    lowLinkByPath.set(configPath, nextIndex);
    nextIndex += 1;
    stack.push(configPath);
    pathsOnStack.add(configPath);

    for (const referencePath of graph.get(configPath) ?? []) {
      if (!indexByPath.has(referencePath)) {
        visit(referencePath);
        lowLinkByPath.set(
          configPath,
          Math.min(
            lowLinkByPath.get(configPath)!,
            lowLinkByPath.get(referencePath)!,
          ),
        );
        continue;
      }

      if (pathsOnStack.has(referencePath)) {
        lowLinkByPath.set(
          configPath,
          Math.min(
            lowLinkByPath.get(configPath)!,
            indexByPath.get(referencePath)!,
          ),
        );
      }
    }

    if (lowLinkByPath.get(configPath) !== indexByPath.get(configPath)) {
      return;
    }

    const component: string[] = [];

    while (stack.length > 0) {
      const currentPath = stack.pop()!;

      pathsOnStack.delete(currentPath);
      component.push(currentPath);

      if (currentPath === configPath) {
        break;
      }
    }

    components.push(component.sort());
  }

  for (const configPath of [...graph.keys()].sort()) {
    if (!indexByPath.has(configPath)) {
      visit(configPath);
    }
  }

  return components.sort((left, right) => left[0]!.localeCompare(right[0]!));
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
  problems: string[];
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

    addGraphProblem(options.problems, lines, {
      code: LIMINA_CHECK_ISSUE_CODES.graphReferenceCycle,
      filePath: members[0],
      fix: GENERATED_REFERENCE_CYCLE_FIX,
      reason: GENERATED_REFERENCE_CYCLE_REASON,
      title: 'Generated project reference cycle',
    });
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
  generatedGraph: GeneratedTsconfigGraphResult;
  graphRules: NormalizedGraphRules;
  problems: string[];
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

      addGraphProblem(options.problems, lines, {
        code: LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing,
        filePath: project.configPath,
        fix: 'Ensure both source tsconfig files are selected by checker.include, then run `limina graph prepare`.',
        reason:
          'A static workspace import reaches a declaration project that is not listed in the source declaration references.',
        title: 'Missing project reference for workspace import',
      });
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

      addGraphProblem(options.problems, lines, {
        code: LIMINA_CHECK_ISSUE_CODES.graphReferenceExtra,
        filePath: project.configPath,
        fix: 'Remove the extra reference, import from the referenced project, or document the exception in graph.rules.<label>.allow.refs.',
        reason:
          'tsconfig*.dts.json references must match declaration leaves reached by static import/export analysis.',
        title: 'Extra project reference not proven by static imports',
      });
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
      importRecord: options.importRecord,
      problems: options.context.problems,
      project: options.project,
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
  const graphResolvedFilePath =
    declarationProvider.kind === 'declaration' ||
    declarationProvider.kind === 'source'
      ? declarationProvider.typeScriptResolution.resolvedFileName
      : workspaceTypeScriptResolvedFilePath;

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
      title: 'Unresolved workspace import:',
    });
    return null;
  }

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
      importRecord: options.importRecord,
      problems: options.context.problems,
      project: options.project,
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

  options.context.problems.push(
    [
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
      '  reason: governed source imports through package exports must resolve to a stable type or checker source entry.',
      '  fix: add a types/declaration branch for this export, import a typed public API, or keep this entry as a runtime-only resource outside governed source imports.',
    ].join('\n'),
  );
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
  title: string;
}): void {
  if (!options.targetPackage) {
    return;
  }

  options.context.problems.push(
    [
      options.title,
      `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
      `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  matched workspace package: ${options.targetPackage.name}`,
      `  current references: ${formatReferences(options.context.config.rootDir, options.project.references)}`,
    ].join('\n'),
  );
}

function addOxcOnlyDeclarationProviderProblem(options: {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  oxcResolvedFilePath: string;
  project: ProjectInfo;
}): void {
  addGraphProblem(
    options.context.problems,
    [
      'Oxc can resolve this specifier, but TypeScript cannot:',
      `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
      `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  Oxc resolved file: ${toRelativePath(options.context.config.rootDir, options.oxcResolvedFilePath)}`,
      '  reason: declaration references follow the checker-aware TypeScript declaration provider, not the Oxc runtime-like resolver.',
      '  fix: check moduleResolution, exports.types/types conditions, paths, customConditions, and package boundaries.',
    ],
    {
      code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceImportUnresolved,
      filePath: options.importRecord.filePath,
      fix: 'Check moduleResolution, exports.types/types conditions, paths, customConditions, and package boundaries.',
      reason:
        'Oxc resolved this specifier, but TypeScript could not resolve a declaration provider.',
      title: 'Oxc can resolve this specifier, but TypeScript cannot',
    },
  );
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

  options.context.problems.push(
    [
      hasProjectReference
        ? 'Referenced workspace dependency resolves through package exports to a build artifact:'
        : 'Workspace source dependency resolved outside the source graph:',
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
      '  reason: this import resolved to a file not owned by the source graph, so it is not a source project-reference edge.',
      `  fix: point the dependency package export at source files, or treat this relationship as artifact consumption; ${formatArtifactDependencyPolicy(options.resolution.targetPackageForGraph)}`,
    ].join('\n'),
  );

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

  options.context.problems.push(
    [
      'Unable to map workspace import to a graph project:',
      `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
      `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  resolved file: ${toRelativePath(options.context.config.rootDir, options.resolution.graphResolvedFilePath)}`,
      `  current references: ${formatReferences(options.context.config.rootDir, options.project.references)}`,
    ].join('\n'),
  );
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

  options.context.problems.push(
    [
      'Workspace source import resolved outside the workspace graph:',
      `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
      `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  resolved file: ${toRelativePath(options.context.config.rootDir, options.resolution.graphResolvedFilePath)}`,
      `  reason: source dependency edges must resolve to files owned by the source graph; ${formatArtifactDependencyPolicy(targetPackage)}`,
    ].join('\n'),
  );
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
      importRecord: options.importRecord,
      problems: options.context.problems,
      project: options.project,
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
    options.context.problems.push(
      [
        'Expected graph target is not reachable from any checker entry:',
        `  importing project: ${toRelativePath(options.context.config.rootDir, options.project.configPath)}`,
        `  file: ${formatImportRecordLocation(options.context.config.rootDir, options.importRecord)}`,
        `  imported specifier: ${options.importRecord.specifier}`,
        `  expected graph project: ${toRelativePath(options.context.config.rootDir, options.targetProjectPath)}`,
      ].join('\n'),
    );
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
  problems: string[];
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

    options.problems.push(...outputOptions.problems);

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
  const problems: string[] = [];
  const checks = createCheckCounter();
  const checkItems = createCheckItemAccumulator(
    () => problems.length,
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
      problems,
      projectCheckerNamesByPath,
      projects,
    }),
  );
  const packages = await preflight.ensureWorkspacePackages();

  checkItems.start('source graph routes');
  problems.push(...graphRoute.problems);
  const customConditionConsistencyContext =
    createCustomConditionConsistencyContext(projectsByPath);
  const workspaceExports = await createWorkspaceExportsResolutionIndex({
    config,
    packages,
    profiles: createWorkspaceExportsResolutionProfiles(projects),
  });

  problems.push(...workspaceExports.problems);
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
    problems,
    projectPathAliases: createGeneratedGraphPathAliases(generatedGraph),
    projectPaths,
  });
  for (const project of projects) {
    if (project.labelProblem) {
      problems.push(project.labelProblem);
    }

    addDtsOptionProblems(config, project, problems, checks);
    addTypecheckParityProblems(config, project, problems, checks);
    addDeniedReferenceProblems({
      checks,
      config,
      problems,
      project,
      projectsByPath,
      rules: graphRules,
      workspaceLookup,
    });
    addWorkspaceReferenceDependencyProblems(
      config,
      project,
      projectsByPath,
      workspaceLookup,
      problems,
      checks,
    );
  }
  addGeneratedReferenceCycleProblems({
    checks,
    config,
    problems,
    projects,
  });
  checkItems.record('project references');

  checkItems.start('condition domains');
  addDefaultCustomConditionProblems({
    checks,
    config,
    consistencyContext: customConditionConsistencyContext,
    problems,
    projects,
  });
  addConditionDomainProblems({
    checks,
    config,
    consistencyContext: customConditionConsistencyContext,
    generatedGraph,
    problems,
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
    problems,
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
    generatedGraph,
    graphRules,
    problems,
    projects,
    projectsByPath,
  });
  checkItems.record('reference completeness');

  if (problems.length > 0) {
    const issues = createGraphCheckIssues({
      config,
      problems,
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
  const graph = await collectDependencyGraph(config, {
    providers: options.providers,
    view: options.view,
  });

  if (options.outputPath) {
    await mkdir(path.dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, stringifyDependencyGraph(graph));
  }

  return graph;
}
