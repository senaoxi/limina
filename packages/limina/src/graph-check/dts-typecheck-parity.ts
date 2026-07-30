import type { CheckerProjectConfigCache } from '#checkers';
import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isDtsProjectConfig,
  parseProject,
  type ProjectInfo,
} from '#core/import-graph/context';
import { toRelativePath } from '#utils/path';
import { existsSync } from 'node:fs';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import {
  comparableTypecheckOptions,
  compilerOptionEquals,
  formatCompilerOptionValue,
} from './dts-option-shared';
import type { GraphConfigInvalidFinding, GraphFinding } from './findings';

type AddTypecheckParityProblemsArgs = [
  config: ResolvedLiminaConfig,
  dtsProject: ProjectInfo,
  findings: GraphFinding[],
  checks: CheckCounter,
  checkerName?: string,
  projectConfigCache?: CheckerProjectConfigCache,
];

interface ParityContext {
  checkerName: string | undefined;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  dtsProject: ProjectInfo;
  findings: GraphFinding[];
  projectConfigCache?: CheckerProjectConfigCache;
  typecheckConfigPath: string;
}

function createMissingCompanionFinding(
  context: ParityContext,
): GraphConfigInvalidFinding {
  const reason =
    'every tsconfig*.dts.json project should have a matching tsconfig*.json file with the same typechecking semantics.';
  const lines = [
    'Missing typecheck companion config:',
    `  declaration leaf: ${toRelativePath(context.config.rootDir, context.dtsProject.configPath)}`,
    `  expected typecheck config: ${toRelativePath(context.config.rootDir, context.typecheckConfigPath)}`,
    `  reason: ${reason}`,
  ];

  return {
    checkerName: context.checkerName,
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [
      {
        label: 'expected typecheck config',
        value: context.typecheckConfigPath,
      },
    ],
    facts: {
      declarationProjectPath: context.dtsProject.configPath,
      kind: 'typecheck-parity',
      mismatch: 'missing-companion',
      typecheckProjectPath: context.typecheckConfigPath,
    },
    filePath: context.dtsProject.configPath,
    locations: [
      { filePath: context.dtsProject.configPath, label: 'declaration leaf' },
      {
        filePath: context.typecheckConfigPath,
        label: 'expected typecheck config',
      },
    ],
    presentation: {
      detailLines: lines,
      reason,
      title: 'Missing typecheck companion config',
    },
    task: 'graph:check',
  };
}

function resolveTypecheckProject(context: ParityContext): ProjectInfo | null {
  context.checks.add();

  if (existsSync(context.typecheckConfigPath)) {
    return parseProject(
      context.config,
      context.typecheckConfigPath,
      context.dtsProject,
      undefined,
      context.projectConfigCache,
    );
  }

  context.findings.push(createMissingCompanionFinding(context));
  return null;
}

function createOptionParityFinding(options: {
  buildValue: unknown;
  context: ParityContext;
  optionName: string;
  typecheckValue: unknown;
}): GraphConfigInvalidFinding {
  const reason =
    'tsconfig*.dts.json should emit with the same typechecking semantics as its matching tsconfig*.json companion.';
  const lines = [
    'Typecheck option mismatch between declaration leaf and companion config:',
    `  declaration leaf: ${toRelativePath(options.context.config.rootDir, options.context.dtsProject.configPath)}`,
    `  typecheck config: ${toRelativePath(options.context.config.rootDir, options.context.typecheckConfigPath)}`,
    `  option: compilerOptions.${options.optionName}`,
    `  declaration value: ${formatCompilerOptionValue(options.buildValue)}`,
    `  typecheck value: ${formatCompilerOptionValue(options.typecheckValue)}`,
    `  reason: ${reason}`,
  ];

  return {
    checkerName: options.context.checkerName,
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [
      {
        label: `compilerOptions.${options.optionName}`,
        lines: [
          `declaration value: ${formatCompilerOptionValue(options.buildValue)}`,
          `typecheck value: ${formatCompilerOptionValue(options.typecheckValue)}`,
        ],
      },
    ],
    facts: {
      declarationProjectPath: options.context.dtsProject.configPath,
      kind: 'typecheck-parity',
      mismatch: 'option',
      optionName: options.optionName,
      typecheckProjectPath: options.context.typecheckConfigPath,
    },
    filePath: options.context.dtsProject.configPath,
    locations: [
      {
        filePath: options.context.dtsProject.configPath,
        label: 'declaration leaf',
      },
      {
        filePath: options.context.typecheckConfigPath,
        label: 'typecheck config',
      },
    ],
    presentation: {
      detailLines: lines,
      reason,
      title:
        'Typecheck option mismatch between declaration leaf and companion config',
    },
    task: 'graph:check',
  };
}

