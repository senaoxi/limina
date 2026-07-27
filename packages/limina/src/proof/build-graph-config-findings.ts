import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isBuildGraphConfigPath,
  isDtsConfigPath,
  resolveReferencePath,
} from '#core/tsconfig/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import { addPureAggregatorFindings } from './aggregator-shape-findings';
import { readProofConfig } from './config-reader';
import { isPlainRecord } from './config-values';
import {
  createProofDiagnosticFinding,
  getProofPackageIdentity,
} from './finding-utils';
import type { ProofFinding } from './findings';

interface ConfigReferenceEntry {
  configuredPath: string;
  index: number;
  resolvedPath: string;
}

function collectReferenceEntries(
  configPath: string,
  references: unknown,
): ConfigReferenceEntry[] {
  if (!Array.isArray(references)) {
    return [];
  }

  return references.flatMap((reference, index) => {
    if (!isPlainRecord(reference) || typeof reference.path !== 'string') {
      return [];
    }

    return [
      {
        configuredPath: reference.path,
        index,
        resolvedPath: resolveReferencePath(configPath, reference.path),
      },
    ];
  });
}

function isBuildReferenceTarget(configPath: string): boolean {
  return isBuildGraphConfigPath(configPath) || isDtsConfigPath(configPath);
}

function addManagedBoundaryFinding(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  findings: ProofFinding[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const reason =
    'checker build aggregators are Limina-managed under .limina and derived from checker.include source tsconfigs.';
  const detailLines = [
    'Source-level build graph config violates the managed config boundary:',
    `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
      detailLines,
      facts: {
        configPath: options.configPath,
        configRole: 'build-graph',
        kind: 'managed-config-boundary',
      },
      filePath: options.configPath,
      locations: [
        { filePath: options.configPath, label: 'build graph config' },
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.configPath,
      ),
      reason,
      title:
        'Source-level build graph config violates the managed config boundary',
    }),
  );
}

function addInvalidReferenceFinding(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  entry: ConfigReferenceEntry;
  findings: ProofFinding[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const reason =
    'tsconfig*.build.json may reference only tsconfig*.build.json aggregators or tsconfig*.dts.json declaration leaves.';
  const detailLines = [
    'Build graph references a non-build project:',
    `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    `  field: references[${options.entry.index}].path`,
    `  reference: ${options.entry.configuredPath}`,
    `  resolved: ${toRelativePath(options.config.rootDir, options.entry.resolvedPath)}`,
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
      detailLines,
      facts: {
        configPath: options.configPath,
        configuredPath: options.entry.configuredPath,
        kind: 'build-reference',
        referenceIndex: options.entry.index,
        resolvedPath: options.entry.resolvedPath,
      },
      filePath: options.configPath,
      locations: [
        { filePath: options.configPath, label: 'build graph config' },
        { filePath: options.entry.resolvedPath, label: 'referenced project' },
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.configPath,
      ),
      reason,
      title: 'Build graph references a non-build project',
    }),
  );
}

function validateBuildGraphConfig(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  findings: ProofFinding[];
  virtualFiles: ReadonlyMap<string, string>;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  if (!options.configPath.includes('/.limina/')) {
    addManagedBoundaryFinding(options);
    return;
  }

  const configObject = readProofConfig(
    options.config,
    options.configPath,
    options.virtualFiles,
  );

  addPureAggregatorFindings({
    config: options.config,
    configObject,
    configPath: options.configPath,
    findings: options.findings,
    role: 'build graph',
    workspaceLookup: options.workspaceLookup,
  });

  const invalidReferences = collectReferenceEntries(
    options.configPath,
    configObject.references,
  ).filter((entry) => !isBuildReferenceTarget(entry.resolvedPath));

  for (const entry of invalidReferences) {
    addInvalidReferenceFinding({ ...options, entry });
  }
}

export function addBuildGraphConfigFindings(options: {
  buildGraphConfigPaths: string[];
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  virtualFiles: ReadonlyMap<string, string>;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  for (const configPath of options.buildGraphConfigPaths) {
    validateBuildGraphConfig({
      config: options.config,
      configPath,
      findings: options.findings,
      virtualFiles: options.virtualFiles,
      workspaceLookup: options.workspaceLookup,
    });
  }
}
