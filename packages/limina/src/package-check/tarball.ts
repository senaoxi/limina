import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { pack } from '@publint/pack';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'pathe';
import type { DistPackageJson } from './manifest';
import type { PackedPackageTarball } from './runner-types';

export async function packOutputTarball(
  outDir: string,
): Promise<PackedPackageTarball> {
  const destination = await mkdtemp(path.join(tmpdir(), '__LIMINA_PACKAGE__'));
  const cleanupDestination = async (): Promise<void> => {
    await rm(destination, { force: true, recursive: true }).catch(() => null);
  };

  try {
    const tarballPath = await pack(outDir, {
      destination,
      ignoreScripts: true,
      packageManager: 'pnpm',
    });
    const tarball = await readFile(tarballPath);
    return {
      cleanup: cleanupDestination,
      tarball,
      tarballPath,
    };
  } catch (error) {
    await cleanupDestination();
    throw error;
  }
}

function getEntryLabel(label: string | undefined): string {
  return label === undefined ? '' : ` for ${label}`;
}

function formatPackageJsonPath(options: {
  config: ResolvedLiminaConfig | undefined;
  packageJsonPath: string;
}): string {
  if (options.config === undefined) return options.packageJsonPath;
  return toRelativePath(options.config.rootDir, options.packageJsonPath);
}

function createMissingPackageJsonError(options: {
  config: ResolvedLiminaConfig | undefined;
  label: string | undefined;
  packageJsonPath: string;
}): Error {
  const label = getEntryLabel(options.label);
  const packageJsonPath = formatPackageJsonPath(options);
  return new Error(
    `outDir package.json not found${label} at ${packageJsonPath}. Run the package build first.`,
  );
}

export async function readDistPackageJson(options: {
  config?: ResolvedLiminaConfig;
  label?: string;
  packageJsonPath: string;
}): Promise<DistPackageJson> {
  if (!existsSync(options.packageJsonPath)) {
    throw createMissingPackageJsonError({
      config: options.config,
      label: options.label,
      packageJsonPath: options.packageJsonPath,
    });
  }
  return JSON.parse(
    await readFile(options.packageJsonPath, 'utf8'),
  ) as DistPackageJson;
}
