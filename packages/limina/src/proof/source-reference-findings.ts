import type { ResolvedLiminaConfig } from '#config/runner';
import { isOrdinarySourceTypecheckConfigPath } from '#core/tsconfig/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { isSolutionStyleTsconfig } from '../core/build-graph/generated/config-readers';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import { readProofConfig } from './config-reader';
import { isPlainRecord } from './config-values';
import {
  createProofDiagnosticFinding,
  getProofPackageIdentity,
} from './finding-utils';
import type { ProofFinding } from './findings';

function hasImplicitRefs(
  configObject: ReturnType<typeof readProofConfig>,
): boolean {
  if (!isPlainRecord(configObject.liminaOptions)) {
    return false;
  }

  return Object.hasOwn(configObject.liminaOptions, 'implicitRefs');
}

function addSourceLeafReferenceFinding(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  findings: ProofFinding[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const reason =
    'source typecheck configs must not hand-maintain project references; Limina infers static source edges and liminaOptions.implicitRefs documents dynamic or virtual edges.';
  const hint =
    'Remove obsolete tsc -b references from source configs, move IDE aggregation references to a files: [] solution tsconfig.json, or replace dynamic source edges with liminaOptions.implicitRefs.';
  const detailLines = [
    'Source typecheck config declares project references:',
    `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    '  field: references',
    `  reason: ${reason}`,
    `  fix: ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
      detailLines,
      facts: {
        configPath: options.configPath,
        field: 'references',
        kind: 'source-reference-role',
        violation: 'references-on-source-leaf',
      },
      filePath: options.configPath,
      hint,
      locations: [
        { filePath: options.configPath, label: 'source typecheck config' },
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.configPath,
      ),
      reason,
      title: 'Source typecheck config declares project references',
    }),
  );
}

function addSolutionImplicitRefsFinding(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  findings: ProofFinding[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const reason =
    'solution-style tsconfig.json files aggregate typecheck configs and do not own source files, so implicitRefs must live on the source typecheck config that needs the extra edge.';
  const detailLines = [
    'Solution tsconfig declares Limina implicit references:',
    `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    '  field: liminaOptions.implicitRefs',
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
      detailLines,
      facts: {
        configPath: options.configPath,
        field: 'liminaOptions.implicitRefs',
        kind: 'source-reference-role',
        violation: 'implicit-refs-on-solution',
      },
      filePath: options.configPath,
      locations: [{ filePath: options.configPath, label: 'solution config' }],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.configPath,
      ),
      reason,
      title: 'Solution tsconfig declares Limina implicit references',
    }),
  );
}

function getReferenceRoleValidation(
  configPath: string,
  configObject: ReturnType<typeof readProofConfig>,
):
  | ((options: Parameters<typeof addSourceLeafReferenceFinding>[0]) => void)
  | undefined {
  if (!Object.hasOwn(configObject, 'references')) {
    return undefined;
  }

  return isSolutionStyleTsconfig(configPath, configObject)
    ? (options) => {
        if (hasImplicitRefs(configObject)) {
          addSolutionImplicitRefsFinding(options);
        }
      }
    : addSourceLeafReferenceFinding;
}

function validateSourceReferenceConfig(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  findings: ProofFinding[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const configObject = readProofConfig(options.config, options.configPath);
  const validate = getReferenceRoleValidation(options.configPath, configObject);

  validate?.(options);
}

export function addSourceReferenceRoleFindings(options: {
  config: ResolvedLiminaConfig;
  findings: ProofFinding[];
  ordinaryConfigPaths: string[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  const sourceConfigPaths = options.ordinaryConfigPaths.filter(
    isOrdinarySourceTypecheckConfigPath,
  );

  for (const configPath of sourceConfigPaths) {
    validateSourceReferenceConfig({
      config: options.config,
      configPath,
      findings: options.findings,
      workspaceLookup: options.workspaceLookup,
    });
  }
}
