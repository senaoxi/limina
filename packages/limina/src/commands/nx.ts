import { createElapsedTimer } from 'logaria/helper';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'pathe';
import type { ResolvedLiminaConfig } from '../config';
import type { LiminaFlowReporter } from '../flow';
import {
  collectImportsFromFile,
  createImportAnalysisContext,
  findPackageForFile,
  parseProject,
  type ProjectInfo,
} from '../graph-context';
import { clearCliScreen, formatErrorMessage, NxLogger } from '../logger';
import { collectSourceGraphProjectExtensions } from '../tsconfig';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  normalizeAbsolutePathIdentity,
  toPosixPath,
  toRelativePath,
} from '../utils/path';
import {
  collectWorkspacePackages,
  findPackageForSpecifier,
  getDependencySections,
  isWorkspaceDependencySpecifier,
  type WorkspacePackage,
} from '../workspace';
import {
  createWorkspaceExportsResolutionIndex,
  type WorkspaceExportsResolutionProfile,
} from '../workspace-exports';

interface NxProjectSyncPlan {
  dependencyNames: string[];
  outputPath: string;
  packageName: string;
}

export interface NxResult {
  changed: boolean;
  edgeCount: number;
  outputCount: number;
}

export interface RunNxOptions {
  check?: boolean;
  clearScreen?: boolean;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  targets?: string[];
}

const defaultArtifactDirectories = ['dist'];
const defaultNxTargets = ['build'];

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function configuredArtifactDirectories(): string[] {
  return defaultArtifactDirectories;
}

function isLinkDependencySpecifier(specifier: string): boolean {
  return specifier.startsWith('link:');
}

function resolveLinkTargetPath(
  importerPackage: WorkspacePackage,
  specifier: string,
): string {
  return normalizeAbsolutePath(
    path.resolve(importerPackage.directory, specifier.slice('link:'.length)),
  );
}

function matchesArtifactDirectory(
  config: ResolvedLiminaConfig,
  targetPackage: WorkspacePackage,
  resolvedPath: string,
): boolean {
  return configuredArtifactDirectories().some((artifactDirectory) => {
    const artifactPath = normalizeAbsolutePath(
      path.join(targetPackage.directory, artifactDirectory),
    );

    return isPathInsideDirectory(resolvedPath, artifactPath);
  });
}

function hasWorkspaceDependency(
  importerPackage: WorkspacePackage,
  dependencyName: string,
): boolean {
  return getDependencySections(importerPackage.manifest).some(
    (dependencies) => {
      const specifier = dependencies[dependencyName];

      return Boolean(specifier && isWorkspaceDependencySpecifier(specifier));
    },
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
  }));
}

function collectNxCheckerProjects(config: ResolvedLiminaConfig): {
  problems: string[];
  projects: ProjectInfo[];
} {
  const graphRoute = collectSourceGraphProjectExtensions(config);
  const projectPaths = [...graphRoute.projectExtensionsByPath.keys()].sort();

  return {
    problems: graphRoute.problems,
    projects: projectPaths.map((projectPath) =>
      parseProject(
        config,
        projectPath,
        graphRoute.projectContextsByPath.get(projectPath),
      ),
    ),
  };
}

