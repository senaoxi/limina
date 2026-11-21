import path from 'pathe';
import type { InputDependency } from './contracts';
import { inputStat } from './input-state';
import type { AnalysisInputs } from './inputs';
import { installationBindings } from './installation-bindings';
import type { InstallationDomain } from './installation-environment';
import { installationOwner } from './installation-owner';

function isLockFile(file: string): boolean {
  return inputStat(file)?.isFile() ?? false;
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
export interface InstallationLockObserver {
  observe(options: DomainOptions): InstallationDomain;
  resolved(file: string): void;
}
export interface DomainOptions {
  root: string;
  configPath: string;
  inputs: AnalysisInputs;
}
export const installationObservers: WeakMap<
  AnalysisInputs,
  InstallationLockObserver
> = new WeakMap();

export function observeInstallationDomain(
  options: DomainOptions,
): InstallationDomain {
  return (
    installationObservers.get(options.inputs)?.observe(options) ??
    readInstallationDomain(options)
  );
}
export class MissingInstallationLockError extends Error {}

export function readInstallationDomain(options: {
  root: string;
  configPath: string;
  inputs: AnalysisInputs;
  readLocks?: (locks: string[], dependencies: InputDependency[]) => void;
}): InstallationDomain {
  const dependencies: InputDependency[] = [];
  const { root, binding } = domainBindings(options, dependencies);
  const candidates = binding.lockCandidates.map((file) =>
    path.join(binding.lockRoot, file),
  );
  observeLockCandidates(candidates, options.inputs, dependencies);
  const locks = candidates.filter(isLockFile);
  if (locks.length === 0)
    throw new MissingInstallationLockError(
      `Usable ${binding.manager} lockfile missing: ${binding.lockRoot}`,
    );
  if (options.readLocks === undefined) {
    for (const file of locks)
      dependencies.push(options.inputs.observe(file, 'bytes'));
  } else {
    options.readLocks(locks, dependencies);
  }
  return {
    adapter: 'physical-installation-v2',
    root,
    lockRoot: binding.lockRoot,
    resolutionRoot: binding.resolutionRoot,
    managerIdentity: binding.managerIdentity,
    manager: binding.manager,
    locks,
    dependencies,
  };
}
