import { createElapsedTimer } from 'logaria/helper';
import { existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { getCheckerAdapter, normalizeExtensions } from '../checkers';
import {
  getActiveCheckerExtensions,
  type ResolvedLiminaConfig,
} from '../config';
import type { LiminaFlowReporter } from '../flow';
import {
  collectImportsFromFile,
  createFileOwnerLookup,
  findImporterForFile,
  findPackageForFile,
  findTargetProject,
  formatArtifactDependencyPolicy,
  getTypecheckConfigPath,
  inferPackageProject,
  isDtsProjectConfig,
  isRelativeSpecifier,
  parseProject,
  resolveInternalImport,
  shouldResolveThroughGraph,
  type ImportRecord,
  type ProjectInfo,
} from '../graph-context';
import {
  getDeniedDepRuleForPackage,
  getDeniedDepRuleForSpecifier,
  getDeniedRefRule,
  normalizeGraphRules,
  type GraphRuleDepDeny,
  type GraphRuleRefDeny,
  type NormalizedGraphRules,
} from '../graph-rules';
import { GraphLogger, clearCliScreen, formatErrorMessage } from '../logger';
import {
  collectOrdinaryTypecheckConfigPaths,
  collectSourceGraphProjectExtensions,
  formatReferences,
} from '../tsconfig';
import { isPathInsideDirectory, toRelativePath } from '../utils/path';
import {
  collectImporters,
  collectPackageOwners,
  collectWorkspacePackages,
  findPackageForSpecifier,
  type ImporterInfo,
  type PackageManifest,
  type PackageOwner,
  type WorkspacePackage,
} from '../workspace';

export interface RunGraphCheckOptions {
  clearScreen?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
}

const requiredDtsCompilerOptions: [keyof ts.CompilerOptions, unknown][] = [
  ['composite', true],
  ['incremental', true],
  ['noEmit', false],
  ['declaration', true],
  ['emitDeclarationOnly', true],
];

const requiredDtsPathOptions: (keyof ts.CompilerOptions)[] = [
  'rootDir',
  'outDir',
  'tsBuildInfoFile',
];

const comparableTypecheckOptions: (keyof ts.CompilerOptions)[] = [
  'allowArbitraryExtensions',
  'allowImportingTsExtensions',
  'allowJs',
  'allowSyntheticDefaultImports',
  'checkJs',
  'customConditions',
  'esModuleInterop',
  'exactOptionalPropertyTypes',
  'forceConsistentCasingInFileNames',
  'isolatedDeclarations',
  'isolatedModules',
  'jsx',
  'jsxImportSource',
  'lib',
  'module',
  'moduleDetection',
  'moduleResolution',
  'noFallthroughCasesInSwitch',
  'noImplicitAny',
  'noImplicitOverride',
  'noImplicitReturns',
  'noImplicitThis',
  'noPropertyAccessFromIndexSignature',
  'noUncheckedIndexedAccess',
  'resolveJsonModule',
  'skipLibCheck',
  'strict',
  'strictBindCallApply',
  'strictFunctionTypes',
  'strictNullChecks',
  'strictPropertyInitialization',
  'target',
  'typeRoots',
  'types',
  'useDefineForClassFields',
  'verbatimModuleSyntax',
];

function formatCompilerOptionValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  return JSON.stringify(value);
}

function compilerOptionEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type DependencySectionName =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies'
  | 'peerDependencies';

interface WorkspaceDependencyDeclaration {
  dependencyName: string;
  importer: WorkspacePackage;
  packageJsonPath: string;
  sectionName: DependencySectionName;
  specifier: string;
}

const dependencySectionNames: DependencySectionName[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

const typeScriptCheckerExtensions =
  getCheckerAdapter('tsc')?.defaultExtensions ?? [];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatUnknownValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  return JSON.stringify(value);
}

function createWorkspaceDependencyKey(
  importerName: string,
  dependencyName: string,
): string {
  return `${importerName}\0${dependencyName}`;
}

function getWorkspacePackageJsonPath(
  workspacePackage: WorkspacePackage,
): string {
  return path.join(workspacePackage.directory, 'package.json');
}

function findOwnerForPath(
  filePath: string,
  owners: PackageOwner[],
): PackageOwner | null {
  return (
    owners.find((owner) => isPathInsideDirectory(filePath, owner.directory)) ??
    null
  );
}

function getDependencySection(
  manifest: PackageManifest,
  sectionName: DependencySectionName,
): Record<string, string> | null {
  const section = manifest[sectionName];

  if (!isPlainRecord(section)) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(section).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string';
    }),
  );
}