function createSchemaPath(config: ResolvedLiminaConfig, packageDir: string) {
  const schemaPath = toPosixPath(
    path.relative(
      packageDir,
      path.join(config.rootDir, 'node_modules/nx/schemas/project-schema.json'),
    ),
  );

  return schemaPath.startsWith('.') ? schemaPath : `./${schemaPath}`;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNxTargets(targets: string[] | undefined): string[] {
  const normalizedTargets = (targets ?? defaultNxTargets)
    .map((target) => target.trim())
    .filter(Boolean);
  const uniqueTargets: string[] = [];

  for (const target of normalizedTargets) {
    if (!uniqueTargets.includes(target)) {
      uniqueTargets.push(target);
    }
  }

  return uniqueTargets.length > 0 ? uniqueTargets : [...defaultNxTargets];
}

function formatNxTargets(targets: string[]): string {
  return targets.join(' ');
}

function createDependsOn(dependencyNames: string[]): unknown[] {
  return dependencyNames.length > 0
    ? [
        {
          projects: dependencyNames,
          target: 'build',
        },
      ]
    : [];
}

function createGeneratedProjectJsonContent(
  config: ResolvedLiminaConfig,
  plan: NxProjectSyncPlan,
  targets: string[],
): string {
  return stringifyJson({
    $schema: createSchemaPath(config, path.dirname(plan.outputPath)),
    name: plan.packageName,
    targets: Object.fromEntries(
      targets.map((target) => [
        target,
        {
          dependsOn: createDependsOn(plan.dependencyNames),
        },
      ]),
    ),
    metadata: {
      limina: {
        generated: true,
      },
    },
  });
}

function addUniqueDependency(
  dependencyNames: string[],
  dependencyName: string,
): void {
  if (!dependencyNames.includes(dependencyName)) {
    dependencyNames.push(dependencyName);
  }
}

function findArtifactCycle(
  edgesByPackageName: Map<string, string[]>,
): string[] | null {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];

  const visit = (packageName: string): string[] | null => {
    if (visiting.has(packageName)) {
      const start = stack.indexOf(packageName);

      return [...stack.slice(start), packageName];
    }

    if (visited.has(packageName)) {
      return null;
    }

    visiting.add(packageName);
    stack.push(packageName);

    for (const dependencyName of edgesByPackageName.get(packageName) ?? []) {
      if (!edgesByPackageName.has(dependencyName)) {
        continue;
      }

      const cycle = visit(dependencyName);

      if (cycle) {
        return cycle;
      }
    }

    stack.pop();
    visiting.delete(packageName);
    visited.add(packageName);

    return null;
  };

  for (const packageName of edgesByPackageName.keys()) {
    const cycle = visit(packageName);

    if (cycle) {
      return cycle;
    }
  }

  return null;
}

async function collectWorkspaceExportArtifactDependencies(options: {
  buildablePackageNames: Set<string>;
  config: ResolvedLiminaConfig;
  edgesByPackageName: Map<string, string[]>;
  problems: string[];
  workspacePackages: WorkspacePackage[];
}): Promise<void> {
  const checkerProjects = collectNxCheckerProjects(options.config);

  options.problems.push(...checkerProjects.problems);

  if (checkerProjects.problems.length > 0) {
    return;
  }

  if (checkerProjects.projects.length === 0) {
    return;
  }

  const workspaceExports = await createWorkspaceExportsResolutionIndex({
    config: options.config,
    packages: options.workspacePackages,
    profiles: createWorkspaceExportsResolutionProfiles(
      checkerProjects.projects,
    ),
  });

  options.problems.push(...workspaceExports.problems);

  if (workspaceExports.problems.length > 0) {
    return;
  }

  const importAnalysis = createImportAnalysisContext();

  for (const project of checkerProjects.projects) {
    for (const fileName of project.fileNames) {
      const importerPackage = findPackageForFile(
        fileName,
        options.workspacePackages,
      );

      if (!importerPackage) {
        continue;
      }

      for (const importRecord of collectImportsFromFile(
        fileName,
        options.config.rootDir,
        importAnalysis,
      )) {
        const targetPackage = findPackageForSpecifier(
          importRecord.specifier,
          options.workspacePackages,
        );

        if (!targetPackage || targetPackage.name === importerPackage.name) {
          continue;
        }

        if (!workspaceExports.hasExports(targetPackage.name)) {
          continue;
        }

        if (!hasWorkspaceDependency(importerPackage, targetPackage.name)) {
          continue;
        }

        const resolution = workspaceExports.get(
          project.configPath,
          importRecord.specifier,
        );

        if (!resolution?.oxcResolvedFileName) {
          continue;
        }

        // oxcResolvedFileName is already the effective artifact path. For pure
        // type exports, the exports index stores TypeScript's .d.ts result here
        // so declaration-only dist entries still produce the needed build edge.
        // Mixed exports are allowed: importing B's source entry should not make
        // A wait for B's build. Only a public export that resolves into B/dist
        // represents a real artifact dependency.
        if (
          !matchesArtifactDirectory(
            options.config,
            targetPackage,
            resolution.oxcResolvedFileName,
          )
        ) {
          continue;
        }

        const dependencyLabel = `${importerPackage.name} -> ${targetPackage.name}`;

        if (!options.buildablePackageNames.has(targetPackage.name)) {
          options.problems.push(
            [
              'Nx build dependency target has no build script:',
              `  dependency: ${dependencyLabel}`,
              `  package: ${toRelativePath(options.config.rootDir, targetPackage.directory)}`,
              '  reason: workspace:* imports that resolve to build artifacts require the target package to define scripts.build.',
            ].join('\n'),
          );
          continue;
        }

        const dependencyNames = options.edgesByPackageName.get(
          importerPackage.name,
        );

        if (dependencyNames) {
          addUniqueDependency(dependencyNames, targetPackage.name);
        }
      }
    }
  }
}

