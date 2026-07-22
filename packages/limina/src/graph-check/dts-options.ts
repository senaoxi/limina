import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type ts from 'typescript';

import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isDtsProjectConfig,
  parseProject,
  type ProjectInfo,
} from '#core/import-graph/context';
import { uniqueSortedStrings } from '#utils/collections';
import { toRelativePath } from '#utils/path';

import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import type { GraphConfigInvalidFinding, GraphFinding } from './findings';

const requiredDtsCompilerOptions: [keyof ts.CompilerOptions, unknown][] = [
  ['composite', true],
  ['incremental', true],
  ['noEmit', false],
  ['declaration', true],
];

const requiredDtsPathOptions: (keyof ts.CompilerOptions)[] = [
  'rootDir',
  'outDir',
  'tsBuildInfoFile',
];

const comparableTypecheckOptions: (keyof ts.CompilerOptions)[] = [
  'allowArbitraryExtensions',
  'allowImportingTsExtensions',
  'allowJs',
  'allowSyntheticDefaultImports',
  'baseUrl',
  'checkJs',
  'customConditions',
  'esModuleInterop',
  'exactOptionalPropertyTypes',
  'forceConsistentCasingInFileNames',
  'isolatedDeclarations',
  'isolatedModules',
  'jsx',
  'jsxImportSource',
  'lib',
  'module',
  'moduleDetection',
  'moduleResolution',
  'noFallthroughCasesInSwitch',
  'noImplicitAny',
  'noImplicitOverride',
  'noImplicitReturns',
  'noImplicitThis',
  'noPropertyAccessFromIndexSignature',
  'noUncheckedIndexedAccess',
  'paths',
  'resolveJsonModule',
  'skipLibCheck',
  'strict',
  'strictBindCallApply',
  'strictFunctionTypes',
  'strictNullChecks',
  'strictPropertyInitialization',
  'target',
  'useDefineForClassFields',
  'verbatimModuleSyntax',
];

function formatCompilerOptionValue(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }

  return JSON.stringify(value);
}

function normalizeComparableCompilerOption(
  optionName: keyof ts.CompilerOptions,
  value: unknown,
): unknown {
  if (
    optionName === 'customConditions' &&
    Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === 'string')
  ) {
    return uniqueSortedStrings(value);
  }

  return value;
}

function compilerOptionEquals(
  optionName: keyof ts.CompilerOptions,
  left: unknown,
  right: unknown,
): boolean {
  return isDeepStrictEqual(
    normalizeComparableCompilerOption(optionName, left),
    normalizeComparableCompilerOption(optionName, right),
  );
}

export function addDtsOptionProblems(
  config: ResolvedLiminaConfig,
  project: ProjectInfo,
  findings: GraphFinding[],
  checks: CheckCounter,
  checkerName?: string,
): void {
  if (!isDtsProjectConfig(project.configPath)) {
    return;
  }

  for (const [optionName, expected] of requiredDtsCompilerOptions) {
    checks.add();
    const actual = project.options[optionName];

    if (actual === expected) {
      continue;
    }

    const lines = [
      'Invalid declaration leaf compiler option:',
      `  project: ${toRelativePath(config.rootDir, project.configPath)}`,
      `  option: compilerOptions.${optionName}`,
      `  expected: ${formatCompilerOptionValue(expected)}`,
      `  actual: ${formatCompilerOptionValue(actual)}`,
      '  reason: tsconfig*.dts.json projects are consumed by tsc -b and must emit declarations through composite incremental builds.',
    ];

    findings.push({
      checkerName,
      code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
      evidence: [
        {
          label: `compilerOptions.${optionName}`,
          lines: [
            `expected: ${formatCompilerOptionValue(expected)}`,
            `actual: ${formatCompilerOptionValue(actual)}`,
          ],
        },
      ],
      facts: {
        actual,
        expected,
        kind: 'declaration-option',
        optionName: String(optionName),
        projectPath: project.configPath,
      },
      filePath: project.configPath,
      locations: [
        {
          filePath: project.configPath,
          label: 'declaration leaf',
        },
      ],
      presentation: {
        detailLines: lines,
        reason:
          'tsconfig*.dts.json projects are consumed by tsc -b and must emit declarations through composite incremental builds.',
        title: 'Invalid declaration leaf compiler option',
      },
      task: 'graph:check',
    } satisfies GraphConfigInvalidFinding);
  }

  for (const optionName of requiredDtsPathOptions) {
    checks.add();

    if (project.options[optionName]) {
      continue;
    }

    const lines = [
      'Missing declaration leaf output option:',
      `  project: ${toRelativePath(config.rootDir, project.configPath)}`,
      `  option: compilerOptions.${optionName}`,
      '  reason: declaration leaves need explicit root/output state so declaration output and tsbuildinfo files do not collide.',
    ];

    findings.push({
      checkerName,
      code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
      evidence: [
        {
          label: 'missing compiler option',
          value: `compilerOptions.${optionName}`,
        },
      ],
      facts: {
        actual: project.options[optionName],
        expected: 'configured path',
        kind: 'declaration-option',
        optionName: String(optionName),
        projectPath: project.configPath,
      },
      filePath: project.configPath,
      locations: [
        {
          filePath: project.configPath,
          label: 'declaration leaf',
        },
      ],
      presentation: {
        detailLines: lines,
        reason:
          'declaration leaves need explicit root/output state so declaration output and tsbuildinfo files do not collide.',
        title: 'Missing declaration leaf output option',
      },
      task: 'graph:check',
    } satisfies GraphConfigInvalidFinding);
  }
}

