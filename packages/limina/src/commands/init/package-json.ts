import type { PackageManifest } from '#core/workspace/actions';
import type { GovernanceRootBase } from '#utils/governance-manifest';
import path from 'pathe';
import type { InitMutationContext } from './mutation';
import { isConfirmAction } from './prompts';
import {
  formatConfigPath,
  liminaBuildScriptName,
  liminaBuildScriptValue,
  stringifyJson,
  writeTextFile,
} from './shared';
import type {
  InitPromptOptions,
  LiminaPackageMetadata,
  RootPackageJsonUpdateResult,
} from './types';

interface RootPackageUpdateContext {
  governanceRoot: GovernanceRootBase | null;
  metadata: LiminaPackageMetadata;
  mutationContext: InitMutationContext;
  prompt: InitPromptOptions;
  rootDir: string;
  skippedFiles: string[];
  writtenFiles: string[];
}

function createRootManifest(metadata: LiminaPackageMetadata): PackageManifest {
  return {
    devDependencies: {
      limina: metadata.versionRange,
      typescript: metadata.typescriptRange,
    },
    private: true,
    scripts: {
      [liminaBuildScriptName]: liminaBuildScriptValue,
    },
    type: 'module',
  };
}

async function writePackageJson(options: {
  context: RootPackageUpdateContext;
  manifest: PackageManifest;
  packageJsonPath: string;
}): Promise<void> {
  await writeTextFile({
    content: stringifyJson(options.manifest),
    filePath: options.packageJsonPath,
    mutationContext: options.context.mutationContext,
    writtenFiles: options.context.writtenFiles,
  });
}

async function createMissingPackageJson(
  context: RootPackageUpdateContext,
  packageJsonPath: string,
): Promise<RootPackageJsonUpdateResult> {
  const shouldCreate = await isConfirmAction({
    message: `No package.json found at ${formatConfigPath(context.rootDir, packageJsonPath)}. Create one?`,
    prompt: context.prompt,
  });
  if (!shouldCreate) {
    context.skippedFiles.push(packageJsonPath);
    return {
      installRequired: false,
      message: 'package.json (skipped: creation declined)',
      status: 'skip',
    };
  }

  await writePackageJson({
    context,
    manifest: createRootManifest(context.metadata),
    packageJsonPath,
  });
  return {
    installRequired: true,
    message: 'package.json created',
    status: 'pass',
  };
}

function hasDependency(
  manifest: PackageManifest,
  dependencyName: string,
): boolean {
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ].some((section) => section?.[dependencyName] !== undefined);
}

function isEnsureDevelopmentDependency(options: {
  dependencyName: string;
  manifest: PackageManifest;
  range: string;
}): boolean {
  if (hasDependency(options.manifest, options.dependencyName)) {
    return false;
  }

  options.manifest.devDependencies = {
    ...options.manifest.devDependencies,
    [options.dependencyName]: options.range,
  };
  return true;
}

function hasConflictingBuildScript(scripts: Record<string, string>): boolean {
  const value = scripts[liminaBuildScriptName];
  return value !== undefined && value !== liminaBuildScriptValue;
}

async function isUpdateBuildScript(options: {
  prompt: InitPromptOptions;
  scripts: Record<string, string>;
}): Promise<boolean> {
  return hasConflictingBuildScript(options.scripts)
    ? isOverwriteBuildScript(options)
    : isAddMissingBuildScript(options.scripts);
}

async function isOverwriteBuildScript(options: {
  prompt: InitPromptOptions;
  scripts: Record<string, string>;
}): Promise<boolean> {
  const shouldOverwrite = await isConfirmAction({
    message: `Script "${liminaBuildScriptName}" already exists in package.json. Overwrite it?`,
    prompt: options.prompt,
  });
  if (!shouldOverwrite) {
    return false;
  }

  options.scripts[liminaBuildScriptName] = liminaBuildScriptValue;
  return true;
}

function isAddMissingBuildScript(scripts: Record<string, string>): boolean {
  if (scripts[liminaBuildScriptName] !== undefined) {
    return false;
  }

  scripts[liminaBuildScriptName] = liminaBuildScriptValue;
  return true;
}

async function updateExistingPackageJson(
  context: RootPackageUpdateContext,
  packageJsonPath: string,
): Promise<RootPackageJsonUpdateResult> {
  const manifest = { ...context.governanceRoot!.manifest };
  const scripts = { ...manifest.scripts };
  const isScriptChanged = await isUpdateBuildScript({
    prompt: context.prompt,
    scripts,
  });
  const dependencyChanges = [
    isEnsureDevelopmentDependency({
      dependencyName: 'limina',
      manifest,
      range: context.metadata.versionRange,
    }),
    isEnsureDevelopmentDependency({
      dependencyName: 'typescript',
      manifest,
      range: context.metadata.typescriptRange,
    }),
  ];
  const isInstallRequired = dependencyChanges.some(Boolean);
  const isChanged = [isScriptChanged, isInstallRequired].some(Boolean);
  if (!isChanged) {
    context.skippedFiles.push(packageJsonPath);
    return {
      installRequired: isInstallRequired,
      message:
        'package.json (skipped: script and dependencies already present)',
      status: 'skip',
    };
  }

  await writePackageJson({
    context,
    manifest: { ...manifest, scripts },
    packageJsonPath,
  });
  return {
    installRequired: isInstallRequired,
    message: 'package.json updated',
    status: 'pass',
  };
}

export async function updateRootPackageJson(
  context: RootPackageUpdateContext,
): Promise<RootPackageJsonUpdateResult> {
  const packageJsonPath = path.join(context.rootDir, 'package.json');
  return context.governanceRoot === null
    ? createMissingPackageJson(context, packageJsonPath)
    : updateExistingPackageJson(context, packageJsonPath);
}