export async function collectNxProjectSyncPlans(
  config: ResolvedLiminaConfig,
): Promise<NxProjectSyncPlan[]> {
  const rootDirIdentity = normalizeAbsolutePathIdentity(config.rootDir);
  const workspacePackages = (await collectWorkspacePackages(config)).filter(
    (workspacePackage) =>
      normalizeAbsolutePathIdentity(workspacePackage.directory) !==
      rootDirIdentity,
  );
  const packagesByName = new Map(
    workspacePackages.map((workspacePackage) => [
      workspacePackage.name,
      workspacePackage,
    ]),
  );
  const buildablePackageNames = new Set(
    workspacePackages
      .filter((workspacePackage) => workspacePackage.manifest.scripts?.build)
      .map((workspacePackage) => workspacePackage.name),
  );
  const edgesByPackageName = new Map<string, string[]>(
    workspacePackages.map((workspacePackage) => [workspacePackage.name, []]),
  );
  const problems: string[] = [];

  for (const workspacePackage of workspacePackages) {
    const dependencyNames = edgesByPackageName.get(workspacePackage.name) ?? [];

    for (const dependencies of getDependencySections(
      workspacePackage.manifest,
    )) {
      for (const [dependencyName, specifier] of Object.entries(dependencies)) {
        if (!isLinkDependencySpecifier(specifier)) {
          continue;
        }

        const targetPackage = packagesByName.get(dependencyName);
        const dependencyLabel = `${workspacePackage.name} -> ${dependencyName}`;

        if (!targetPackage) {
          problems.push(
            [
              'Nx build dependency points at an unknown workspace package:',
              `  dependency: ${dependencyLabel}`,
              `  specifier: ${specifier}`,
              '  reason: link: workspace artifact dependencies must name a package from the pnpm workspace.',
            ].join('\n'),
          );
          continue;
        }

        if (!buildablePackageNames.has(dependencyName)) {
          problems.push(
            [
              'Nx build dependency target has no build script:',
              `  dependency: ${dependencyLabel}`,
              `  package: ${toRelativePath(config.rootDir, targetPackage.directory)}`,
              '  reason: link: artifact dependencies require the target package to define scripts.build.',
            ].join('\n'),
          );
          continue;
        }

        const linkTargetPath = resolveLinkTargetPath(
          workspacePackage,
          specifier,
        );

        if (!matchesArtifactDirectory(config, targetPackage, linkTargetPath)) {
          problems.push(
            [
              'Nx build dependency does not point at an artifact directory:',
              `  dependency: ${dependencyLabel}`,
              `  specifier: ${specifier}`,
              `  resolved: ${toRelativePath(config.rootDir, linkTargetPath)}`,
              `  expected artifact directories: ${configuredArtifactDirectories().join(', ')}`,
            ].join('\n'),
          );
          continue;
        }

        addUniqueDependency(dependencyNames, dependencyName);
      }
    }
  }

  await collectWorkspaceExportArtifactDependencies({
    buildablePackageNames,
    config,
    edgesByPackageName,
    problems,
    workspacePackages,
  });

  const cycle = findArtifactCycle(edgesByPackageName);

  if (cycle) {
    problems.push(
      [
        'Nx artifact build dependency cycle:',
        `  cycle: ${cycle.join(' -> ')}`,
        '  reason: artifact dependencies from link: and workspace package exports must form an acyclic build graph.',
      ].join('\n'),
    );
  }

  if (problems.length > 0) {
    throw new Error(problems.join('\n\n'));
  }

  return workspacePackages
    .flatMap((workspacePackage) => {
      const dependencyNames =
        edgesByPackageName.get(workspacePackage.name) ?? [];

      return [
        {
          dependencyNames,
          outputPath: path.join(workspacePackage.directory, 'project.json'),
          packageName: workspacePackage.name,
        },
      ];
    })
    .sort((left, right) => left.outputPath.localeCompare(right.outputPath));
}

