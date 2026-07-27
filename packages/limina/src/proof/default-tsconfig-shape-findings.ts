import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isOrdinaryTypecheckConfigPath,
  resolveReferencePath,
} from '#core/tsconfig/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { isSolutionStyleTsconfig } from '../core/build-graph/generated/config-readers';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import { addPureAggregatorFindings } from './aggregator-shape-findings';
import { readProofConfig } from './config-reader';
import { isPlainRecord } from './config-values';
import {
  createProofDiagnosticFinding,
  getProofPackageIdentity,
} from './finding-utils';
import type { ProofFinding } from './findings';

interface ReferenceEntry {
  configuredPath: string;
  index: number;
  resolvedPath: string;
}

function collectReferenceEntries(
  configPath: string,
  references: unknown,
): ReferenceEntry[] {
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

function addInvalidReferenceFinding(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  entry: ReferenceEntry;
  findings: ProofFinding[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const reason =
    'tsconfig.json is the default IDE/typecheck entry and must not reference declaration build graph configs.';
  const detailLines = [
    'Default tsconfig.json references a non-typecheck config:',
    `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    `  field: references[${options.entry.index}].path`,
    `  reference: ${options.entry.configuredPath}`,
    `  resolved: ${toRelativePath(options.config.rootDir, options.entry.resolvedPath)}`,
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
      detailLines,
      facts: {
        configPath: options.configPath,
        configuredPath: options.entry.configuredPath,
        kind: 'reference-target',
        referenceIndex: options.entry.index,
        resolvedPath: options.entry.resolvedPath,
      },
      filePath: options.configPath,
      locations: [
        { filePath: options.configPath, label: 'default tsconfig' },
        { filePath: options.entry.resolvedPath, label: 'referenced config' },
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.configPath,
      ),
      reason,
      title: 'Default tsconfig.json references a non-typecheck config',
    }),
  );
}

function shouldValidateDefaultTsconfig(
  configObject: ReturnType<typeof readProofConfig>,
  configPath: string,
): boolean {
  return (
    Object.hasOwn(configObject, 'references') &&
    isSolutionStyleTsconfig(configPath, configObject)
  );
}

function validateDefaultTsconfig(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  findings: ProofFinding[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const configObject = readProofConfig(options.config, options.configPath);

  if (!shouldValidateDefaultTsconfig(configObject, options.configPath)) {
    return;
  }

  addPureAggregatorFindings({
    config: options.config,
    configObject,
    configPath: options.configPath,
    findings: options.findings,
    role: 'tsconfig.json',
    workspaceLookup: options.workspaceLookup,
  });

  const invalidReferences = collectReferenceEntries(
    options.configPath,
    configObject.references,
  ).filter((entry) => !isOrdinaryTypecheckConfigPath(entry.resolvedPath));

  for (const entry of invalidReferences) {
    addInvalidReferenceFinding({ ...options, entry });
  }
}

export function addDefaultTsconfigShapeFindings(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  tsconfigPaths: string[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  for (const configPath of options.tsconfigPaths) {
    validateDefaultTsconfig({
      config: options.config,
      configPath,
      findings: options.findings,
      workspaceLookup: options.workspaceLookup,
    });
  }
}
