import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import {
  formatJsonValue,
  ignoredSemanticCompilerOptions,
  normalizeCompilerOptionValue,
  normalizeGeneratedDtsTypes,
  type ParsedProofConfig,
  readRelativeTypeFiles,
} from './config-reader';
import {
  createProofDiagnosticFinding,
  getProofPackageIdentity,
} from './finding-utils';
import type { ProofFinding } from './findings';

interface FileSetDifference {
  onlyInDeclaration: string[];
  onlyInCompanion: string[];
}

function collectFileSetDifference(options: {
  config: ResolvedLiminaConfig;
  declaration: ParsedProofConfig;
  companion: ParsedProofConfig;
  companionPath: string;
}): FileSetDifference {
  const declarationFiles = new Set(options.declaration.fileNames);
  const companionFiles = new Set([
    ...options.companion.fileNames,
    ...readRelativeTypeFiles(options.config, options.companionPath),
  ]);

  return {
    onlyInDeclaration: options.declaration.fileNames.filter(
      (fileName) => !companionFiles.has(fileName),
    ),
    onlyInCompanion: [...companionFiles].filter(
      (fileName) => !declarationFiles.has(fileName),
    ),
  };
}

function formatFileList(options: {
  config: ResolvedLiminaConfig;
  files: string[];
  label: string;
}): string[] {
  if (options.files.length === 0) {
    return [];
  }

  const visibleFiles = options.files
    .slice(0, 10)
    .map(
      (fileName) => `    - ${toRelativePath(options.config.rootDir, fileName)}`,
    );
  const overflow = options.files.length - visibleFiles.length;

  return [
    `  ${options.label}:`,
    ...visibleFiles,
    ...(overflow > 0 ? [`    ... ${overflow} more`] : []),
  ];
}

function addFileSetDifferenceFinding(options: {
  config: ResolvedLiminaConfig;
  declarationPath: string;
  companionPath: string;
  difference: FileSetDifference;
  findings: ProofFinding[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const hasDifference =
    options.difference.onlyInDeclaration.length > 0 ||
    options.difference.onlyInCompanion.length > 0;

  if (!hasDifference) {
    return;
  }

  const detailLines = [
    'DTS config file set does not match its local typecheck config:',
    `  config: ${toRelativePath(options.config.rootDir, options.declarationPath)}`,
    `  local: ${toRelativePath(options.config.rootDir, options.companionPath)}`,
    ...formatFileList({
      config: options.config,
      files: options.difference.onlyInDeclaration,
      label: 'only in dts config',
    }),
    ...formatFileList({
      config: options.config,
      files: options.difference.onlyInCompanion,
      label: 'only in local config',
    }),
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
      detailLines,
      facts: {
        companionProjectPath: options.companionPath,
        declarationProjectPath: options.declarationPath,
        kind: 'declaration-file-set',
        onlyInCompanion: options.difference.onlyInCompanion,
        onlyInDeclaration: options.difference.onlyInDeclaration,
      },
      filePath: options.declarationPath,
      locations: [
        { filePath: options.declarationPath, label: 'declaration project' },
        { filePath: options.companionPath, label: 'typecheck companion' },
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.companionPath,
      ),
      reason:
        'Declaration and companion typecheck configs must cover the same source files.',
      title: 'DTS config file set does not match its local typecheck config',
    }),
  );
}

function normalizeSemanticOption(optionName: string, value: unknown): unknown {
  const normalizedTypes =
    optionName === 'types' ? normalizeGeneratedDtsTypes(value) : value;

  return normalizeCompilerOptionValue(normalizedTypes);
}

function addCompilerOptionDifferenceFinding(options: {
  config: ResolvedLiminaConfig;
  declarationPath: string;
  companionPath: string;
  declarationValue: unknown;
  companionValue: unknown;
  findings: ProofFinding[];
  optionName: string;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const detailLines = [
    'DTS config overrides a typecheck compiler option from its local typecheck config:',
    `  config: ${toRelativePath(options.config.rootDir, options.declarationPath)}`,
    `  local: ${toRelativePath(options.config.rootDir, options.companionPath)}`,
    `  option: compilerOptions.${options.optionName}`,
    `  local: ${formatJsonValue(options.companionValue)}`,
    `  dts: ${formatJsonValue(options.declarationValue)}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
      detailLines,
      facts: {
        actual: options.declarationValue,
        companionProjectPath: options.companionPath,
        declarationProjectPath: options.declarationPath,
        expected: options.companionValue,
        kind: 'declaration-option-parity',
        optionName: options.optionName,
      },
      filePath: options.declarationPath,
      locations: [
        { filePath: options.declarationPath, label: 'declaration project' },
        { filePath: options.companionPath, label: 'typecheck companion' },
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.companionPath,
      ),
      reason:
        'Declaration configs may add output behavior but must preserve companion typecheck semantics.',
      title:
        'DTS config overrides a typecheck compiler option from its local typecheck config',
    }),
  );
}

function compareCompilerOption(options: {
  config: ResolvedLiminaConfig;
  declaration: ParsedProofConfig;
  declarationPath: string;
  companion: ParsedProofConfig;
  companionPath: string;
  findings: ProofFinding[];
  optionName: string;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  if (ignoredSemanticCompilerOptions.has(options.optionName)) {
    return;
  }

  const declarationValue = normalizeSemanticOption(
    options.optionName,
    (options.declaration.options as Record<string, unknown>)[
      options.optionName
    ],
  );
  const companionValue = normalizeSemanticOption(
    options.optionName,
    (options.companion.options as Record<string, unknown>)[options.optionName],
  );

  if (formatJsonValue(declarationValue) === formatJsonValue(companionValue)) {
    return;
  }

  addCompilerOptionDifferenceFinding({
    config: options.config,
    declarationPath: options.declarationPath,
    companionPath: options.companionPath,
    declarationValue,
    companionValue,
    findings: options.findings,
    optionName: options.optionName,
    workspaceLookup: options.workspaceLookup,
  });
}

export function addDtsConfigSemanticFindings(options: {
  dtsConfigPath: string;
  dtsConfig: ParsedProofConfig;
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  localConfigPath: string;
  localConfig: ParsedProofConfig;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  addFileSetDifferenceFinding({
    config: options.config,
    declarationPath: options.dtsConfigPath,
    companionPath: options.localConfigPath,
    difference: collectFileSetDifference({
      config: options.config,
      declaration: options.dtsConfig,
      companion: options.localConfig,
      companionPath: options.localConfigPath,
    }),
    findings: options.findings,
    workspaceLookup: options.workspaceLookup,
  });

  const optionNames = new Set([
    ...Object.keys(options.localConfig.options),
    ...Object.keys(options.dtsConfig.options),
  ]);

  for (const optionName of [...optionNames].sort()) {
    compareCompilerOption({
      config: options.config,
      declaration: options.dtsConfig,
      declarationPath: options.dtsConfigPath,
      companion: options.localConfig,
      companionPath: options.localConfigPath,
      findings: options.findings,
      optionName,
      workspaceLookup: options.workspaceLookup,
    });
  }
}