function readTargetConfigs(projectJson: Record<string, unknown>) {
  return isRecord(projectJson.targets) ? projectJson.targets : undefined;
}

function createInvalidProjectJsonError(
  config: ResolvedLiminaConfig,
  plan: NxProjectSyncPlan,
): Error {
  return new Error(
    [
      'Invalid Nx project config:',
      `  package: ${plan.packageName}`,
      `  file: ${toRelativePath(config.rootDir, plan.outputPath)}`,
      '  reason: project.json must contain a JSON object.',
    ].join('\n'),
  );
}

function createInvalidTargetConfigError(
  config: ResolvedLiminaConfig,
  plan: NxProjectSyncPlan,
  target: string,
): Error {
  return new Error(
    [
      'Invalid Nx project target config:',
      `  package: ${plan.packageName}`,
      `  file: ${toRelativePath(config.rootDir, plan.outputPath)}`,
      `  target: ${target}`,
      '  reason: Limina can only sync dependsOn for target configs that are JSON objects.',
    ].join('\n'),
  );
}

function readDependsOnProjectSet(dependsOn: unknown): Set<string> | null {
  if (!Array.isArray(dependsOn)) {
    return null;
  }

  const projectNames = new Set<string>();

  for (const entry of dependsOn) {
    if (!isRecord(entry) || !Array.isArray(entry.projects)) {
      return null;
    }

    for (const projectName of entry.projects) {
      if (typeof projectName !== 'string') {
        return null;
      }

      projectNames.add(projectName);
    }
  }

  return projectNames;
}

function areProjectSetsEqual(
  currentProjectNames: Set<string> | null,
  expectedProjectNames: Set<string>,
): boolean {
  if (!currentProjectNames) {
    return false;
  }

  if (currentProjectNames.size !== expectedProjectNames.size) {
    return false;
  }

  for (const projectName of currentProjectNames) {
    if (!expectedProjectNames.has(projectName)) {
      return false;
    }
  }

  return true;
}

async function checkNxProjectSyncPlan(
  config: ResolvedLiminaConfig,
  plan: NxProjectSyncPlan,
  targets: string[],
): Promise<boolean> {
  if (!existsSync(plan.outputPath)) {
    return true;
  }

  const currentJson = await readJsonFile(plan.outputPath);

  if (!isRecord(currentJson)) {
    throw createInvalidProjectJsonError(config, plan);
  }

  const targetConfigs = readTargetConfigs(currentJson);

  if (!targetConfigs) {
    return false;
  }

  const expectedProjectNames = new Set(plan.dependencyNames);

  for (const target of targets) {
    if (!Object.hasOwn(targetConfigs, target)) {
      continue;
    }

    const targetConfig = targetConfigs[target];

    if (!isRecord(targetConfig)) {
      return true;
    }

    if (
      !areProjectSetsEqual(
        readDependsOnProjectSet(targetConfig.dependsOn),
        expectedProjectNames,
      )
    ) {
      return true;
    }
  }

  return false;
}

