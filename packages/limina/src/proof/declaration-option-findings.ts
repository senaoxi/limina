import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { ParsedProofConfig } from './config-reader';
import {
  createProofDiagnosticFinding,
  getProofPackageIdentity,
} from './finding-utils';
import type { ProofFinding } from './findings';

interface CompilerOptionExpectation {
  actual: unknown;
  expected: boolean;
  optionName: 'composite' | 'declaration' | 'noEmit';
  title: string;
}

function getCompilerOptionExpectations(
  config: ParsedProofConfig,
): CompilerOptionExpectation[] {
  return [
    {
      actual: config.options.composite,
      expected: true,
      optionName: 'composite',
      title: 'DTS config is not valid for tsc -b',
    },
    {
      actual: config.options.noEmit,
      expected: false,
      optionName: 'noEmit',
      title: 'DTS config is not valid for tsc -b',
    },
    {
      actual: config.options.declaration,
      expected: true,
      optionName: 'declaration',
      title: 'DTS config is not valid for declaration emit',
    },
  ];
}

function isExpectationSatisfied(
  expectation: CompilerOptionExpectation,
): boolean {
  if (expectation.expected) {
    return expectation.actual === true;
  }

  return expectation.actual !== true;
}

function createExpectationReason(
  expectation: CompilerOptionExpectation,
): string {
  const requirement = expectation.expected ? 'be true' : 'not be true';

  return `final compilerOptions.${expectation.optionName} must ${requirement}.`;
}

function addCompilerOptionFinding(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  expectation: CompilerOptionExpectation;
  findings: ProofFinding[];
  localConfigPath: string;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  if (isExpectationSatisfied(options.expectation)) {
    return;
  }

  const reason = createExpectationReason(options.expectation);
  const detailLines = [
    `${options.expectation.title}:`,
    `  config: ${toRelativePath(options.config.rootDir, options.configPath)}`,
    `  reason: ${reason}`,
  ];

  options.findings.push(
    createProofDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.proofCheckerCoverageInvalid,
      detailLines,
      facts: {
        actual: options.expectation.actual,
        configPath: options.configPath,
        expected: options.expectation.expected,
        kind: 'declaration-compiler-option',
        optionName: options.expectation.optionName,
      },
      filePath: options.configPath,
      locations: [
        { filePath: options.configPath, label: 'declaration project' },
      ],
      packageIdentity: getProofPackageIdentity(
        options.workspaceLookup,
        options.localConfigPath,
      ),
      reason,
      title: options.expectation.title,
    }),
  );
}

export function addDeclarationCompilerOptionFindings(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  declarationConfig: ParsedProofConfig;
  findings: ProofFinding[];
  localConfigPath: string;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  for (const expectation of getCompilerOptionExpectations(
    options.declarationConfig,
  )) {
    addCompilerOptionFinding({
      config: options.config,
      configPath: options.configPath,
      expectation,
      findings: options.findings,
      localConfigPath: options.localConfigPath,
      workspaceLookup: options.workspaceLookup,
    });
  }
}