function addOptionParityProblems(
  context: ParityContext,
  typecheckProject: ProjectInfo,
): void {
  for (const optionName of comparableTypecheckOptions) {
    context.checks.add();
    const buildValue = context.dtsProject.options[optionName];
    const typecheckValue = typecheckProject.options[optionName];

    if (!compilerOptionEquals(optionName, buildValue, typecheckValue)) {
      context.findings.push(
        createOptionParityFinding({
          buildValue,
          context,
          optionName: String(optionName),
          typecheckValue,
        }),
      );
    }
  }
}

function getMissingFiles(
  dtsProject: ProjectInfo,
  typecheckProject: ProjectInfo,
): string[] {
  const typecheckFiles = new Set(typecheckProject.fileNames);
  return dtsProject.fileNames.filter(
    (fileName) => !typecheckFiles.has(fileName) && !fileName.endsWith('.d.ts'),
  );
}

function createMissingFileLines(
  context: ParityContext,
  missingFiles: readonly string[],
): string[] {
  const displayedFiles = missingFiles
    .slice(0, 10)
    .map(
      (fileName) => `    - ${toRelativePath(context.config.rootDir, fileName)}`,
    );
  const overflowLine =
    missingFiles.length > 10
      ? [`    ...and ${missingFiles.length - 10} more`]
      : [];
  return [...displayedFiles, ...overflowLine];
}

function createFileParityFinding(
  context: ParityContext,
  missingFiles: readonly string[],
): GraphConfigInvalidFinding {
  const reason =
    'a declaration leaf must not emit declarations for files that are not covered by the matching typecheck target.';
  const lines = [
    'Declaration leaf includes files missing from its companion typecheck config:',
    `  declaration leaf: ${toRelativePath(context.config.rootDir, context.dtsProject.configPath)}`,
    `  typecheck config: ${toRelativePath(context.config.rootDir, context.typecheckConfigPath)}`,
    '  files:',
    ...createMissingFileLines(context, missingFiles),
    `  reason: ${reason}`,
  ];

  return {
    checkerName: context.checkerName,
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [
      {
        label: 'files missing from typecheck config',
        lines: [...missingFiles],
      },
    ],
    facts: {
      declarationProjectPath: context.dtsProject.configPath,
      kind: 'typecheck-parity',
      mismatch: 'files',
      typecheckProjectPath: context.typecheckConfigPath,
    },
    filePath: context.dtsProject.configPath,
    locations: [
      { filePath: context.dtsProject.configPath, label: 'declaration leaf' },
      {
        filePath: context.typecheckConfigPath,
        label: 'typecheck config',
      },
      ...missingFiles.map((filePath) => ({
        filePath,
        label: 'missing file',
      })),
    ],
    presentation: {
      detailLines: lines,
      reason,
      title:
        'Declaration leaf includes files missing from its companion typecheck config',
    },
    task: 'graph:check',
  };
}

function addFileParityProblem(
  context: ParityContext,
  typecheckProject: ProjectInfo,
): void {
  const missingFiles = getMissingFiles(context.dtsProject, typecheckProject);
  context.checks.add();

  if (missingFiles.length > 0) {
    context.findings.push(createFileParityFinding(context, missingFiles));
  }
}

export function addTypecheckParityProblems(
  ...args: AddTypecheckParityProblemsArgs
): void {
  const [
    config,
    dtsProject,
    findings,
    checks,
    checkerName,
    projectConfigCache,
  ] = args;

  if (!isDtsProjectConfig(dtsProject.configPath)) return;

  const context: ParityContext = {
    checkerName,
    checks,
    config,
    dtsProject,
    findings,
    projectConfigCache,
    typecheckConfigPath: dtsProject.resolverConfigPath,
  };
  const typecheckProject = resolveTypecheckProject(context);

  if (typecheckProject === null) return;

  addOptionParityProblems(context, typecheckProject);
  addFileParityProblem(context, typecheckProject);
}