async function writeNxProjectSyncPlan(
  config: ResolvedLiminaConfig,
  plan: NxProjectSyncPlan,
  targets: string[],
): Promise<boolean> {
  if (!existsSync(plan.outputPath)) {
    await mkdir(path.dirname(plan.outputPath), { recursive: true });
    await writeFile(
      plan.outputPath,
      createGeneratedProjectJsonContent(config, plan, targets),
    );

    return true;
  }

  const currentJson = await readJsonFile(plan.outputPath);

  if (!isRecord(currentJson)) {
    throw createInvalidProjectJsonError(config, plan);
  }

  const targetConfigs = readTargetConfigs(currentJson);

  if (!targetConfigs) {
    return false;
  }

  let didChange = false;
  const expectedDependsOn = createDependsOn(plan.dependencyNames);

  for (const target of targets) {
    if (!Object.hasOwn(targetConfigs, target)) {
      continue;
    }

    const targetConfig = targetConfigs[target];

    if (!isRecord(targetConfig)) {
      throw createInvalidTargetConfigError(config, plan, target);
    }

    if (
      JSON.stringify(targetConfig.dependsOn) ===
      JSON.stringify(expectedDependsOn)
    ) {
      continue;
    }

    targetConfig.dependsOn = expectedDependsOn;
    didChange = true;
  }

  if (!didChange) {
    return false;
  }

  await writeFile(plan.outputPath, stringifyJson(currentJson));

  return true;
}

async function runNxInternal(
  config: ResolvedLiminaConfig,
  options: { check?: boolean; targets?: string[] } = {},
): Promise<NxResult> {
  const targets = normalizeNxTargets(options.targets);
  const syncPlans = await collectNxProjectSyncPlans(config);
  const changes = await Promise.all(
    syncPlans.map((syncPlan) =>
      options.check
        ? checkNxProjectSyncPlan(config, syncPlan, targets)
        : writeNxProjectSyncPlan(config, syncPlan, targets),
    ),
  );
  const didChange = changes.some(Boolean);
  const edgeCount =
    syncPlans.reduce(
      (total, syncPlan) => total + syncPlan.dependencyNames.length,
      0,
    ) * targets.length;
  const action = options.check
    ? didChange
      ? 'Would update'
      : 'Checked unchanged'
    : didChange
      ? 'Synced'
      : 'Skipped unchanged';

  NxLogger.info(
    `${action} ${syncPlans.length} Nx project config files across ${targets.length} target${targets.length === 1 ? '' : 's'} with ${edgeCount} build dependency edges.`,
  );

  if (options.check && didChange) {
    NxLogger.error(
      `Nx project config state is stale; run \`limina nx sync ${formatNxTargets(targets)}\`.`,
    );
  }

  return {
    changed: didChange,
    edgeCount,
    outputCount: syncPlans.length,
  };
}

export async function runNx(
  config: ResolvedLiminaConfig,
  options: RunNxOptions = {},
): Promise<NxResult> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const targets = normalizeNxTargets(options.targets);
  const action = options.check
    ? `nx check ${formatNxTargets(targets)}`
    : `nx sync ${formatNxTargets(targets)}`;
  const task = options.flow?.start(action, {
    depth: options.flowDepth ?? 0,
  });

  NxLogger.info(`${action} started`);

  try {
    const result = await runNxInternal(config, options);

    if (options.check && result.changed) {
      NxLogger.error(`${action} finished with stale files`, elapsed());
      task?.fail(`${action} finished with stale files`);
    } else {
      if (!options.flow?.interactive) {
        NxLogger.success(`${action} finished`, elapsed());
      }

      task?.pass();
    }

    return result;
  } catch (error) {
    NxLogger.error(`${action} failed: ${formatErrorMessage(error)}`, elapsed());
    task?.fail(`${action} failed`, { error });
    throw error;
  }
}
