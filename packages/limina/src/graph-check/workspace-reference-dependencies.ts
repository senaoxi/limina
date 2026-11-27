import type { ResolvedLiminaConfig } from '#config/runner';
import {
  formatArtifactDependencyPolicy,
  isDtsProjectConfig,
  type ProjectInfo,
} from '#core/import-graph/context';
import {
  type ImporterInfo,
  isNamedWorkspacePackage,
  type WorkspacePackage,
} from '#core/workspace/actions';
import {
  isBarePackageSpecifier,
  isPackageImportSpecifier,
} from '#utils/module-specifier';
import { toRelativePath } from '#utils/path';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { readImplicitReferences } from '../core/build-graph/generated/config-readers';
import type { ReferencePackageRequest } from '../core/build-graph/types';
import { findPackageImportMatch } from '../core/packages/authority';
import { expandPackageImportTargets } from '../core/packages/import-targets';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { CheckCounter } from '../execution/stats';
import { getProjectCheckerName } from './finding-utilities';
import type {
  GraphFinding,
  GraphWorkspaceDependencyUndeclaredFinding,
  GraphWorkspacePackageNameMissingFinding,
} from './findings';
import type { ReferenceExpectation } from './reference-types';

interface WorkspaceReferenceContext {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  importer: ImporterInfo | null;
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  projectsByPath: Map<string, ProjectInfo>;
  sourcePackage: WorkspacePackage;
  workspaceLookup: WorkspaceLookupIndex;
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
  const detailLines = [
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
      { filePath: options.project.configPath, label: 'referencing project' },
      { filePath: options.referencePath, label: 'referenced project' },
      {
        label: `${options.packageRole} package`,
        packageManifestPath,
      },
    ],
    packageManifestPath,
    presentation: {
      detailLines,
      fix: 'Add a non-empty package.json name when this workspace package should participate in package dependency graph checks.',
      reason:
        'Cross-package graph references need non-empty package.json names so Limina can validate dependency identity.',
      title:
        'Project reference crosses workspace package without package identity',
    },
    task: 'graph:check',
  } satisfies GraphWorkspacePackageNameMissingFinding);
}

function getTargetPackage(
  context: WorkspaceReferenceContext,
  referencePath: string,
): WorkspacePackage | null {
  const referencedProject = context.projectsByPath.get(referencePath);
  return referencedProject === undefined
    ? null
    : context.workspaceLookup.findGovernedPackageScopeInfo(
        referencedProject.resolverConfigPath,
      );
}

function isCrossPackageTarget(
  sourcePackage: WorkspacePackage,
  targetPackage: WorkspacePackage | null,
): targetPackage is WorkspacePackage {
  return Boolean(
    targetPackage && targetPackage.directory !== sourcePackage.directory,
  );
}

function isAddNameProblemIfNeeded(
  context: WorkspaceReferenceContext,
  targetPackage: WorkspacePackage,
  referencePath: string,
): boolean {
  if (!isNamedWorkspacePackage(context.sourcePackage)) {
    addNamelessWorkspaceReferenceProblem({
      config: context.config,
      findings: context.findings,
      packageRole: 'referencing',
      project: context.project,
      projectCheckerNamesByPath: context.projectCheckerNamesByPath,
      referencePath,
      workspacePackage: context.sourcePackage,
    });
    return true;
  }

  if (!isNamedWorkspacePackage(targetPackage)) {
    addNamelessWorkspaceReferenceProblem({
      config: context.config,
      findings: context.findings,
      packageRole: 'referenced',
      project: context.project,
      projectCheckerNamesByPath: context.projectCheckerNamesByPath,
      referencePath,
      workspacePackage: targetPackage,
    });
    return true;
  }

  return false;
}

