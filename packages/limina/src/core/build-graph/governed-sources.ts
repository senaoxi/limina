import { isBuildCapablePreset } from '#checkers';
import type { ResolvedLiminaInputs } from '#config/runner';
import { uniqueCodeUnitSortedStrings as uniqueSortedStrings } from '#utils/collections';
import { getAstroSourceProject } from '../astro-semantic/project';
import { createSvelteSourceProject } from '../svelte-semantic/project';
import type { WorkspaceRegionPathIndex } from '../workspace/validated-context';
import { getFrameworkFilePackageRoot } from './framework-file-root';
import { getGeneratedLeafSolutionBuildConfigPath } from './generated/paths';
import type { FrozenSemanticProject } from './locked-semantic-project';
import type {
  FrameworkCapabilityDescriptor,
  GovernedSourceUnit,
  SourceProject,
} from './types';

function createBuildProjection(options: {
  declarationFileNames: readonly string[];
  config: ResolvedLiminaInputs;
  frameworkCapabilities: FrameworkCapabilityDescriptor[];
  project: SourceProject;
}): GovernedSourceUnit['buildProjection'] {
  if (!isBuildCapablePreset(options.project.checkerName)) {
    return { kind: 'framework-checker' };
  }
  if (!requiresFrameworkProjection(options)) {
    return {
      dtsConfigPath: options.project.dtsConfigPath,
      kind: 'declaration-project',
    };
  }
  return createFrameworkBuildProjection(options);
}

function createFrameworkBuildProjection(options: {
  declarationFileNames: readonly string[];
  config: ResolvedLiminaInputs;
  project: SourceProject;
}): GovernedSourceUnit['buildProjection'] {
  const buildConfigPath = getGeneratedLeafSolutionBuildConfigPath({
    checkerName: options.project.checkerName,
    packageRootDir: options.project.packageRootDir,
    rootDir: options.config.rootDir,
    sourceConfigPath: options.project.configPath,
  });
  return options.declarationFileNames.length === 0
    ? { buildConfigPath, kind: 'transparent-solution' }
    : {
        buildConfigPath,
        dtsConfigPath: options.project.dtsConfigPath,
        kind: 'wrapped-project',
      };
}

function requiresFrameworkProjection(options: {
  frameworkCapabilities: readonly FrameworkCapabilityDescriptor[];
  project: SourceProject;
}): boolean {
  return (
    options.frameworkCapabilities.length > 0 &&
    isBuildCapablePreset(options.project.context.checkerPresets[0]!)
  );
}

function createDeclarationFileNames(project: SourceProject): string[] {
  return isBuildCapablePreset(project.checkerName)
    ? [...project.fileNames]
    : [];
}

function getFrameworkFamily(
  checkerName: SourceProject['checkerName'],
): FrameworkCapabilityDescriptor['family'] | null {
  return (
    (
      {
        astro: 'astro',
        'svelte-check': 'svelte',
      } as const
    )[checkerName as 'astro' | 'svelte-check'] ?? null
  );
}

function getFrameworkExtension(
  family: FrameworkCapabilityDescriptor['family'],
): string {
  return family === 'astro' ? '.astro' : '.svelte';
}

function getFrameworkPackageRoot(options: {
  fallback: string;
  packageRoots: readonly string[];
}): string {
  return options.packageRoots[0] ?? options.fallback;
}

function createFrameworkCapabilities(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  fileNames: readonly string[];
  packageRootDir: string;
  checkerName: SourceProject['checkerName'];
  sourceConfigPath: string;
}): FrameworkCapabilityDescriptor[] {
  const family = getFrameworkFamily(options.checkerName);
  if (family === null) return [];
  const extension = getFrameworkExtension(family);
  const frameworkFiles = options.fileNames.filter((fileName) =>
    fileName.endsWith(extension),
  );
  const packageRoots = uniqueSortedStrings(
    frameworkFiles.map((fileName) =>
      getFrameworkFilePackageRoot({
        activatedRegions: options.activatedRegions,
        fallbackPackageRootDir: options.packageRootDir,
        fileName,
      }),
    ),
  );
  if (packageRoots.length > 1) {
    throw new Error(
      `Framework checker ownership spans multiple leaf package roots for ${family} at ${options.sourceConfigPath}.`,
    );
  }
  return [
    {
      family,
      packageRootDir: getFrameworkPackageRoot({
        fallback: options.packageRootDir,
        packageRoots,
      }),
      sourceConfigPath: options.sourceConfigPath,
    },
  ];
}

