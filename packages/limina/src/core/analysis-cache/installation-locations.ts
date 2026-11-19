import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'pathe';
import { inputStat } from './input-state';
import type { AnalysisInputs } from './inputs';
import { installationRoot } from './installation-environment';
import { projectInstallationRoot } from './installation-owner';

export function packageLocation(file: string): string | undefined {
  const match = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/.exec(file);
  return match?.[1];
}

export function resolvedLocations(file: string): string[] {
  const packagePath = packageLocation(file);
  if (inputStat(file) === undefined) {
    // A framework or a generated-project overlay can resolve a virtual file.
    return packagePath !== undefined && inputStat(packagePath)?.isDirectory()
      ? [packagePath]
      : [];
  }
  const physical = normalizeAbsolutePath(realpathSync.native(file));
  if (packagePath === undefined)
    return packageLocation(physical) === undefined ? [] : [file];
  const directory = normalizeAbsolutePath(realpathSync.native(packagePath));
  return isPathInsideDirectory(physical, directory)
    ? [packagePath]
    : [packagePath, file];
}

export function projectLocations(
  governance: string,
  config: string,
  inputs: AnalysisInputs,
): string[] {
  const locations: string[] = [];
  let directory = path.dirname(config);
  while (isPathInsideDirectory(directory, governance)) {
    const modules = path.join(directory, 'node_modules');
    inputs.observe(modules, 'binding');
    if (inputStat(modules)?.isDirectory()) locations.push(modules);
    else if (lstatSync(modules, { throwIfNoEntry: false }) !== undefined)
      throw new Error(`Invalid installation directory: ${modules}`);
    if (directory === governance) break;
    directory = path.dirname(directory);
  }
  return locations;
}

export function locationInstallationRoot(
  file: string,
  governance: string,
  inputs: AnalysisInputs,
): string {
  const physical = normalizeAbsolutePath(realpathSync.native(file));
  const root = installationRoot(physical);
  if (root !== undefined) return root;
  if (
    path.basename(file) !== 'node_modules' &&
    isPathInsideDirectory(physical, governance)
  )
    return projectInstallationRoot(
      governance,
      path.join(physical, 'package.json'),
      inputs,
    );
  throw new Error(`Unproven physical installation: ${file}`);
}