function addUndeclaredDependencyFinding(options: {
  context: WorkspaceReferenceContext;
  referencePath: string;
  targetPackage: WorkspacePackage & { name: string };
}): void {
  const sourcePackage = options.context.sourcePackage as WorkspacePackage & {
    name: string;
  };
  const packageManifestPath = path.join(
    sourcePackage.directory,
    'package.json',
  );
  const detailLines = [
    'Project reference crosses workspace packages without a declared dependency:',
    `  referencing project: ${toRelativePath(options.context.config.rootDir, options.context.project.configPath)}`,
    `  referenced project: ${toRelativePath(options.context.config.rootDir, options.referencePath)}`,
    `  referencing package: ${sourcePackage.name}`,
    `  referenced package: ${options.targetPackage.name}`,
    `  package manifest: ${toRelativePath(options.context.config.rootDir, packageManifestPath)}`,
    `  reason: this reference has a package-name request or an explicit implicitRefs entry, so ${sourcePackage.name} must declare ${options.targetPackage.name} in dependencies, devDependencies, peerDependencies, or optionalDependencies.`,
    `  fix: declare "${options.targetPackage.name}" in the referencing package manifest. If this package intentionally consumes built artifacts, remove the project reference; ${formatArtifactDependencyPolicy(options.targetPackage)}`,
  ];

  options.context.findings.push({
    checkerName: getProjectCheckerName(
      options.context.projectCheckerNamesByPath,
      options.context.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphWorkspaceDependencyUndeclared,
    evidence: [
      { label: 'referenced package', value: options.targetPackage.name },
      { label: 'package manifest', value: packageManifestPath },
    ],
    facts: {
      packageManifestPath,
      referencedPackageName: options.targetPackage.name,
      referencedProjectPath: options.referencePath,
      referencingPackageName: sourcePackage.name,
      referencingProjectPath: options.context.project.configPath,
    },
    filePath: options.context.project.configPath,
    locations: [
      {
        filePath: options.context.project.configPath,
        label: 'referencing project',
      },
      { filePath: options.referencePath, label: 'referenced project' },
      { label: 'referencing package', packageManifestPath },
    ],
    packageManifestPath,
    packageName: sourcePackage.name,
    presentation: {
      detailLines,
      fix: `Declare "${options.targetPackage.name}" in the referencing package manifest. If this package intentionally consumes built artifacts, remove the project reference.`,
      reason: `This reference has a package-name request or an explicit implicitRefs entry, so ${sourcePackage.name} must declare ${options.targetPackage.name}.`,
      title:
        'Project reference crosses workspace packages without a declared dependency',
    },
    task: 'graph:check',
  } satisfies GraphWorkspaceDependencyUndeclaredFinding);
}

function addDependencyProblemIfNeeded(
  context: WorkspaceReferenceContext,
  targetPackage: WorkspacePackage & { name: string },
  referencePath: string,
): void {
  if (context.importer?.declaredWorkspaceDependencies.has(targetPackage.name)) {
    return;
  }

  addUndeclaredDependencyFinding({ context, referencePath, targetPackage });
}

function checkWorkspaceReference(
  context: WorkspaceReferenceContext,
  referencePath: string,
): void {
  context.checks.add();
  const targetPackage = getTargetPackage(context, referencePath);
  if (
    !isCrossPackageTarget(context.sourcePackage, targetPackage) ||
    isAddNameProblemIfNeeded(context, targetPackage, referencePath)
  ) {
    return;
  }

  addDependencyProblemIfNeeded(
    context,
    targetPackage as WorkspacePackage & { name: string },
    referencePath,
  );
}

function createWorkspaceReferenceContext(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  projectsByPath: Map<string, ProjectInfo>;
  workspaceLookup: WorkspaceLookupIndex;
}): WorkspaceReferenceContext | null {
  if (!isDtsProjectConfig(options.project.configPath)) {
    return null;
  }

  const sourcePackage = options.workspaceLookup.findGovernedPackageScopeInfo(
    options.project.resolverConfigPath,
  );
  if (!sourcePackage) {
    return null;
  }

  return {
    ...options,
    importer: options.workspaceLookup.findImporterForFile(
      options.project.resolverConfigPath,
    ),
    sourcePackage,
  };
}

function requiresPackageName(
  workspace: WorkspaceLookupIndex,
  file: string,
  specifier: string,
): boolean {
  if (isBarePackageSpecifier(specifier)) return true;
  if (!isPackageImportSpecifier(specifier)) return false;
  const manifest = workspace.findGovernedPackageScopeInfo(file)?.manifest;
  const match = findPackageImportMatch(manifest?.imports, specifier);
  return match
    ? expandPackageImportTargets(match.value, match.key, specifier).some(
        (target) =>
          typeof target === 'string' && isBarePackageSpecifier(target),
      )
    : false;
}

export function referencePackageTargets(
  requests: readonly ReferencePackageRequest[],
  workspace: WorkspaceLookupIndex,
): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  for (const request of requests) {
    if (!requiresPackageName(workspace, request.file, request.specifier))
      continue;
    const providers = targets.get(request.consumerProject) ?? new Set<string>();
    providers.add(request.providerProject);
    targets.set(request.consumerProject, providers);
  }
  return targets;
}

export function addWorkspaceReferenceDependencyProblems(options: {
  expected?: ReadonlyMap<string, ReferenceExpectation>;
  packageTargets?: ReadonlySet<string>;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  projectsByPath: Map<string, ProjectInfo>;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const context = createWorkspaceReferenceContext(options);
  if (!context) {
    return;
  }
  const explicit = new Set(
    readImplicitReferences(
      options.config,
      options.project.resolverConfigPath,
    ).implicitRefs.map((reference) => reference.targetConfigPath),
  );
  for (const referencePath of options.project.references) {
    const source =
      options.projectsByPath.get(referencePath)?.resolverConfigPath;
    const imports = options.expected?.get(referencePath)?.importRecords ?? [];
    if (
      (source !== undefined && explicit.has(source)) ||
      options.packageTargets?.has(referencePath) ||
      imports.some(
        (request) =>
          request.kind !== 'triple-slash-path' &&
          requiresPackageName(
            options.workspaceLookup,
            request.filePath,
            request.specifier,
          ),
      )
    )
      checkWorkspaceReference(context, referencePath);
  }
}
