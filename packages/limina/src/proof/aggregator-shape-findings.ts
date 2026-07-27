import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import { formatUnknownValue } from './config-values';
import {
  createProofDiagnosticFinding,
  getProofPackageIdentity,
} from './finding-utils';
import type { ProofFinding } from './findings';

export type AggregatorConfigRole = 'build graph' | 'tsconfig.json';

const allowedAggregatorKeys = new Set([
  '$schema',
  'files',
  'liminaOptions',
  'references',
]);

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) ? value.length === 0 : false;
}

function collectFilesIssueLines(
  configObject: Record<string, unknown>,
): string[] {
  if (!Object.hasOwn(configObject, 'files')) {
    return [
      '  - field: files',
      '    reason: configs with project references must declare files: [].',
    ];
  }

  if (isEmptyArray(configObject.files)) {
    return [];
  }

  return [
    '  - field: files',
    `    value: ${formatUnknownValue(configObject.files)}`,
    '    reason: configs with project references must declare files: [].',
  ];
}

function collectExtraFieldsIssueLines(extraKeys: string[]): string[] {
  if (extraKeys.length === 0) {
    return [];
  }

  return [
    `  - fields: ${extraKeys.join(', ')}`,
    '    reason: pure aggregators may only declare $schema, files, references, and Limina metadata; move source inputs and compiler options into leaf configs.',
  ];
}

function getRoleLabel(role: AggregatorConfigRole): string {
  return role === 'build graph'
    ? 'Build graph config'
    : 'Default tsconfig.json';
}

function createCommonFindingOptions(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  configObject: Record<string, unknown>;
  extraKeys: string[];
  issueLines: string[];
  role: AggregatorConfigRole;
  workspaceLookup: WorkspaceLookupIndex;
}) {
  const roleLabel = getRoleLabel(options.role);
  const detailLines = [
    `${roleLabel} is not a pure aggregator:`,
    `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    '  issues:',
    ...options.issueLines,
  ];

  return {
    detailLines,
    filePath: options.configPath,
    locations: [{ filePath: options.configPath, label: 'aggregator config' }],
    packageIdentity: getProofPackageIdentity(
      options.workspaceLookup,
      options.configPath,
    ),
    reason:
      'Configs with project references must be pure aggregators with files: [] and no source or compiler-option fields.',
    title: `${roleLabel} is not a pure aggregator`,
  } as const;
}

function addBuildAggregatorFinding(options: {
  common: ReturnType<typeof createCommonFindingOptions>;
  configObject: Record<string, unknown>;
  configPath: string;
  extraKeys: string[];
  findings: ProofFinding[];
}): void {
  options.findings.push(
    createProofDiagnosticFinding({
      ...options.common,
      code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
      facts: {
        actualFiles: options.configObject.files,
        configPath: options.configPath,
        extraFields: options.extraKeys,
        kind: 'build-aggregator-shape',
        missingFilesField: !Object.hasOwn(options.configObject, 'files'),
      },
    }),
  );
}

function addDefaultAggregatorFinding(options: {
  common: ReturnType<typeof createCommonFindingOptions>;
  configObject: Record<string, unknown>;
  configPath: string;
  extraKeys: string[];
  findings: ProofFinding[];
}): void {
  options.findings.push(
    createProofDiagnosticFinding({
      ...options.common,
      code: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
      facts: {
        actualFiles: options.configObject.files,
        configPath: options.configPath,
        extraFields: options.extraKeys,
        kind: 'aggregator-shape',
        missingFilesField: !Object.hasOwn(options.configObject, 'files'),
      },
    }),
  );
}

export function addPureAggregatorFindings(options: {
  config: ResolvedLiminaConfig;
  configObject: Record<string, unknown>;
  configPath: string;
  findings: ProofFinding[];
  role: AggregatorConfigRole;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const extraKeys = Object.keys(options.configObject)
    .filter((key) => !allowedAggregatorKeys.has(key))
    .sort();
  const issueLines = [
    ...collectFilesIssueLines(options.configObject),
    ...collectExtraFieldsIssueLines(extraKeys),
  ];

  if (issueLines.length === 0) {
    return;
  }

  const common = createCommonFindingOptions({
    config: options.config,
    configObject: options.configObject,
    configPath: options.configPath,
    extraKeys,
    issueLines,
    role: options.role,
    workspaceLookup: options.workspaceLookup,
  });

  if (options.role === 'build graph') {
    addBuildAggregatorFinding({
      common,
      configObject: options.configObject,
      configPath: options.configPath,
      extraKeys,
      findings: options.findings,
    });
    return;
  }

  addDefaultAggregatorFinding({
    common,
    configObject: options.configObject,
    configPath: options.configPath,
    extraKeys,
    findings: options.findings,
  });
}
