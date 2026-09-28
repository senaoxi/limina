import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { existsSync } from 'node:fs';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import { readProofConfig } from './config-reader';
import {
  createProofDiagnosticFinding,
  getProofPackageIdentity,
} from './finding-utils';
import type { ProofFinding } from './findings';

function groupConfigsByDirectory(configPaths: string[]): Map<string, string[]> {
  const configsByDirectory = new Map<string, string[]>();

  for (const configPath of configPaths) {
    const directory = path.dirname(configPath);
    const configs = configsByDirectory.get(directory) ?? [];

    configs.push(configPath);
    configsByDirectory.set(directory, configs);
  }

  return configsByDirectory;
}

function addMissingDefaultFinding(options: {
  config: ResolvedLiminaConfig;
  defaultConfigPath: string;
  directory: string;
  findings: ProofFinding[];
  scopedConfigPaths: string[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const reason =
    'tsconfig.json is the default IDE/typecheck entry for its directory.';
  const detailLines = [
    'Directory with typecheck environments is missing default tsconfig.json:',
    `  directory: ${toRelativePath(options.config.rootDir, options.directory)}`,
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
      detailLines,
      facts: {
        defaultConfigPath: options.defaultConfigPath,
        directoryPath: options.directory,
        environmentConfigPaths: options.scopedConfigPaths,
        kind: 'environment-layout',
        violation: 'missing-default',
      },
      filePath: options.defaultConfigPath,
      locations: [
        {
          filePath: options.defaultConfigPath,
          label: 'expected default tsconfig',
        },
        ...options.scopedConfigPaths.map((filePath) => ({
          filePath,
          label: 'typecheck environment',
        })),
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.directory,
      ),
      reason,
      title:
        'Directory with typecheck environments is missing default tsconfig.json',
    }),
  );
}

function addSingleEnvironmentFinding(options: {
  config: ResolvedLiminaConfig;
  defaultConfigPath: string;
  directory: string;
  findings: ProofFinding[];
  scopedConfigPath: string;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const reason =
    'directories with only one type environment should make tsconfig.json the leaf entry.';
  const detailLines = [
    'Single typecheck environment should use default tsconfig.json:',
    `  config: ${toRelativePath(options.config.rootDir, options.scopedConfigPath)}`,
    `  default: ${toRelativePath(options.config.rootDir, options.defaultConfigPath)}`,
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
      detailLines,
      facts: {
        defaultConfigPath: options.defaultConfigPath,
        directoryPath: options.directory,
        environmentConfigPaths: [options.scopedConfigPath],
        kind: 'environment-layout',
        violation: 'single-environment-uses-named-config',
      },
      filePath: options.scopedConfigPath,
      locations: [
        { filePath: options.scopedConfigPath, label: 'named typecheck config' },
        { filePath: options.defaultConfigPath, label: 'default tsconfig' },
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.defaultConfigPath,
      ),
      reason,
      title: 'Single typecheck environment should use default tsconfig.json',
    }),
  );
}

function addMissingAggregatorFinding(options: {
  config: ResolvedLiminaConfig;
  defaultConfigPath: string;
  directory: string;
  findings: ProofFinding[];
  scopedConfigPaths: string[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const reason =
    'multiple type environments require a default IDE/typecheck aggregator.';
  const detailLines = [
    'Directory with multiple typecheck environments must use tsconfig.json as an aggregator:',
    `  config: ${toRelativePath(options.config.rootDir, options.defaultConfigPath)}`,
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofDefaultTsconfigInvalid,
      detailLines,
      facts: {
        defaultConfigPath: options.defaultConfigPath,
        directoryPath: options.directory,
        environmentConfigPaths: options.scopedConfigPaths,
        kind: 'environment-layout',
        violation: 'multiple-environments-not-aggregated',
      },
      filePath: options.defaultConfigPath,
      locations: [
        { filePath: options.defaultConfigPath, label: 'default tsconfig' },
        ...options.scopedConfigPaths.map((filePath) => ({
          filePath,
          label: 'typecheck environment',
        })),
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.defaultConfigPath,
      ),
      reason,
      title:
        'Directory with multiple typecheck environments must use tsconfig.json as an aggregator',
    }),
  );
}

function validateMultipleEnvironments(options: {
  config: ResolvedLiminaConfig;
  defaultConfigPath: string;
  directory: string;
  findings: ProofFinding[];
  scopedConfigPaths: string[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const configObject = readProofConfig(
    options.config,
    options.defaultConfigPath,
  );

  if (!Object.hasOwn(configObject, 'references')) {
    addMissingAggregatorFinding(options);
  }
}

function getScopedConfigPaths(configPaths: string[]): string[] {
  return configPaths.filter(
    (configPath) => path.basename(configPath) !== 'tsconfig.json',
  );
}

function selectEnvironmentValidation(
  defaultConfigPath: string,
  scopedConfigPaths: string[],
): (options: {
  config: ResolvedLiminaConfig;
  defaultConfigPath: string;
  directory: string;
  findings: ProofFinding[];
  scopedConfigPaths: string[];
  workspaceLookup: WorkspaceLookupIndex;
}) => void {
  if (!existsSync(defaultConfigPath)) {
    return addMissingDefaultFinding;
  }

  if (scopedConfigPaths.length === 1) {
    return (options) =>
      addSingleEnvironmentFinding({
        ...options,
        scopedConfigPath: scopedConfigPaths[0]!,
      });
  }

  return validateMultipleEnvironments;
}

function validateEnvironmentDirectory(options: {
  config: ResolvedLiminaConfig;
  configPaths: string[];
  directory: string;
  findings: ProofFinding[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const scopedConfigPaths = getScopedConfigPaths(options.configPaths);

  if (scopedConfigPaths.length === 0) {
    return;
  }

  const defaultConfigPath = normalizeAbsolutePath(
    path.join(options.directory, 'tsconfig.json'),
  );
  const findingOptions = {
    config: options.config,
    defaultConfigPath,
    directory: options.directory,
    findings: options.findings,
    scopedConfigPaths,
    workspaceLookup: options.workspaceLookup,
  };

  const validation = selectEnvironmentValidation(
    defaultConfigPath,
    scopedConfigPaths,
  );

  validation(findingOptions);
}

export function addDefaultTsconfigEnvironmentFindings(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  ordinaryConfigPaths: string[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const configsByDirectory = groupConfigsByDirectory(
    options.ordinaryConfigPaths,
  );

  for (const [directory, configPaths] of configsByDirectory) {
    validateEnvironmentDirectory({
      config: options.config,
      configPaths,
      directory,
      findings: options.findings,
      workspaceLookup: options.workspaceLookup,
    });
  }
}
