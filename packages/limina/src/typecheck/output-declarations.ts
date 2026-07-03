import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'pathe';

import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';

export interface OutputDeclarationCopyPlanEntry {
  sourcePath: string;
  targetPath: string;
}

export type OutputDeclarationCopyProblemReason =
  | 'outside-root'
  | 'target-conflict'
  | 'target-is-out-dir'
  | 'target-outside-out-dir';

export interface OutputDeclarationCopyProblem {
  filePath: string;
  outDir: string;
  reason: OutputDeclarationCopyProblemReason;
  rootDir: string;
  severity: 'error' | 'warning';
  targetPath?: string;
}

export interface OutputDeclarationCopyPlan {
  entries: OutputDeclarationCopyPlanEntry[];
  problems: OutputDeclarationCopyProblem[];
}

export class OutputDeclarationCopyError extends Error {
  readonly problems: OutputDeclarationCopyProblem[];

  constructor(message: string, problems: OutputDeclarationCopyProblem[]) {
    super(message);
    this.name = 'OutputDeclarationCopyError';
    this.problems = problems;
  }
}

export function isDeclarationInputFile(fileName: string): boolean {
  return (
    fileName.endsWith('.d.ts') ||
    fileName.endsWith('.d.cts') ||
    fileName.endsWith('.d.mts')
  );
}

function isInNodeModules(filePath: string): boolean {
  return toPosixPath(normalizeAbsolutePath(filePath))
    .split('/')
    .includes('node_modules');
}

function problemKey(problem: OutputDeclarationCopyProblem): string {
  return [
    problem.severity,
    problem.reason,
    problem.filePath,
    problem.rootDir,
    problem.outDir,
    problem.targetPath ?? '',
  ].join('\0');
}

function entryKey(entry: OutputDeclarationCopyPlanEntry): string {
  return `${entry.sourcePath}\0${entry.targetPath}`;
}

export function createOutputDeclarationCopyPlan(options: {
  fileNames: string[];
  outDir: string;
  projectRootDir: string;
  rootDir: string;
}): OutputDeclarationCopyPlan {
  const rootDir = normalizeAbsolutePath(options.rootDir);
  const outDir = normalizeAbsolutePath(options.outDir);
  const entries = new Map<string, OutputDeclarationCopyPlanEntry>();
  const problems = new Map<string, OutputDeclarationCopyProblem>();

  for (const fileName of options.fileNames) {
    if (!isDeclarationInputFile(fileName)) {
      continue;
    }

    const sourcePath = normalizeAbsolutePath(fileName);

    if (isInNodeModules(sourcePath)) {
      continue;
    }

    if (isPathInsideDirectory(sourcePath, outDir)) {
      continue;
    }

    if (!isPathInsideDirectory(sourcePath, rootDir)) {
      const problem: OutputDeclarationCopyProblem = {
        filePath: sourcePath,
        outDir,
        reason: 'outside-root',
        rootDir,
        severity: 'warning',
      };

      problems.set(problemKey(problem), problem);
      continue;
    }

    const targetPath = normalizeAbsolutePath(
      path.join(outDir, path.relative(rootDir, sourcePath)),
    );

    if (targetPath === outDir) {
      const problem: OutputDeclarationCopyProblem = {
        filePath: sourcePath,
        outDir,
        reason: 'target-is-out-dir',
        rootDir,
        severity: 'error',
        targetPath,
      };

      problems.set(problemKey(problem), problem);
      continue;
    }

    if (!isPathInsideDirectory(targetPath, outDir)) {
      const problem: OutputDeclarationCopyProblem = {
        filePath: sourcePath,
        outDir,
        reason: 'target-outside-out-dir',
        rootDir,
        severity: 'error',
        targetPath,
      };

      problems.set(problemKey(problem), problem);
      continue;
    }

    const entry = {
      sourcePath,
      targetPath,
    };

    entries.set(entryKey(entry), entry);
  }

  return {
    entries: [...entries.values()].sort((left, right) =>
      left.targetPath.localeCompare(right.targetPath),
    ),
    problems: [...problems.values()].sort(
      (left, right) =>
        left.severity.localeCompare(right.severity) ||
        left.filePath.localeCompare(right.filePath) ||
        (left.targetPath ?? '').localeCompare(right.targetPath ?? ''),
    ),
  };
}

export function mergeOutputDeclarationCopyPlans(
  plans: readonly OutputDeclarationCopyPlan[],
): OutputDeclarationCopyPlan {
  const entries = new Map<string, OutputDeclarationCopyPlanEntry>();
  const problems = new Map<string, OutputDeclarationCopyProblem>();

  for (const plan of plans) {
    for (const entry of plan.entries) {
      entries.set(entryKey(entry), entry);
    }

    for (const problem of plan.problems) {
      problems.set(problemKey(problem), problem);
    }
  }

  return {
    entries: [...entries.values()].sort((left, right) =>
      left.targetPath.localeCompare(right.targetPath),
    ),
    problems: [...problems.values()].sort(
      (left, right) =>
        left.severity.localeCompare(right.severity) ||
        left.filePath.localeCompare(right.filePath) ||
        (left.targetPath ?? '').localeCompare(right.targetPath ?? ''),
    ),
  };
}

function formatProblemPath(projectRootDir: string, filePath: string): string {
  return toRelativePath(projectRootDir, filePath);
}

