import type {
  FrameworkCapabilityDescriptor,
  GovernedSourceUnit,
} from '#core/build-graph/runner';
import { uniqueCodeUnitSortedStrings } from '#utils/collections';
import { toRelativePath } from '#utils/path';
import {
  addFrameworkGovernanceFinding,
  type FrameworkCoverageOptions,
} from './framework-governance-common';
import type {
  FrameworkFamily,
  FrameworkGovernanceFactForKind,
  GovernedSourceEntry,
} from './framework-governance-types';

const frameworkSuffixes = [
  ['.astro', 'astro'],
  ['.svelte', 'svelte'],
] as const;

function getFrameworkFamily(filePath: string): FrameworkFamily | undefined {
  return frameworkSuffixes.find(([suffix]) => filePath.endsWith(suffix))?.[1];
}

function expectedFrameworkFamilies(
  unit: GovernedSourceUnit,
): FrameworkFamily[] {
  return uniqueCodeUnitSortedStrings(
    unit.ownedFileNames.flatMap((filePath) => {
      const family = getFrameworkFamily(filePath);
      return family === undefined ? [] : [family];
    }),
  ) as FrameworkFamily[];
}

function capabilityMatchesUnit(
  capability: FrameworkCapabilityDescriptor,
  unit: GovernedSourceUnit,
): boolean {
  return [
    capability.sourceConfigPath === unit.configPath,
    capability.packageRootDir === unit.packageRootDir,
  ].every(Boolean);
}

const capabilityReasons = {
  'descriptor-mismatch':
    'a framework capability descriptor must use the governed source config and its leaf package root.',
  duplicate:
    'the same framework family must not cover one source config more than once.',
  missing:
    'each governed Astro or Svelte source family needs one matching framework capability descriptor.',
  unexpected:
    'framework capability descriptors require matching governed framework sources.',
} satisfies Record<
  FrameworkGovernanceFactForKind<'framework-capability'>['violation'],
  string
>;

function addCapabilityFinding(options: {
  coverage: FrameworkCoverageOptions;
  entries: readonly GovernedSourceEntry[];
  family: FrameworkFamily;
  violation: FrameworkGovernanceFactForKind<'framework-capability'>['violation'];
}): void {
  const entry = options.entries[0]!;
  const checkerNames = uniqueCodeUnitSortedStrings(
    options.entries.map((candidate) => candidate.checkerName),
  );
  const reason = capabilityReasons[options.violation];
  addFrameworkGovernanceFinding({
    checkerName: entry.checkerName,
    config: options.coverage.config,
    configPath: entry.unit.configPath,
    detailLines: [
      'Framework capability coverage is invalid:',
      `  config: ${toRelativePath(options.coverage.config.rootDir, entry.unit.configPath)}`,
      `  family: ${options.family}`,
      `  violation: ${options.violation}`,
      `  checker owners: ${checkerNames.join(', ')}`,
      `  reason: ${reason}`,
    ],
    facts: {
      checkerNames,
      configPath: entry.unit.configPath,
      family: options.family,
      kind: 'framework-capability',
      violation: options.violation,
    },
    findings: options.coverage.findings,
    reason,
    title: 'Framework capability coverage is invalid',
    workspaceLookup: options.coverage.workspaceLookup,
  });
}

function hasCapability(
  entry: GovernedSourceEntry,
  family: FrameworkFamily,
): boolean {
  return entry.unit.frameworkCapabilities.some(
    (capability) => capability.family === family,
  );
}

function addMissingCapability(
  coverage: FrameworkCoverageOptions,
  entry: GovernedSourceEntry,
  family: FrameworkFamily,
): void {
  const expected = expectedFrameworkFamilies(entry.unit).includes(family);
  if (![expected, !hasCapability(entry, family)].every(Boolean)) return;
  addCapabilityFinding({
    coverage,
    entries: [entry],
    family,
    violation: 'missing',
  });
}

function addUnexpectedCapability(
  coverage: FrameworkCoverageOptions,
  entry: GovernedSourceEntry,
  family: FrameworkFamily,
): void {
  const expected = expectedFrameworkFamilies(entry.unit).includes(family);
  if (![!expected, hasCapability(entry, family)].every(Boolean)) return;
  addCapabilityFinding({
    coverage,
    entries: [entry],
    family,
    violation: 'unexpected',
  });
}

function addMismatchedCapability(
  coverage: FrameworkCoverageOptions,
  entry: GovernedSourceEntry,
  family: FrameworkFamily,
): void {
  const mismatched = entry.unit.frameworkCapabilities
    .filter((capability) => capability.family === family)
    .some((capability) => !capabilityMatchesUnit(capability, entry.unit));
  if (!mismatched) return;
  addCapabilityFinding({
    coverage,
    entries: [entry],
    family,
    violation: 'descriptor-mismatch',
  });
}

interface CapabilityCoverageGroup {
  entries: GovernedSourceEntry[];
  family: FrameworkFamily;
}

function capabilityKey(
  entry: GovernedSourceEntry,
  family: FrameworkFamily,
): string {
  return JSON.stringify([entry.unit.configPath, family]);
}

function collectCapabilityGroups(
  entries: readonly GovernedSourceEntry[],
): Map<string, CapabilityCoverageGroup> {
  const groups = new Map<string, CapabilityCoverageGroup>();
  for (const entry of entries) {
    registerCapabilityGroups(groups, entry);
  }
  return groups;
}

function registerCapabilityGroups(
  groups: Map<string, CapabilityCoverageGroup>,
  entry: GovernedSourceEntry,
): void {
  for (const capability of entry.unit.frameworkCapabilities) {
    const key = capabilityKey(entry, capability.family);
    const current = groups.get(key) ?? {
      entries: [],
      family: capability.family,
    };
    current.entries.push(entry);
    groups.set(key, current);
  }
}

function addDuplicateCapabilityGroup(
  coverage: FrameworkCoverageOptions,
  group: CapabilityCoverageGroup,
): void {
  if (group.entries.length < 2) return;
  addCapabilityFinding({
    coverage,
    entries: group.entries,
    family: group.family,
    violation: 'duplicate',
  });
}

function addPerEntryCapabilityFindings(
  coverage: FrameworkCoverageOptions,
  entries: readonly GovernedSourceEntry[],
): void {
  for (const entry of entries) {
    for (const family of ['astro', 'svelte'] as const) {
      addMissingCapability(coverage, entry, family);
      addUnexpectedCapability(coverage, entry, family);
      addMismatchedCapability(coverage, entry, family);
    }
  }
}

export function addFrameworkCapabilityFindings(
  coverage: FrameworkCoverageOptions,
): void {
  const entries = coverage.entries;
  addPerEntryCapabilityFindings(coverage, entries);
  for (const group of collectCapabilityGroups(entries).values()) {
    addDuplicateCapabilityGroup(coverage, group);
  }
}