function collectWorkspaceDependencyDeclarations(
  workspacePackages: WorkspacePackage[],
): WorkspaceDependencyDeclaration[] {
  const workspacePackageNames = new Set(
    workspacePackages.map((workspacePackage) => workspacePackage.name),
  );
  const declarations: WorkspaceDependencyDeclaration[] = [];

  for (const importer of workspacePackages) {
    for (const sectionName of dependencySectionNames) {
      const section = getDependencySection(importer.manifest, sectionName);

      if (!section) {
        continue;
      }

      for (const [dependencyName, specifier] of Object.entries(section)) {
        if (
          dependencyName === importer.name ||
          !workspacePackageNames.has(dependencyName)
        ) {
          continue;
        }

        declarations.push({
          dependencyName,
          importer,
          packageJsonPath: getWorkspacePackageJsonPath(importer),
          sectionName,
          specifier,
        });
      }
    }
  }

  return declarations.sort((left, right) => {
    if (left.packageJsonPath !== right.packageJsonPath) {
      return left.packageJsonPath.localeCompare(right.packageJsonPath);
    }

    if (left.dependencyName !== right.dependencyName) {
      return left.dependencyName.localeCompare(right.dependencyName);
    }

    return left.sectionName.localeCompare(right.sectionName);
  });
}

function collectUnusedWorkspaceDependencyAllowlist(options: {
  config: ResolvedLiminaConfig;
  declarations: WorkspaceDependencyDeclaration[];
  problems: string[];
  workspacePackages: WorkspacePackage[];
}): Set<string> {
  const allowedKeys = new Set<string>();
  const rawConfig = options.config.graph?.unusedWorkspaceDependencies;

  if (rawConfig === undefined) {
    return allowedKeys;
  }

  if (!isPlainRecord(rawConfig)) {
    options.problems.push(
      [
        'Invalid unused workspace dependency config:',
        '  field: graph.unusedWorkspaceDependencies',
        `  value: ${formatUnknownValue(rawConfig)}`,
        '  reason: graph.unusedWorkspaceDependencies must be an object.',
      ].join('\n'),
    );
    return allowedKeys;
  }

  const rawAllowlist = rawConfig.allowlist;

  if (rawAllowlist === undefined) {
    return allowedKeys;
  }

  if (!Array.isArray(rawAllowlist)) {
    options.problems.push(
      [
        'Invalid unused workspace dependency allowlist config:',
        '  field: graph.unusedWorkspaceDependencies.allowlist',
        `  value: ${formatUnknownValue(rawAllowlist)}`,
        '  reason: allowlist must be an array.',
      ].join('\n'),
    );
    return allowedKeys;
  }

  const workspacePackageNames = new Set(
    options.workspacePackages.map((workspacePackage) => workspacePackage.name),
  );
  const declarationKeys = new Set(
    options.declarations.map((declaration) =>
      createWorkspaceDependencyKey(
        declaration.importer.name,
        declaration.dependencyName,
      ),
    ),
  );

  rawAllowlist.forEach((entry, index) => {
    const field = `graph.unusedWorkspaceDependencies.allowlist[${index}]`;

    if (!isPlainRecord(entry)) {
      options.problems.push(
        [
          'Invalid unused workspace dependency allowlist config:',
          `  field: ${field}`,
          `  value: ${formatUnknownValue(entry)}`,
          '  reason: allowlist entries must be objects with non-empty importer, dependency, and reason fields.',
        ].join('\n'),
      );
      return;
    }

    const importerValue = entry.importer;
    const dependencyValue = entry.dependency;
    const reasonValue = entry.reason;

    if (
      typeof importerValue !== 'string' ||
      importerValue.trim().length === 0
    ) {
      options.problems.push(
        [
          'Invalid unused workspace dependency allowlist config:',
          `  field: ${field}.importer`,
          `  value: ${formatUnknownValue(importerValue)}`,
          '  reason: importer must be a non-empty workspace package name.',
        ].join('\n'),
      );
      return;
    }

    if (
      typeof dependencyValue !== 'string' ||
      dependencyValue.trim().length === 0
    ) {
      options.problems.push(
        [
          'Invalid unused workspace dependency allowlist config:',
          `  field: ${field}.dependency`,
          `  value: ${formatUnknownValue(dependencyValue)}`,
          '  reason: dependency must be a non-empty workspace package name.',
        ].join('\n'),
      );
      return;
    }

    if (typeof reasonValue !== 'string' || reasonValue.trim().length === 0) {
      options.problems.push(
        [
          'Invalid unused workspace dependency allowlist config:',
          `  field: ${field}.reason`,
          `  value: ${formatUnknownValue(reasonValue)}`,
          '  reason: reason must be a non-empty string.',
        ].join('\n'),
      );
      return;
    }

    const importerName = importerValue.trim();
    const dependencyName = dependencyValue.trim();
    const dependencyKey = createWorkspaceDependencyKey(
      importerName,
      dependencyName,
    );

    if (!workspacePackageNames.has(importerName)) {
      options.problems.push(
        [
          'Invalid unused workspace dependency allowlist config:',
          `  field: ${field}.importer`,
          `  importer: ${importerName}`,
          '  reason: importer must name a package from the pnpm workspace.',
        ].join('\n'),
      );
      return;
    }

    if (!workspacePackageNames.has(dependencyName)) {
      options.problems.push(
        [
          'Invalid unused workspace dependency allowlist config:',
          `  field: ${field}.dependency`,
          `  dependency: ${dependencyName}`,
          '  reason: dependency must name a package from the pnpm workspace.',
        ].join('\n'),
      );
      return;
    }

    if (!declarationKeys.has(dependencyKey)) {
      options.problems.push(
        [
          'Invalid unused workspace dependency allowlist config:',
          `  field: ${field}`,
          `  importer: ${importerName}`,
          `  dependency: ${dependencyName}`,
          '  reason: allowlist entries must match a workspace dependency declared by the importer package manifest.',
        ].join('\n'),
      );
      return;
    }

    allowedKeys.add(dependencyKey);
  });

  return allowedKeys;
}

