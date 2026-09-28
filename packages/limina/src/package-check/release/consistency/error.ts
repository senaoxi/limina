import {
  formatReleaseFindings,
  orderReleaseFindingsForPresentation,
} from '../findings/presentation';
import type { ReleaseFinding } from '../findings/types';
import type { ReleaseConsistencyState } from './types';

export class PackageReleaseConsistencyError extends Error {
  override readonly name = 'PackageReleaseConsistencyError';
  readonly findings: readonly ReleaseFinding[];

  constructor(
    findings: readonly ReleaseFinding[],
    options: {
      readonly label: string;
      readonly outDir: string;
      readonly publishOrder?: readonly string[];
      readonly rootDir: string;
    },
  ) {
    const orderedFindings = orderReleaseFindingsForPresentation(findings);
    super(
      formatReleaseFindings({
        findings: orderedFindings,
        label: options.label,
        outDir: options.outDir,
        publishOrder: options.publishOrder,
        rootDir: options.rootDir,
      }),
    );
    this.findings = orderedFindings;
  }
}

function shouldPublishPackage(options: {
  packageName: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
}): boolean {
  return [
    options.packageName === options.rootPackageName,
    options.state.unpublishedPackageNames.has(options.packageName),
    options.state.changedPackageNames.has(options.packageName),
  ].some(Boolean);
}

function getPackageDependencies(options: {
  packageName: string;
  state: ReleaseConsistencyState;
}): readonly string[] {
  const dependencies = options.state.edges.get(options.packageName);
  if (dependencies === undefined) return [];
  return [...dependencies];
}

function appendPublishPackage(options: {
  packageName: string;
  publishOrder: string[];
  rootPackageName: string;
  state: ReleaseConsistencyState;
}): void {
  if (shouldPublishPackage(options)) {
    options.publishOrder.push(options.packageName);
  }
}

function visitPublishOrder(options: {
  packageName: string;
  publishOrder: string[];
  rootPackageName: string;
  seen: Set<string>;
  state: ReleaseConsistencyState;
}): void {
  if (options.seen.has(options.packageName)) return;
  options.seen.add(options.packageName);
  for (const dependencyName of getPackageDependencies(options)) {
    visitPublishOrder({ ...options, packageName: dependencyName });
  }
  appendPublishPackage(options);
}

export function createPublishOrder(
  rootPackageName: string,
  state: ReleaseConsistencyState,
): string[] {
  const publishOrder: string[] = [];
  visitPublishOrder({
    packageName: rootPackageName,
    publishOrder,
    rootPackageName,
    seen: new Set<string>(),
    state,
  });
  return publishOrder;
}

export function createReleaseConsistencyError(options: {
  label: string;
  outDir: string;
  rootDir: string;
  rootPackageName: string;
  state: ReleaseConsistencyState;
}): PackageReleaseConsistencyError | null {
  if (options.state.findings.length === 0) return null;
  return new PackageReleaseConsistencyError(options.state.findings, {
    label: options.label,
    outDir: options.outDir,
    publishOrder: createPublishOrder(options.rootPackageName, options.state),
    rootDir: options.rootDir,
  });
}
