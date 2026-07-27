import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isDtsProjectConfig,
  type ProjectInfo,
} from '#core/import-graph/context';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import {
  formatCompilerOptionValue,
  requiredDtsCompilerOptions,
  requiredDtsPathOptions,
} from './dts-option-shared';
import type { GraphConfigInvalidFinding, GraphFinding } from './findings';

type AddDtsOptionProblemsArgs = [
  config: ResolvedLiminaConfig,
  project: ProjectInfo,
  findings: GraphFinding[],
  checks: CheckCounter,
  checkerName?: string,
];

interface DeclarationOptionContext {
  checkerName: string | undefined;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  project: ProjectInfo;
}

function createCompilerOptionFinding(options: {
  actual: unknown;
  checkerName: string | undefined;
  config: ResolvedLiminaConfig;
  expected: unknown;
  optionName: string;
  project: ProjectInfo;
}): GraphConfigInvalidFinding {
  const reason =
    'tsconfig*.dts.json projects are consumed by tsc -b and must emit declarations through composite incremental builds.';
  const lines = [
    'Invalid declaration leaf compiler option:',
    `  project: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  option: compilerOptions.${options.optionName}`,
    `  expected: ${formatCompilerOptionValue(options.expected)}`,
    `  actual: ${formatCompilerOptionValue(options.actual)}`,
    `  reason: ${reason}`,
  ];

  return {
    checkerName: options.checkerName,
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [
      {
        label: `compilerOptions.${options.optionName}`,
        lines: [
          `expected: ${formatCompilerOptionValue(options.expected)}`,
          `actual: ${formatCompilerOptionValue(options.actual)}`,
        ],
      },
    ],
    facts: {
      actual: options.actual,
      expected: options.expected,
      kind: 'declaration-option',
      optionName: options.optionName,
      projectPath: options.project.configPath,
    },
    filePath: options.project.configPath,
    locations: [
      { filePath: options.project.configPath, label: 'declaration leaf' },
    ],
    presentation: {
      detailLines: lines,
      reason,
      title: 'Invalid declaration leaf compiler option',
    },
    task: 'graph:check',
  };
}

function createPathOptionFinding(options: {
  checkerName: string | undefined;
  config: ResolvedLiminaConfig;
  optionName: string;
  project: ProjectInfo;
}): GraphConfigInvalidFinding {
  const reason =
    'declaration leaves need explicit root/output state so declaration output and tsbuildinfo files do not collide.';
  const lines = [
    'Missing declaration leaf output option:',
    `  project: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  option: compilerOptions.${options.optionName}`,
    `  reason: ${reason}`,
  ];

  return {
    checkerName: options.checkerName,
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [
      {
        label: 'missing compiler option',
        value: `compilerOptions.${options.optionName}`,
      },
    ],
    facts: {
      actual: options.project.options[options.optionName],
      expected: 'configured path',
      kind: 'declaration-option',
      optionName: options.optionName,
      projectPath: options.project.configPath,
    },
    filePath: options.project.configPath,
    locations: [
      { filePath: options.project.configPath, label: 'declaration leaf' },
    ],
    presentation: {
      detailLines: lines,
      reason,
      title: 'Missing declaration leaf output option',
    },
    task: 'graph:check',
  };
}

function addRequiredCompilerOptionProblems(
  context: DeclarationOptionContext,
): void {
  for (const [optionName, expected] of requiredDtsCompilerOptions) {
    context.checks.add();
    const actual = context.project.options[optionName];

    if (actual !== expected) {
      context.findings.push(
        createCompilerOptionFinding({
          actual,
          checkerName: context.checkerName,
          config: context.config,
          expected,
          optionName: String(optionName),
          project: context.project,
        }),
      );
    }
  }
}

function addRequiredPathOptionProblems(
  context: DeclarationOptionContext,
): void {
  for (const optionName of requiredDtsPathOptions) {
    context.checks.add();

    if (!context.project.options[optionName]) {
      context.findings.push(
        createPathOptionFinding({
          checkerName: context.checkerName,
          config: context.config,
          optionName: String(optionName),
          project: context.project,
        }),
      );
    }
  }
}

export function addDtsOptionProblems(...args: AddDtsOptionProblemsArgs): void {
  const [config, project, findings, checks, checkerName] = args;

  if (!isDtsProjectConfig(project.configPath)) {
    return;
  }

  const context: DeclarationOptionContext = {
    checkerName,
    checks,
    config,
    findings,
    project,
  };
  addRequiredCompilerOptionProblems(context);
  addRequiredPathOptionProblems(context);
}