function getUsageSourceExtensions(config: ResolvedLiminaConfig): string[] {
  return normalizeExtensions([
    ...typeScriptCheckerExtensions,
    ...getActiveCheckerExtensions(config),
  ]);
}

async function collectUsedWorkspaceDependencies(options: {
  config: ResolvedLiminaConfig;
  packageOwners: PackageOwner[];
  problems: string[];
  workspacePackages: WorkspacePackage[];
}): Promise<Map<string, Set<string>>> {
  const usageByImporterName = new Map<string, Set<string>>();
  const workspacePackageNames = new Set(
    options.workspacePackages.map((workspacePackage) => workspacePackage.name),
  );
  const workspacePackagesByPackageJsonPath = new Map(
    options.workspacePackages.map((workspacePackage) => [
      getWorkspacePackageJsonPath(workspacePackage),
      workspacePackage,
    ]),
  );
  const sourceExtensions = getUsageSourceExtensions(options.config);
  const configPaths = await collectOrdinaryTypecheckConfigPaths(options.config);

  for (const configPath of configPaths) {
    const owner = findOwnerForPath(configPath, options.packageOwners);

    if (!owner) {
      options.problems.push(
        [
          'Tsconfig has no package owner:',
          `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
          '  reason: workspace dependency usage analysis assigns each tsconfig*.json to its nearest package.json.',
        ].join('\n'),
      );
      continue;
    }

    const ownerWorkspacePackage = workspacePackagesByPackageJsonPath.get(
      owner.packageJsonPath,
    );
    const project = parseProject(options.config, configPath, sourceExtensions);

    for (const filePath of project.fileNames) {
      const fileOwner = findOwnerForPath(filePath, options.packageOwners);

      if (fileOwner?.packageJsonPath !== owner.packageJsonPath) {
        options.problems.push(
          [
            'Tsconfig source file set crosses package owner scope:',
            `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
            `  package owner: ${toRelativePath(options.config.rootDir, owner.packageJsonPath)}`,
            `  file: ${toRelativePath(options.config.rootDir, filePath)}`,
            ...(fileOwner
              ? [
                  `  file owner: ${toRelativePath(options.config.rootDir, fileOwner.packageJsonPath)}`,
                ]
              : []),
            '  reason: each usage tsconfig must only include files owned by its nearest package.json.',
            '  fix: narrow the tsconfig include/files set or move the file under the owning package config.',
          ].join('\n'),
        );
        continue;
      }

      if (!ownerWorkspacePackage) {
        continue;
      }

      const usedDependencyNames =
        usageByImporterName.get(ownerWorkspacePackage.name) ??
        new Set<string>();

      for (const importRecord of collectImportsFromFile(
        filePath,
        options.config.rootDir,
      )) {
        const targetPackage = findPackageForSpecifier(
          importRecord.specifier,
          options.workspacePackages,
        );

        if (
          !targetPackage ||
          targetPackage.name === ownerWorkspacePackage.name ||
          !workspacePackageNames.has(targetPackage.name)
        ) {
          continue;
        }

        usedDependencyNames.add(targetPackage.name);
      }

      usageByImporterName.set(ownerWorkspacePackage.name, usedDependencyNames);
    }
  }

  return usageByImporterName;
}