export function addTypecheckParityProblems(
  config: ResolvedLiminaConfig,
  dtsProject: ProjectInfo,
  findings: GraphFinding[],
  checks: CheckCounter,
  checkerName?: string,
): void {
  if (!isDtsProjectConfig(dtsProject.configPath)) {
    return;
  }

  const typecheckConfigPath = dtsProject.resolverConfigPath;

  checks.add();

  if (!existsSync(typecheckConfigPath)) {
    const lines = [
      'Missing typecheck companion config:',
      `  declaration leaf: ${toRelativePath(config.rootDir, dtsProject.configPath)}`,
      `  expected typecheck config: ${toRelativePath(config.rootDir, typecheckConfigPath)}`,
      '  reason: every tsconfig*.dts.json project should have a matching tsconfig*.json file with the same typechecking semantics.',
    ];

    findings.push({
      checkerName,
      code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
      evidence: [
        {
          label: 'expected typecheck config',
          value: typecheckConfigPath,
        },
      ],
      facts: {
        declarationProjectPath: dtsProject.configPath,
        kind: 'typecheck-parity',
        mismatch: 'missing-companion',
        typecheckProjectPath: typecheckConfigPath,
      },
      filePath: dtsProject.configPath,
      locations: [
        {
          filePath: dtsProject.configPath,
          label: 'declaration leaf',
        },
        {
          filePath: typecheckConfigPath,
          label: 'expected typecheck config',
        },
      ],
      presentation: {
        detailLines: lines,
        reason:
          'every tsconfig*.dts.json project should have a matching tsconfig*.json file with the same typechecking semantics.',
        title: 'Missing typecheck companion config',
      },
      task: 'graph:check',
    } satisfies GraphConfigInvalidFinding);
    return;
  }

  const typecheckProject = parseProject(
    config,
    typecheckConfigPath,
    dtsProject,
  );

  for (const optionName of comparableTypecheckOptions) {
    checks.add();
    const buildValue = dtsProject.options[optionName];
    const typecheckValue = typecheckProject.options[optionName];

    if (compilerOptionEquals(optionName, buildValue, typecheckValue)) {
      continue;
    }

    const lines = [
      'Typecheck option mismatch between declaration leaf and companion config:',
      `  declaration leaf: ${toRelativePath(config.rootDir, dtsProject.configPath)}`,
      `  typecheck config: ${toRelativePath(config.rootDir, typecheckConfigPath)}`,
      `  option: compilerOptions.${optionName}`,
      `  declaration value: ${formatCompilerOptionValue(buildValue)}`,
      `  typecheck value: ${formatCompilerOptionValue(typecheckValue)}`,
      '  reason: tsconfig*.dts.json should emit with the same typechecking semantics as its matching tsconfig*.json companion.',
    ];

    findings.push({
      checkerName,
      code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
      evidence: [
        {
          label: `compilerOptions.${optionName}`,
          lines: [
            `declaration value: ${formatCompilerOptionValue(buildValue)}`,
            `typecheck value: ${formatCompilerOptionValue(typecheckValue)}`,
          ],
        },
      ],
      facts: {
        declarationProjectPath: dtsProject.configPath,
        kind: 'typecheck-parity',
        mismatch: 'option',
        optionName: String(optionName),
        typecheckProjectPath: typecheckConfigPath,
      },
      filePath: dtsProject.configPath,
      locations: [
        {
          filePath: dtsProject.configPath,
          label: 'declaration leaf',
        },
        {
          filePath: typecheckConfigPath,
          label: 'typecheck config',
        },
      ],
      presentation: {
        detailLines: lines,
        reason:
          'tsconfig*.dts.json should emit with the same typechecking semantics as its matching tsconfig*.json companion.',
        title:
          'Typecheck option mismatch between declaration leaf and companion config',
      },
      task: 'graph:check',
    } satisfies GraphConfigInvalidFinding);
  }

  const typecheckFiles = new Set(typecheckProject.fileNames);
  const missingFiles = dtsProject.fileNames.filter(
    (fileName) => !typecheckFiles.has(fileName) && !fileName.endsWith('.d.ts'),
  );

  checks.add();

  if (missingFiles.length === 0) {
    return;
  }

  const lines = [
    'Declaration leaf includes files missing from its companion typecheck config:',
    `  declaration leaf: ${toRelativePath(config.rootDir, dtsProject.configPath)}`,
    `  typecheck config: ${toRelativePath(config.rootDir, typecheckConfigPath)}`,
    '  files:',
    ...missingFiles
      .slice(0, 10)
      .map((fileName) => `    - ${toRelativePath(config.rootDir, fileName)}`),
    ...(missingFiles.length > 10
      ? [`    ...and ${missingFiles.length - 10} more`]
      : []),
    '  reason: a declaration leaf must not emit declarations for files that are not covered by the matching typecheck target.',
  ];

  findings.push({
    checkerName,
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [
      {
        label: 'files missing from typecheck config',
        lines: missingFiles,
      },
    ],
    facts: {
      declarationProjectPath: dtsProject.configPath,
      kind: 'typecheck-parity',
      mismatch: 'files',
      typecheckProjectPath: typecheckConfigPath,
    },
    filePath: dtsProject.configPath,
    locations: [
      {
        filePath: dtsProject.configPath,
        label: 'declaration leaf',
      },
      {
        filePath: typecheckConfigPath,
        label: 'typecheck config',
      },
      ...missingFiles.map((filePath) => ({
        filePath,
        label: 'missing file',
      })),
    ],
    presentation: {
      detailLines: lines,
      reason:
        'a declaration leaf must not emit declarations for files that are not covered by the matching typecheck target.',
      title:
        'Declaration leaf includes files missing from its companion typecheck config',
    },
    task: 'graph:check',
  } satisfies GraphConfigInvalidFinding);
}
