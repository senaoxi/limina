import type { AnalysisSnapshot, InputDependency } from './contracts';
import type { AnalysisInputs } from './inputs';
import type { InstallationDomain } from './installation-environment';

export function pnpmLockCoverageKey(
  file: string,
  roots: { lockRoot: string; resolutionRoot: string },
  version: string,
): string {
  return JSON.stringify([
    'pnpm-lock-coverage',
    file,
    roots.lockRoot,
    roots.resolutionRoot,
    version,
  ]);
}

function selectedLockReceipt(
  domain: InstallationDomain,
): InputDependency | undefined {
  const id = JSON.stringify(['physical', 'bytes', domain.locks[0]]);
  return domain.dependencies.find((dependency) => dependency.inputId === id);
}

function hasLockCoverage(
  snapshot: AnalysisSnapshot,
  domain: InstallationDomain,
): boolean {
  const receipt = selectedLockReceipt(domain);
  if (receipt === undefined) return false;
  const input = snapshot.inputs[receipt.inputId];
  if (input === undefined) return false;
  return [
    input.kind === 'bytes',
    input.path === domain.locks[0],
    input.version === receipt.expectedVersion,
  ].every(Boolean);
}

function contexts(snapshot: AnalysisSnapshot) {
  return [
    ...Object.values(snapshot.contexts),
    ...Object.values(snapshot.vueContexts),
  ];
}

export function hasBrokenInstallationCoverage(
  snapshot: AnalysisSnapshot,
): boolean {
  return contexts(snapshot).some((context) =>
    context.environment.domains.some(
      (domain) => !hasLockCoverage(snapshot, domain),
    ),
  );
}

function retainCoverage(
  domain: InstallationDomain,
  inputs: AnalysisInputs,
): void {
  const receipt = reusableReceipt(domain, inputs);
  if (receipt === undefined) return;
  const key = pnpmLockCoverageKey(
    domain.locks[0]!,
    domain,
    receipt.expectedVersion,
  );
  inputs.memoizeObservation(key, () => true);
}

function reusableReceipt(
  domain: InstallationDomain,
  inputs: AnalysisInputs,
): InputDependency | undefined {
  const isValid = [
    domain.manager === 'pnpm',
    domain.dependencies.every((dependency) => inputs.valid(dependency)),
  ].every(Boolean);
  return isValid ? selectedLockReceipt(domain) : undefined;
}

export function restoreInstallationLockCoverage(
  snapshot: AnalysisSnapshot,
  inputs: AnalysisInputs,
): void {
  if (
    [inputs.domainDirty, hasBrokenInstallationCoverage(snapshot)].some(Boolean)
  )
    return;
  const eligible = contexts(snapshot).filter(
    (context) =>
      context.complete && context.environment.evidence === 'lockfile-trusted',
  );
  const domains = eligible.flatMap((context) => context.environment.domains);
  for (const domain of domains) retainCoverage(domain, inputs);
}