async function addUnusedWorkspaceDependencyProblems(options: {
  config: ResolvedLiminaConfig;
  packageOwners: PackageOwner[];
  problems: string[];
  workspacePackages: WorkspacePackage[];
}): Promise<void> {
  if (options.workspacePackages.length === 0) {
    return;
  }

  const declarations = collectWorkspaceDependencyDeclarations(
    options.workspacePackages,
  );

  if (declarations.length === 0) {
    return;
  }

  const allowlist = collectUnusedWorkspaceDependencyAllowlist({
    config: options.config,
    declarations,
    problems: options.problems,
    workspacePackages: options.workspacePackages,
  });
  const usedDependenciesByImporterName = await collectUsedWorkspaceDependencies(
    {
      config: options.config,
      packageOwners: options.packageOwners,
      problems: options.problems,
      workspacePackages: options.workspacePackages,
    },
  );

  for (const declaration of declarations) {
    const dependencyKey = createWorkspaceDependencyKey(
      declaration.importer.name,
      declaration.dependencyName,
    );

    if (allowlist.has(dependencyKey)) {
      continue;
    }

    if (
      usedDependenciesByImporterName
        .get(declaration.importer.name)
        ?.has(declaration.dependencyName)
    ) {
      continue;
    }

    options.problems.push(
      [
        'Unused workspace package dependency:',
        `  importer: ${declaration.importer.name}`,
        `  package manifest: ${toRelativePath(options.config.rootDir, declaration.packageJsonPath)}`,
        `  dependency: ${declaration.dependencyName}`,
        `  section: ${declaration.sectionName}`,
        `  specifier: ${declaration.specifier}`,
        '  reason: workspace package dependencies should be used by source owned by the importer package, or explicitly allowlisted when usage is not visible to static import analysis.',
        `  fix: remove ${declaration.dependencyName} from ${declaration.sectionName}, import it from source owned by ${declaration.importer.name}, or add graph.unusedWorkspaceDependencies.allowlist with importer "${declaration.importer.name}", dependency "${declaration.dependencyName}", and a reason.`,
      ].join('\n'),
    );
  }
}

function addDtsOptionProblems(
  config: ResolvedLiminaConfig,
  project: ProjectInfo,
  problems: string[],
): void {
  if (!isDtsProjectConfig(project.configPath)) {
    return;
  }

  for (const [optionName, expected] of requiredDtsCompilerOptions) {
    const actual = project.options[optionName];

    if (actual === expected) {
      continue;
    }

    problems.push(
      [
        'Invalid declaration leaf compiler option:',
        `  project: ${toRelativePath(config.rootDir, project.configPath)}`,
        `  option: compilerOptions.${optionName}`,
        `  expected: ${formatCompilerOptionValue(expected)}`,
        `  actual: ${formatCompilerOptionValue(actual)}`,
        '  reason: tsconfig*.dts.json projects are consumed by tsc -b and must emit declarations through composite incremental builds.',
      ].join('\n'),
    );
  }

  for (const optionName of requiredDtsPathOptions) {
    if (project.options[optionName]) {
      continue;
    }

    problems.push(
      [
        'Missing declaration leaf output option:',
        `  project: ${toRelativePath(config.rootDir, project.configPath)}`,
        `  option: compilerOptions.${optionName}`,
        '  reason: declaration leaves need explicit root/output state so declaration output and tsbuildinfo files do not collide.',
      ].join('\n'),
    );
  }
}

