import type { MissingCheckerPeerDependency } from './types';

function formatCheckerList(checkerNames: readonly string[]): string {
  return checkerNames.map((name) => `"${name}"`).join(', ');
}

function formatDependency(dependency: MissingCheckerPeerDependency): string {
  const version =
    dependency.installedVersion === undefined
      ? ''
      : `; installed ${dependency.installedVersion}; supported ${dependency.supportedRange}`;
  return `  - ${dependency.packageName} (used by checker ${formatCheckerList(
    dependency.checkerNames,
  )}${version})`;
}

function getFailureHeading(options: {
  failureKind: MissingCheckerPeerDependency['failureKind'];
  missing: string;
  unsupported: string;
}): string {
  return options.failureKind === 'missing'
    ? options.missing
    : options.unsupported;
}

function groupHeading(dependency: MissingCheckerPeerDependency): string {
  if (dependency.ownership === 'external-checker') {
    return getFailureHeading({
      failureKind: dependency.failureKind,
      missing: 'Missing external checker:',
      unsupported: 'Unsupported external checker:',
    });
  }
  return 'Missing Limina runtime dependency:';
}

function groupKey(dependency: MissingCheckerPeerDependency): string {
  return `${dependency.ownership}:${dependency.failureKind}:${dependency.resolutionScope}`;
}

function formatRuntimeFix(
  dependencies: readonly MissingCheckerPeerDependency[],
): string {
  const action =
    dependencies[0]!.failureKind === 'missing' ? 'install' : 'adjust';
  const packageNames = dependencies.map((dependency) => dependency.packageName);
  return `Fix: ${action} ${packageNames.join(' ')} in the workspace running Limina.`;
}

function formatExternalCheckerFix(
  dependencies: readonly MissingCheckerPeerDependency[],
): string {
  const packageNames = dependencies.map((dependency) => dependency.packageName);
  const first = dependencies[0]!;
  if (first.failureKind === 'missing') {
    return `Fix: pnpm add -D ${packageNames.join(' ')} (run in checker execution scope ${first.resolutionScope}).`;
  }
  return `Fix: adjust ${packageNames.join(' ')} in checker execution scope ${first.resolutionScope} to a supported version.`;
}

function formatFix(
  dependencies: readonly MissingCheckerPeerDependency[],
): string {
  if (dependencies[0]!.ownership === 'limina-runtime') {
    return formatRuntimeFix(dependencies);
  }
  return formatExternalCheckerFix(dependencies);
}

export function formatMissingCheckerPeerDependencies(
  dependencies: MissingCheckerPeerDependency[],
): string {
  const groups = new Map<string, MissingCheckerPeerDependency[]>();
  for (const dependency of dependencies) {
    const key = groupKey(dependency);
    const group = groups.get(key) ?? [];
    group.push(dependency);
    groups.set(key, group);
  }
  return [...groups.values()]
    .flatMap((group) => [
      groupHeading(group[0]!),
      ...group.map(formatDependency),
      formatFix(group),
    ])
    .join('\n');
}
