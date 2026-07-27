import { type PackageManifest, readJsonFile } from '#core/workspace/actions';
import { existsSync } from 'node:fs';
import path from 'pathe';
import type { InitMutationContext } from './mutation';
import { confirmAction } from './prompts';
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
  const shouldCreate = await confirmAction({
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

function ensureDevDependency(options: {
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

async function updateBuildScript(options: {
  prompt: InitPromptOptions;
  scripts: Record<string, string>;
}): Promise<boolean> {
  if (hasConflictingBuildScript(options.scripts)) {
    return overwriteBuildScript(options);
  }

  return addMissingBuildScript(options.scripts);
}

async function overwriteBuildScript(options: {
  prompt: InitPromptOptions;
  scripts: Record<string, string>;
}): Promise<boolean> {
  const shouldOverwrite = await confirmAction({
    message: `Script "${liminaBuildScriptName}" already exists in package.json. Overwrite it?`,
    prompt: options.prompt,
  });
  if (!shouldOverwrite) {
    return false;
  }

  options.scripts[liminaBuildScriptName] = liminaBuildScriptValue;
  return true;
}

function addMissingBuildScript(scripts: Record<string, string>): boolean {
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
  const manifest = readJsonFile<PackageManifest>(packageJsonPath);
  const scripts = { ...manifest.scripts };
  const scriptChanged = await updateBuildScript({
    prompt: context.prompt,
    scripts,
  });
  const dependencyChanges = [
    ensureDevDependency({
      dependencyName: 'limina',
      manifest,
      range: context.metadata.versionRange,
    }),
    ensureDevDependency({
      dependencyName: 'typescript',
      manifest,
      range: context.metadata.typescriptRange,
    }),
  ];
  const installRequired = dependencyChanges.some(Boolean);
  const changed = [scriptChanged, installRequired].some(Boolean);
  if (!changed) {
    context.skippedFiles.push(packageJsonPath);
    return {
      installRequired,
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
    installRequired,
    message: 'package.json updated',
    status: 'pass',
  };
}

export async function updateRootPackageJson(
  context: RootPackageUpdateContext,
): Promise<RootPackageJsonUpdateResult> {
  const packageJsonPath = path.join(context.rootDir, 'package.json');
  return existsSync(packageJsonPath)
    ? updateExistingPackageJson(context, packageJsonPath)
    : createMissingPackageJson(context, packageJsonPath);
}