function addTypecheckParityProblems(
  config: ResolvedLiminaConfig,
  dtsProject: ProjectInfo,
  problems: string[],
): void {
  if (!isDtsProjectConfig(dtsProject.configPath)) {
    return;
  }

  const typecheckConfigPath = getTypecheckConfigPath(dtsProject.configPath);

  if (!existsSync(typecheckConfigPath)) {
    problems.push(
      [
        'Missing typecheck companion config:',
        `  declaration leaf: ${toRelativePath(config.rootDir, dtsProject.configPath)}`,
        `  expected typecheck config: ${toRelativePath(config.rootDir, typecheckConfigPath)}`,
        '  reason: every tsconfig*.dts.json project should have a matching tsconfig*.json file with the same typechecking semantics.',
      ].join('\n'),
    );
    return;
  }

  const typecheckProject = parseProject(
    config,
    typecheckConfigPath,
    dtsProject.extensions,
  );

  for (const optionName of comparableTypecheckOptions) {
    const buildValue = dtsProject.options[optionName];
    const typecheckValue = typecheckProject.options[optionName];

    if (compilerOptionEquals(buildValue, typecheckValue)) {
      continue;
    }

    problems.push(
      [
        'Typecheck option mismatch between declaration leaf and companion config:',
        `  declaration leaf: ${toRelativePath(config.rootDir, dtsProject.configPath)}`,
        `  typecheck config: ${toRelativePath(config.rootDir, typecheckConfigPath)}`,
        `  option: compilerOptions.${optionName}`,
        `  declaration value: ${formatCompilerOptionValue(buildValue)}`,
        `  typecheck value: ${formatCompilerOptionValue(typecheckValue)}`,
        '  reason: tsconfig*.dts.json should emit with the same typechecking semantics as its matching tsconfig*.json companion.',
      ].join('\n'),
    );
  }

  const typecheckFiles = new Set(typecheckProject.fileNames);
  const missingFiles = dtsProject.fileNames.filter(
    (fileName) => !typecheckFiles.has(fileName),
  );

  if (missingFiles.length === 0) {
    return;
  }

  problems.push(
    [
      'Declaration leaf includes files missing from its companion typecheck config:',
      `  declaration leaf: ${toRelativePath(config.rootDir, dtsProject.configPath)}`,
      `  typecheck config: ${toRelativePath(config.rootDir, typecheckConfigPath)}`,
      '  files:',
      ...missingFiles
        .slice(0, 10)
        .map((fileName) => `    - ${toRelativePath(config.rootDir, fileName)}`),
      ...(missingFiles.length > 10
        ? [`    ...and ${missingFiles.length - 10} more`]
        : []),
      '  reason: a declaration leaf must not emit declarations for files that are not covered by the matching typecheck target.',
    ].join('\n'),
  );
}

function addDeniedReferenceProblems(options: {
  config: ResolvedLiminaConfig;
  packages: WorkspacePackage[];
  problems: string[];
  project: ProjectInfo;
  projectsByPath: Map<string, ProjectInfo>;
  rules: NormalizedGraphRules;
}): void {
  if (!options.project.label) {
    return;
  }

  for (const referencePath of options.project.references) {
    if (!options.projectsByPath.has(referencePath)) {
      continue;
    }

    const deniedRefRule = getDeniedRefRule(
      options.rules,
      options.project.label,
      referencePath,
    );
    const targetPackage = findPackageForFile(referencePath, options.packages);
    const deniedDepRule = targetPackage
      ? getDeniedDepRuleForPackage(
          options.rules,
          options.project.label,
          targetPackage.name,
        )
      : null;

    if (!deniedRefRule && !deniedDepRule) {
      continue;
    }

    const lines = [
      'Denied graph access:',
      `  rule: ${options.project.label}`,
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

    options.problems.push(lines.join('\n'));
  }
}

function addDeniedDepImportProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  project: ProjectInfo;
  problems: string[];
  rule: GraphRuleDepDeny;
}): void {
  options.problems.push(
    [
      'Denied graph access:',
      `  rule: ${options.project.label}`,
      `  importing project: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
      `  file: ${toRelativePath(options.config.rootDir, options.importRecord.filePath)}:${options.importRecord.line}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  denied dependency: ${options.rule.name}`,
      `  reason: ${options.rule.reason}`,
    ].join('\n'),
  );
}

function addDeniedRefImportProblem(options: {
  config: ResolvedLiminaConfig;
  importRecord: ImportRecord;
  project: ProjectInfo;
  problems: string[];
  rule: GraphRuleRefDeny;
  targetProjectPath: string;
}): void {
  options.problems.push(
    [
      'Denied graph access:',
      `  rule: ${options.project.label}`,
      `  importing project: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
      `  file: ${toRelativePath(options.config.rootDir, options.importRecord.filePath)}:${options.importRecord.line}`,
      `  imported specifier: ${options.importRecord.specifier}`,
      `  target project: ${toRelativePath(options.config.rootDir, options.targetProjectPath)}`,
      `  denied ref: ${toRelativePath(options.config.rootDir, options.rule.path)}`,
      `  reason: ${options.rule.reason}`,
    ].join('\n'),
  );
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
  packages: WorkspacePackage[],
): string | null {
  return (
    getNodeModulesPackageName(filePath) ??
    findPackageForFile(filePath, packages)?.name ??
    null
  );
}