function createGovernedAstroSemanticProject(options: {
  capability: FrameworkCapabilityDescriptor | undefined;
  frozen: FrozenSemanticProject;
}): GovernedSourceUnit['astroSemanticProject'] {
  return options.capability === undefined
    ? undefined
    : getAstroSourceProject(
        options.frozen.project,
        options.capability.packageRootDir,
      );
}

function createGovernedSvelteSemanticProject(options: {
  capability: FrameworkCapabilityDescriptor | undefined;
  frozen: FrozenSemanticProject;
  project: SourceProject;
}): GovernedSourceUnit['svelteSemanticProject'] {
  if (options.project.semanticAuthority.family !== 'svelte') return undefined;
  if (options.capability === undefined) return undefined;
  return createSvelteSourceProject({
    source: options.frozen.project,
    fileNames: options.project.fileNames,
    packageRootDir: options.capability.packageRootDir,
  });
}

type GovernedConfigInputs = Pick<SourceProject, 'configClosure' | 'options'>;
const configInputs = new WeakMap<GovernedSourceUnit, GovernedConfigInputs>();

export function governedSourceConfig(
  unit: GovernedSourceUnit,
): GovernedConfigInputs {
  const inputs = configInputs.get(unit);
  if (inputs === undefined)
    throw new Error(`Missing resolved Source Config for ${unit.configPath}`);
  return inputs;
}

export function publishGovernedSourceConfig(
  source: GovernedSourceUnit,
  published: GovernedSourceUnit,
): void {
  configInputs.set(published, governedSourceConfig(source));
}

export function createGovernedSourceUnit(options: {
  activatedRegions: WorkspaceRegionPathIndex;
  config: ResolvedLiminaInputs;
  frozen: FrozenSemanticProject;
  project: SourceProject;
}): GovernedSourceUnit {
  const ownedFileNames = uniqueSortedStrings(options.project.ownedFileNames);
  const frameworkCapabilities = createFrameworkCapabilities({
    activatedRegions: options.activatedRegions,
    fileNames: ownedFileNames,
    packageRootDir: options.project.packageRootDir,
    checkerName: options.project.checkerName,
    sourceConfigPath: options.project.configPath,
  });
  const declarationFileNames = createDeclarationFileNames(options.project);
  const astroCapability = frameworkCapabilities.find(
    (capability) => capability.family === 'astro',
  );
  const astroSemanticProject = createGovernedAstroSemanticProject({
    capability: astroCapability,
    frozen: options.frozen,
  });
  const svelteCapability = frameworkCapabilities.find(
    (capability) => capability.family === 'svelte',
  );
  const svelteSemanticProject = createGovernedSvelteSemanticProject({
    capability: svelteCapability,
    frozen: options.frozen,
    project: options.project,
  });

  const unit: GovernedSourceUnit = {
    astroSemanticProject,
    buildProjection: createBuildProjection({
      config: options.config,
      declarationFileNames,
      frameworkCapabilities,
      project: options.project,
    }),
    configPath: options.project.configPath,
    context: {
      checkerPresets: [...options.project.context.checkerPresets],
      extensions: [...options.project.context.extensions],
      vueSemanticIdentity: options.project.context.vueSemanticIdentity,
    },
    declarationFileNames,
    declarationReferences: options.project.references,
    frameworkCapabilities,
    ownedFileNames,
    packageRootDir: options.project.packageRootDir,
    primaryCheckerName: options.project
      .checkerName as GovernedSourceUnit['primaryCheckerName'],
    semanticAuthority: { ...options.project.semanticAuthority },
    svelteSemanticProject,
  };
  const { configClosure, options: compilerOptions } = options.frozen.project;
  configInputs.set(unit, { configClosure, options: compilerOptions });
  return unit;
}
