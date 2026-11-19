import type { AnalysisSnapshot } from './contracts';
import type { InstallationDomain } from './installation-environment';

function hasLockCoverage(
  snapshot: AnalysisSnapshot,
  domain: InstallationDomain,
): boolean {
  return domain.locks.every((file) => {
    const id = JSON.stringify(['physical', 'bytes', file]);
    const receipt = domain.dependencies.find(
      (dependency) => dependency.inputId === id,
    );
    const input = snapshot.inputs[id];
    return (
      receipt !== undefined &&
      input?.kind === 'bytes' &&
      input.path === file &&
      input.version === receipt.expectedVersion
    );
  });
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