function getResolvedWorkspacePackage(
  filePath: string,
  packages: WorkspacePackage[],
): WorkspacePackage | null {
  if (getNodeModulesPackageName(filePath)) {
    return null;
  }

  return findPackageForFile(filePath, packages);
}

function addWorkspaceReferenceDependencyProblems(
  config: ResolvedLiminaConfig,
  project: ProjectInfo,
  projectsByPath: Map<string, ProjectInfo>,
  packages: WorkspacePackage[],
  importers: ImporterInfo[],
  problems: string[],
): void {
  if (!isDtsProjectConfig(project.configPath)) {
    return;
  }

  const sourcePackage = findPackageForFile(project.configPath, packages);
  const importer = sourcePackage
    ? findImporterForFile(project.configPath, importers)
    : null;

  if (!sourcePackage) {
    return;
  }

  for (const referencePath of project.references) {
    if (!projectsByPath.has(referencePath)) {
      continue;
    }

    const targetPackage = findPackageForFile(referencePath, packages);

    if (!targetPackage || targetPackage.name === sourcePackage.name) {
      continue;
    }

    if (importer?.workspaceDependencies.has(targetPackage.name)) {
      continue;
    }

    problems.push(
      [
        'Project reference crosses workspace packages without a workspace:* dependency:',
        `  referencing project: ${toRelativePath(config.rootDir, project.configPath)}`,
        `  referenced project: ${toRelativePath(config.rootDir, referencePath)}`,
        `  referencing package: ${sourcePackage.name}`,
        `  referenced package: ${targetPackage.name}`,
        `  package manifest: ${toRelativePath(config.rootDir, path.join(sourcePackage.directory, 'package.json'))}`,
        `  reason: a cross-package tsconfig*.dts.json reference is a source dependency edge, so ${sourcePackage.name} must declare ${targetPackage.name} with the workspace: protocol.`,
        `  fix: add "${targetPackage.name}": "workspace:*" to dependencies, devDependencies, peerDependencies, or optionalDependencies in the referencing package manifest. If this package intentionally consumes built artifacts, remove the project reference; ${formatArtifactDependencyPolicy(targetPackage)}`,
      ].join('\n'),
    );
  }
}