function formatWarningProblem(options: {
  problem: OutputDeclarationCopyProblem;
  projectRootDir: string;
}): string[] {
  return [
    `  file: ${formatProblemPath(options.projectRootDir, options.problem.filePath)}`,
    `  rootDir: ${formatProblemPath(options.projectRootDir, options.problem.rootDir)}`,
    `  outDir: ${formatProblemPath(options.projectRootDir, options.problem.outDir)}`,
    '  reason: TypeScript uses this declaration input during build, but Limina only copies declaration inputs under output rootDir.',
    '  fix: move the declaration under rootDir, widen liminaOptions.outputs.rootDir, or add an explicit copy step.',
  ];
}

function assertNeverProblemReason(reason: never): never {
  throw new Error(
    `Unsupported output declaration copy problem reason: ${reason}`,
  );
}

function formatErrorProblem(options: {
  problem: OutputDeclarationCopyProblem;
  projectRootDir: string;
}): string[] {
  switch (options.problem.reason) {
    case 'target-conflict': {
      return [
        'Output declaration copy conflict:',
        `  source: ${formatProblemPath(options.projectRootDir, options.problem.filePath)}`,
        `  target: ${formatProblemPath(options.projectRootDir, options.problem.targetPath ?? options.problem.outDir)}`,
        '  reason: target already exists with different content.',
        '  fix: rename the declaration input, remove the conflicting emitted file, or exclude the declaration input.',
      ];
    }
    case 'target-is-out-dir': {
      return [
        'Output declaration copy target is invalid:',
        `  source: ${formatProblemPath(options.projectRootDir, options.problem.filePath)}`,
        `  target: ${formatProblemPath(options.projectRootDir, options.problem.targetPath ?? options.problem.outDir)}`,
        '  reason: declaration input maps to the output directory itself.',
        '  fix: move the declaration under a file path inside rootDir or adjust liminaOptions.outputs.',
      ];
    }
    case 'target-outside-out-dir': {
      return [
        'Output declaration copy target escapes outDir:',
        `  source: ${formatProblemPath(options.projectRootDir, options.problem.filePath)}`,
        `  target: ${formatProblemPath(options.projectRootDir, options.problem.targetPath ?? options.problem.outDir)}`,
        `  outDir: ${formatProblemPath(options.projectRootDir, options.problem.outDir)}`,
        '  reason: declaration input target path is outside output outDir.',
        '  fix: adjust liminaOptions.outputs.rootDir and outDir so copied declaration inputs stay inside outDir.',
      ];
    }
    case 'outside-root': {
      return [
        'Output declaration input is outside rootDir:',
        ...formatWarningProblem(options),
      ];
    }
    default: {
      return assertNeverProblemReason(options.problem.reason);
    }
  }
}

export function formatOutputDeclarationCopyWarnings(options: {
  problems: readonly OutputDeclarationCopyProblem[];
  projectRootDir: string;
}): string | null {
  const warningProblems = options.problems.filter(
    (problem) => problem.severity === 'warning',
  );

  if (warningProblems.length === 0) {
    return null;
  }

  return [
    'Output declaration inputs outside rootDir were not copied:',
    ...warningProblems.flatMap((problem, index) => [
      ...(index === 0 ? [] : ['']),
      ...formatWarningProblem({
        problem,
        projectRootDir: options.projectRootDir,
      }),
    ]),
  ].join('\n');
}

export function formatOutputDeclarationCopyErrors(options: {
  problems: readonly OutputDeclarationCopyProblem[];
  projectRootDir: string;
}): string | null {
  const errorProblems = options.problems.filter(
    (problem) => problem.severity === 'error',
  );

  if (errorProblems.length === 0) {
    return null;
  }

  return errorProblems
    .flatMap((problem, index) => [
      ...(index === 0 ? [] : ['']),
      ...formatErrorProblem({
        problem,
        projectRootDir: options.projectRootDir,
      }),
    ])
    .join('\n');
}

export async function copyOutputDeclarationInputs(
  plan: OutputDeclarationCopyPlan,
  options: {
    projectRootDir: string;
  },
): Promise<void> {
  const plannedError = formatOutputDeclarationCopyErrors({
    problems: plan.problems,
    projectRootDir: options.projectRootDir,
  });

  if (plannedError) {
    throw new OutputDeclarationCopyError(
      plannedError,
      plan.problems.filter((problem) => problem.severity === 'error'),
    );
  }

  for (const entry of plan.entries) {
    if (existsSync(entry.targetPath)) {
      const [sourceContent, targetContent] = await Promise.all([
        readFile(entry.sourcePath),
        readFile(entry.targetPath),
      ]);

      if (sourceContent.equals(targetContent)) {
        continue;
      }

      const problem: OutputDeclarationCopyProblem = {
        filePath: entry.sourcePath,
        outDir: path.dirname(entry.targetPath),
        reason: 'target-conflict',
        rootDir: path.dirname(entry.sourcePath),
        severity: 'error',
        targetPath: entry.targetPath,
      };
      const message = formatOutputDeclarationCopyErrors({
        problems: [problem],
        projectRootDir: options.projectRootDir,
      });

      throw new OutputDeclarationCopyError(message ?? '', [problem]);
    }

    await mkdir(path.dirname(entry.targetPath), { recursive: true });
    await copyFile(entry.sourcePath, entry.targetPath);
  }
}
