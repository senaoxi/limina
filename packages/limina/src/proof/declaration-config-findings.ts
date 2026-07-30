import type {
  CheckerProjectConfigCache,
  CheckerProjectParseContext,
} from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { existsSync } from 'node:fs';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import {
  configExtendsPathTransitively,
  getProofCompanionConfigPath,
  normalizeRawExtends,
  parseProofConfig,
  readProofConfig,
} from './config-reader';
import { addDeclarationCompilerOptionFindings } from './declaration-option-findings';
import { addDtsConfigSemanticFindings } from './declaration-parity';
import {
  createProofDiagnosticFinding,
  getProofPackageIdentity,
} from './finding-utils';
import type { ProofFinding } from './findings';

function addManagedBoundaryFinding(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  findings: ProofFinding[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const reason =
    'declaration configs are Limina-managed under .limina and derived from checker.include source tsconfigs.';
  const detailLines = [
    'Source-level DTS config violates the managed config boundary:',
    `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
      detailLines,
      facts: {
        configPath: options.configPath,
        configRole: 'declaration-leaf',
        kind: 'managed-config-boundary',
      },
      filePath: options.configPath,
      locations: [
        { filePath: options.configPath, label: 'declaration config' },
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.configPath,
      ),
      reason,
      title: 'Source-level DTS config violates the managed config boundary',
    }),
  );
}

function addMissingCompanionFinding(options: {
  config: ResolvedLiminaConfig;
  configObject: ReturnType<typeof readProofConfig>;
  dtsConfigPath: string;
  findings: ProofFinding[];
  localConfigPath: string;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const detailLines = [
    'DTS config is missing its local typecheck config:',
    `  config: ${toRelativePath(options.config.rootDir, options.dtsConfigPath)}`,
    `  expected: ${toRelativePath(options.config.rootDir, options.localConfigPath)}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
      detailLines,
      facts: {
        companionProjectPath: options.localConfigPath,
        declarationProjectPath: options.dtsConfigPath,
        directExtends: normalizeRawExtends(options.configObject.extends),
        kind: 'declaration-companion',
        violation: 'missing',
      },
      filePath: options.dtsConfigPath,
      locations: [
        { filePath: options.dtsConfigPath, label: 'declaration project' },
        { filePath: options.localConfigPath, label: 'expected companion' },
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.localConfigPath,
      ),
      reason:
        'Every declaration project must have an existing local typecheck companion.',
      title: 'DTS config is missing its local typecheck config',
    }),
  );
}

function addDtsCompanionExtendsFinding(options: {
  config: ResolvedLiminaConfig;
  configObject: ReturnType<typeof readProofConfig>;
  dtsConfigPath: string;
  findings: ProofFinding[];
  localConfigPath: string;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const extendsCompanion = configExtendsPathTransitively({
    config: options.config,
    configObject: options.configObject,
    configPath: options.dtsConfigPath,
    targetConfigPath: options.localConfigPath,
  });

  if (extendsCompanion) {
    return;
  }

  const rawExtends = normalizeRawExtends(options.configObject.extends);
  const reason =
    'tsconfig*.dts.json must add only declaration/build output behavior on top of the matching tsconfig*.json.';
  const detailLines = [
    'Declaration leaf does not transitively extend its companion typecheck config:',
    `  declaration leaf: ${toRelativePath(options.config.rootDir, options.dtsConfigPath)}`,
    `  expected companion: ${toRelativePath(options.config.rootDir, options.localConfigPath)}`,
    `  direct extends: ${rawExtends.length > 0 ? rawExtends.join(', ') : '(none)'}`,
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
      detailLines,
      facts: {
        companionProjectPath: options.localConfigPath,
        declarationProjectPath: options.dtsConfigPath,
        directExtends: rawExtends,
        kind: 'declaration-companion',
        violation: 'not-extended',
      },
      filePath: options.dtsConfigPath,
      locations: [
        { filePath: options.dtsConfigPath, label: 'declaration project' },
        { filePath: options.localConfigPath, label: 'expected companion' },
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.localConfigPath,
      ),
      reason,
      title:
        'Declaration leaf does not transitively extend its companion typecheck config',
    }),
  );
}

function validateManagedDeclarationConfig(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  findings: ProofFinding[];
  projectContext?: CheckerProjectParseContext;
  projectConfigCache?: CheckerProjectConfigCache;
  virtualFiles: ReadonlyMap<string, string>;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const configObject = readProofConfig(
    options.config,
    options.configPath,
    options.virtualFiles,
  );
  const localConfigPath = getProofCompanionConfigPath(
    options.configPath,
    options.virtualFiles,
  );

  if (!existsSync(localConfigPath)) {
    addMissingCompanionFinding({
      config: options.config,
      configObject,
      dtsConfigPath: options.configPath,
      findings: options.findings,
      localConfigPath,
      workspaceLookup: options.workspaceLookup,
    });
    return;
  }

  addDtsCompanionExtendsFinding({
    config: options.config,
    configObject,
    dtsConfigPath: options.configPath,
    findings: options.findings,
    localConfigPath,
    workspaceLookup: options.workspaceLookup,
  });
  const dtsConfig = parseProofConfig({
    config: options.config,
    configPath: options.configPath,
    context: options.projectContext,
    projectConfigCache: options.projectConfigCache,
    virtualFiles: options.virtualFiles,
  });
  const localConfig = parseProofConfig({
    config: options.config,
    configPath: localConfigPath,
    context: options.projectContext,
    projectConfigCache: options.projectConfigCache,
  });

  addDeclarationCompilerOptionFindings({
    config: options.config,
    configPath: options.configPath,
    declarationConfig: dtsConfig,
    findings: options.findings,
    localConfigPath,
    workspaceLookup: options.workspaceLookup,
  });

  addDtsConfigSemanticFindings({
    config: options.config,
    dtsConfig,
    dtsConfigPath: options.configPath,
    findings: options.findings,
    localConfig,
    localConfigPath,
    workspaceLookup: options.workspaceLookup,
  });
}

export function addDtsConfigFindings(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  graphProjectPaths: Set<string>;
  dtsConfigPaths: string[];
  projectContextsByPath: Map<string, CheckerProjectParseContext>;
  projectConfigCache?: CheckerProjectConfigCache;
  virtualFiles: ReadonlyMap<string, string>;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  for (const configPath of options.dtsConfigPaths) {
    if (!options.graphProjectPaths.has(configPath)) {
      addManagedBoundaryFinding({
        config: options.config,
        configPath,
        findings: options.findings,
        workspaceLookup: options.workspaceLookup,
      });
      continue;
    }

    validateManagedDeclarationConfig({
      config: options.config,
      configPath,
      findings: options.findings,
      projectContext: options.projectContextsByPath.get(configPath),
      virtualFiles: options.virtualFiles,
      workspaceLookup: options.workspaceLookup,
    });
  }
}