async function runGraphCheckInternal(
  config: ResolvedLiminaConfig,
  options: { logSuccess?: boolean } = {},
): Promise<boolean> {
  const graphRoute = collectSourceGraphProjectExtensions(config);
  const projectPaths = [...graphRoute.projectExtensionsByPath.keys()].sort();
  const projects = projectPaths.map((projectPath) =>
    parseProject(
      config,
      projectPath,
      graphRoute.projectExtensionsByPath.get(projectPath),
    ),
  );
  const projectsByPath = new Map(
    projects.map((project) => [project.configPath, project]),
  );
  const fileOwnerLookup = createFileOwnerLookup(projects);
  const packages = await collectWorkspacePackages(config);
  const packageOwners = await collectPackageOwners(config);
  const importers = collectImporters(config, packages);
  const problems: string[] = [...graphRoute.problems];
  const graphRules = normalizeGraphRules({
    config,
    include: {
      deps: true,
      refs: true,
    },
    packages,
    problems,
    projectPaths,
  });

  await addUnusedWorkspaceDependencyProblems({
    config,
    packageOwners,
    problems,
    workspacePackages: packages,
  });

  for (const project of projects) {
    if (project.labelProblem) {
      problems.push(project.labelProblem);
    }

    addDtsOptionProblems(config, project, problems);
    addTypecheckParityProblems(config, project, problems);
    addDeniedReferenceProblems({
      config,
      packages,
      problems,
      project,
      projectsByPath,
      rules: graphRules,
    });
    addWorkspaceReferenceDependencyProblems(
      config,
      project,
      projectsByPath,
      packages,
      importers,
      problems,
    );

    for (const filePath of project.fileNames) {
      for (const importRecord of collectImportsFromFile(
        filePath,
        config.rootDir,
      )) {
        const rawDeniedDepRule = getDeniedDepRuleForSpecifier(
          graphRules,
          project.label,
          importRecord.specifier,
        );

        if (rawDeniedDepRule) {
          addDeniedDepImportProblem({
            config,
            importRecord,
            problems,
            project,
            rule: rawDeniedDepRule,
          });
          continue;
        }

        const resolvedFilePath = resolveInternalImport(
          importRecord.specifier,
          filePath,
          project.options,
          project.extensions,
        );
        const targetPackage = findPackageForSpecifier(
          importRecord.specifier,
          packages,
        );
        const importer = findImporterForFile(importRecord.filePath, importers);

        if (!resolvedFilePath) {
          if (!targetPackage) {
            continue;
          }

          problems.push(
            [
              'Unresolved workspace import:',
              `  importing project: ${toRelativePath(config.rootDir, project.configPath)}`,
              `  file: ${toRelativePath(config.rootDir, importRecord.filePath)}:${importRecord.line}`,
              `  imported specifier: ${importRecord.specifier}`,
              `  matched workspace package: ${targetPackage.name}`,
              `  current references: ${formatReferences(config.rootDir, project.references)}`,
            ].join('\n'),
          );
          continue;
        }

        const targetWorkspacePackageForResolved = getResolvedWorkspacePackage(
          resolvedFilePath,
          packages,
        );
        const targetPackageForGraph = targetPackage;
        const resolvedPackageName = getResolvedPackageName(
          resolvedFilePath,
          packages,
        );
        const deniedDepRule = resolvedPackageName
          ? getDeniedDepRuleForPackage(
              graphRules,
              project.label,
              resolvedPackageName,
            )
          : null;

        if (deniedDepRule) {
          addDeniedDepImportProblem({
            config,
            importRecord,
            problems,
            project,
            rule: deniedDepRule,
          });
          continue;
        }

        if (isRelativeSpecifier(importRecord.specifier)) {
          const sourcePackage = findPackageForFile(
            importRecord.filePath,
            packages,
          );

          if (
            sourcePackage &&
            targetWorkspacePackageForResolved &&
            sourcePackage.name !== targetWorkspacePackageForResolved.name
          ) {
            problems.push(
              [
                'Cross-package relative import:',
                `  importing project: ${toRelativePath(config.rootDir, project.configPath)}`,
                `  file: ${toRelativePath(config.rootDir, importRecord.filePath)}:${importRecord.line}`,
                `  imported specifier: ${importRecord.specifier}`,
                `  source package: ${sourcePackage.name}`,
                `  target package: ${targetWorkspacePackageForResolved.name}`,
                `  resolved file: ${toRelativePath(config.rootDir, resolvedFilePath)}`,
                '  reason: workspace packages must depend through package exports.',
              ].join('\n'),
            );
            continue;
          }
        }

        if (
          targetPackageForGraph &&
          shouldResolveThroughGraph(importer, targetPackageForGraph) &&
          !fileOwnerLookup.has(resolvedFilePath)
        ) {
          const referencedProjectPath = inferPackageProject(
            resolvedFilePath,
            targetPackageForGraph,
            projectPaths,
          );
          const hasProjectReference =
            referencedProjectPath &&
            project.references.has(referencedProjectPath);

          problems.push(
            [
              hasProjectReference
                ? 'Referenced workspace dependency resolves through package exports to a build artifact:'
                : 'Workspace source dependency resolved outside the source graph:',
              `  importing project: ${toRelativePath(config.rootDir, project.configPath)}`,
              ...(referencedProjectPath
                ? [
                    `  referenced project: ${toRelativePath(config.rootDir, referencedProjectPath)}`,
                    `  project reference present: ${hasProjectReference ? 'yes' : 'no'}`,
                  ]
                : []),
              `  file: ${toRelativePath(config.rootDir, importRecord.filePath)}:${importRecord.line}`,
              `  imported specifier: ${importRecord.specifier}`,
              `  resolved file: ${toRelativePath(config.rootDir, resolvedFilePath)}`,
              '  reason: workspace:* dependencies are source dependencies, but TypeScript resolved this package export to a file not owned by the source graph. tsc -b does not rewrite package exports through project references.',
              `  fix: expose source files from the dependency package exports, add a source paths config to this declaration leaf extends, or stop using workspace:* plus project references for artifact consumption; ${formatArtifactDependencyPolicy(targetPackageForGraph)}`,
              '  hint: run `limina paths generate` to create a compatibility paths file, then manually add it to the first position of the listed tsconfig*.dts.json extends array.',
            ].join('\n'),
          );
          continue;
        }

        const targetProjectPath = findTargetProject({
          fileOwnerLookup,
          packages,
          projectPaths,
          resolvedFilePath,
          specifier: importRecord.specifier,
        });

        if (!targetProjectPath) {
          if (!targetPackageForGraph) {
            continue;
          }

          if (!targetWorkspacePackageForResolved) {
            if (
              targetPackageForGraph &&
              shouldResolveThroughGraph(importer, targetPackageForGraph)
            ) {
              problems.push(
                [
                  'Workspace source import resolved outside the workspace graph:',
                  `  importing project: ${toRelativePath(config.rootDir, project.configPath)}`,
                  `  file: ${toRelativePath(config.rootDir, importRecord.filePath)}:${importRecord.line}`,
                  `  imported specifier: ${importRecord.specifier}`,
                  `  resolved file: ${toRelativePath(config.rootDir, resolvedFilePath)}`,
                  `  reason: workspace:* dependencies are source dependency edges and must resolve to files owned by the source graph; ${formatArtifactDependencyPolicy(targetPackageForGraph)}`,
                ].join('\n'),
              );
            }
            continue;
          }

          problems.push(
            [
              'Unable to map workspace import to a graph project:',
              `  importing project: ${toRelativePath(config.rootDir, project.configPath)}`,
              `  file: ${toRelativePath(config.rootDir, importRecord.filePath)}:${importRecord.line}`,
              `  imported specifier: ${importRecord.specifier}`,
              `  resolved file: ${toRelativePath(config.rootDir, resolvedFilePath)}`,
              `  current references: ${formatReferences(config.rootDir, project.references)}`,
            ].join('\n'),
          );
          continue;
        }

        if (targetProjectPath === project.configPath) {
          continue;
        }

        const deniedRefRule = getDeniedRefRule(
          graphRules,
          project.label,
          targetProjectPath,
        );

        if (deniedRefRule) {
          addDeniedRefImportProblem({
            config,
            importRecord,
            problems,
            project,
            rule: deniedRefRule,
            targetProjectPath,
          });
          continue;
        }

        if (
          targetPackageForGraph &&
          !shouldResolveThroughGraph(importer, targetPackageForGraph)
        ) {
          continue;
        }

        if (!projectsByPath.has(targetProjectPath)) {
          problems.push(
            [
              'Expected graph target is not reachable from any checker entry:',
              `  importing project: ${toRelativePath(config.rootDir, project.configPath)}`,
              `  file: ${toRelativePath(config.rootDir, importRecord.filePath)}:${importRecord.line}`,
              `  imported specifier: ${importRecord.specifier}`,
              `  expected graph project: ${toRelativePath(config.rootDir, targetProjectPath)}`,
            ].join('\n'),
          );
          continue;
        }

        if (!project.references.has(targetProjectPath)) {
          problems.push(
            [
              'Missing project reference for workspace import:',
              `  importing project: ${toRelativePath(config.rootDir, project.configPath)}`,
              `  file: ${toRelativePath(config.rootDir, importRecord.filePath)}:${importRecord.line}`,
              `  imported specifier: ${importRecord.specifier}`,
              `  expected reference: ${toRelativePath(config.rootDir, targetProjectPath)}`,
              `  current references: ${formatReferences(config.rootDir, project.references)}`,
            ].join('\n'),
          );
        }
      }
    }
  }

  if (problems.length > 0) {
    GraphLogger.error(problems.join('\n\n'));
    return false;
  }

  if (options.logSuccess ?? true) {
    GraphLogger.success(
      `Checked ${projects.length} graph projects; references are valid.`,
    );
  }

  return true;
}

export async function runGraphCheck(
  config: ResolvedLiminaConfig,
  options: RunGraphCheckOptions = {},
): Promise<boolean> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const task = options.flow?.start('graph check', {
    depth: options.flowDepth ?? 0,
  });

  GraphLogger.info('graph check started');

  try {
    const logSuccess = !options.flow?.interactive;
    const passed = await runGraphCheckInternal(config, { logSuccess });

    if (passed) {
      if (logSuccess) {
        GraphLogger.success('graph check finished', elapsed());
      }

      task?.pass();
    } else {
      GraphLogger.error('graph check finished with failures', elapsed());
      task?.fail('graph check finished with failures');
    }

    return passed;
  } catch (error) {
    GraphLogger.error(
      `graph check failed: ${formatErrorMessage(error)}`,
      elapsed(),
    );
    task?.fail('graph check failed', { error });
    throw error;
  }
}
