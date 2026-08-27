import type { ResolvedLiminaConfig } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import path from 'pathe';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { ProofFinding } from './findings';
import {
  addFrameworkGovernanceFinding,
  type FrameworkCoverageOptions,
  groupEntriesByConfigPath,
} from './framework-governance-common';
import type {
  FrameworkGovernanceFactForKind,
  GovernedSourceEntry,
} from './framework-governance-types';

interface ExpectedGovernedSource {
  checkerName: string;
  configPath: string;
}

function sourceKey(checkerName: string, configPath: string): string {
  return JSON.stringify([checkerName, configPath]);
}

function collectExpectedGovernedSources(
  options: FrameworkCoverageOptions,
): ExpectedGovernedSource[] {
  return options.generatedGraph.manifest.ownership.configs
    .filter((config) => config.role === 'type')
    .map(({ config: configPath, owner: checkerName }) => ({
      checkerName,
      configPath: normalizeAbsolutePath(
        path.join(options.config.rootDir, configPath),
      ),
    }));
}

function addGovernedSourceFinding(options: {
  checkerName: string;
  config: ResolvedLiminaConfig;
  configPath: string;
  findings: ProofFinding[];
  violation: FrameworkGovernanceFactForKind<'governed-source'>['violation'];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const missing = options.violation === 'missing-runtime-unit';
  const reasons = {
    false:
      'runtime governed-source evidence must correspond to a canonical checker root in the generated manifest.',
    true: 'every generated checker root must retain a governed-source unit so proof and source ownership can cover pure framework configs.',
  } as const;
  const titles = {
    false: 'Governed-source evidence is absent from the generated manifest',
    true: 'Generated checker root is missing governed-source evidence',
  } as const;
  const reason = reasons[String(missing) as 'false' | 'true'];
  const title = titles[String(missing) as 'false' | 'true'];
  addFrameworkGovernanceFinding({
    checkerName: options.checkerName,
    config: options.config,
    configPath: options.configPath,
    detailLines: [
      `${title}:`,
      `  checker: ${options.checkerName}`,
      `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
      `  reason: ${reason}`,
    ],
    facts: {
      checkerName: options.checkerName,
      configPath: options.configPath,
      kind: 'governed-source',
      violation: options.violation,
    },
    findings: options.findings,
    reason,
    title,
    workspaceLookup: options.workspaceLookup,
  });
}

function addMissingGovernedSources(
  options: FrameworkCoverageOptions,
  expected: readonly ExpectedGovernedSource[],
  actualKeys: ReadonlySet<string>,
): void {
  for (const source of expected) {
    if (actualKeys.has(sourceKey(source.checkerName, source.configPath)))
      continue;
    addGovernedSourceFinding({
      ...options,
      ...source,
      violation: 'missing-runtime-unit',
    });
  }
}

function addUnlistedGovernedSources(
  options: FrameworkCoverageOptions,
  expectedKeys: ReadonlySet<string>,
): void {
  for (const entry of options.entries) {
    if (expectedKeys.has(sourceKey(entry.checkerName, entry.unit.configPath)))
      continue;
    addGovernedSourceFinding({
      ...options,
      checkerName: entry.checkerName,
      configPath: entry.unit.configPath,
      violation: 'unlisted-runtime-unit',
    });
  }
}

function addGovernedSourceCoverageFindings(
  options: FrameworkCoverageOptions,
): void {
  const expected = collectExpectedGovernedSources(options);
  const expectedKeys = new Set(
    expected.map((source) => sourceKey(source.checkerName, source.configPath)),
  );
  const actualKeys = new Set(
    options.entries.map((entry) =>
      sourceKey(entry.checkerName, entry.unit.configPath),
    ),
  );
  addMissingGovernedSources(options, expected, actualKeys);
  addUnlistedGovernedSources(options, expectedKeys);
}

function addPrimaryOwnerGroupFinding(
  options: FrameworkCoverageOptions,
  configPath: string,
  entries: readonly GovernedSourceEntry[],
): void {
  if (entries.length < 2) return;
  const owners = entries
    .map((entry) => ({
      checkerName: entry.unit.primaryCheckerName,
      preset: entry.unit.primaryCheckerName,
    }))
    .sort(
      (left, right) =>
        compareCodeUnits(left.checkerName, right.checkerName) ||
        compareCodeUnits(left.preset, right.preset),
    );
  const reason = 'a governed source config has exactly one checker owner.';
  addFrameworkGovernanceFinding({
    config: options.config,
    configPath,
    detailLines: [
      'Governed source config has multiple primary owners:',
      `  config: ${toRelativePath(options.config.rootDir, configPath)}`,
      `  owners: ${owners.map((owner) => `${owner.checkerName} (${owner.preset})`).join(', ')}`,
      `  reason: ${reason}`,
    ],
    facts: { configPath, kind: 'primary-owner', owners },
    findings: options.findings,
    reason,
    title: 'Governed source config has multiple primary owners',
    workspaceLookup: options.workspaceLookup,
  });
}

function addPrimaryOwnerFindings(options: FrameworkCoverageOptions): void {
  const groups = groupEntriesByConfigPath(options.entries);
  for (const [configPath, entries] of groups) {
    addPrimaryOwnerGroupFinding(options, configPath, entries);
  }
}

export function addFrameworkSourceCoverageFindings(
  options: FrameworkCoverageOptions,
): void {
  addGovernedSourceCoverageFindings(options);
  addPrimaryOwnerFindings(options);
}
