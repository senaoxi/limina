import { readFileSync } from 'node:fs';
import path from 'pathe';
import type { InputDependency } from './contracts';
import { inputStat } from './input-state';
import type { AnalysisInputs } from './inputs';
import { installationBindings } from './installation-bindings';
import type { InstallationDomain } from './installation-environment';
import { validateInstallationLock } from './installation-locks';
import { installationOwner } from './installation-owner';

function isLockFile(file: string): boolean {
  return inputStat(file)?.isFile() ?? false;
}
function lockBytes(
  file: string,
  inputs: AnalysisInputs,
): { bytes: Buffer; version: string } {
  const before = inputStat(file)!;
  const bytes = readFileSync(file);
  const dependency = inputs.observeBytes({
    path: file,
    bytes,
    beforeMtime: before.mtimeMs,
  });
  return { bytes, version: dependency.expectedVersion };
}
function validateObservedLock(
  inputs: AnalysisInputs,
  options: Parameters<typeof validateInstallationLock>[0],
  version: string,
): void {
  if (options.manager !== 'pnpm') {
    validateInstallationLock(options);
    return;
  }
  const key = JSON.stringify([
    'pnpm-lock-coverage',
    options.file,
    options.roots.lockRoot,
    options.roots.resolutionRoot,
    version,
  ]);
  // Reuse only the pure coverage decision. Each caller still observes current
  // bytes and bindings before reaching this per-invocation memo.
  inputs.memoizeObservation(key, () => {
    validateInstallationLock(options);
    return true;
  });
}
function observeLockCandidates(
  candidates: string[],
  inputs: AnalysisInputs,
  dependencies: InputDependency[],
): void {
  for (const file of candidates)
    dependencies.push(
      inputs.observe(file, 'file'),
      inputs.observe(file, 'binding'),
    );
}
function domainBindings(
  options: {
    root: string;
    configPath: string;
    inputs: AnalysisInputs;
  },
  dependencies: InputDependency[],
) {
  const root = installationOwner({ ...options, dependencies });
  return {
    root,
    binding: installationBindings({
      ...options,
      root,
      installationScope: root === options.root ? undefined : options.root,
      dependencies,
    }),
  };
}
export function observeInstallationDomain(options: {
  root: string;
  configPath: string;
  inputs: AnalysisInputs;
}): InstallationDomain {
  const dependencies: InputDependency[] = [];
  const { root, binding } = domainBindings(options, dependencies);
  const candidates = binding.lockCandidates.map((file) =>
    path.join(binding.lockRoot, file),
  );
  observeLockCandidates(candidates, options.inputs, dependencies);
  const locks = candidates.filter(isLockFile);
  if (locks.length === 0)
    throw new Error(
      `Usable ${binding.manager} lockfile missing: ${binding.lockRoot}`,
    );
  const { bytes, version } = lockBytes(locks[0]!, options.inputs);
  validateObservedLock(
    options.inputs,
    { manager: binding.manager, file: locks[0]!, bytes, roots: binding },
    version,
  );
  for (const file of locks)
    dependencies.push(options.inputs.observe(file, 'bytes'));
  return {
    adapter: 'physical-installation-v1',
    root,
    resolutionRoot: binding.resolutionRoot,
    managerIdentity: binding.managerIdentity,
    manager: binding.manager,
    locks,
    dependencies,
  };
}
