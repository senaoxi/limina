import type { MutationAuthority } from '#utils/mutation-boundary';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toPosixPath,
} from '#utils/path';
import path from 'pathe';
import type {
  OutputDeclarationCopyPlan,
  OutputDeclarationCopyPlanEntry,
  OutputDeclarationCopyProblem,
} from './types';

type DeclarationInputClassification =
  | { kind: 'entry'; value: OutputDeclarationCopyPlanEntry }
  | { kind: 'problem'; value: OutputDeclarationCopyProblem }
  | { kind: 'skip' };

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
  const targetPath = problem.targetPath === undefined ? '' : problem.targetPath;
  return [
    problem.severity,
    problem.reason,
    problem.filePath,
    problem.rootDir,
    problem.outDir,
    targetPath,
  ].join('\0');
}

function entryKey(entry: OutputDeclarationCopyPlanEntry): string {
  return `${entry.sourcePath}\0${entry.targetPath}`;
}

function createProblem(options: {
  filePath: string;
  outDir: string;
  reason: OutputDeclarationCopyProblem['reason'];
  rootDir: string;
  severity: OutputDeclarationCopyProblem['severity'];
  targetPath?: string;
}): OutputDeclarationCopyProblem {
  const problem: OutputDeclarationCopyProblem = {
    filePath: options.filePath,
    outDir: options.outDir,
    reason: options.reason,
    rootDir: options.rootDir,
    severity: options.severity,
  };
  if (options.targetPath !== undefined) {
    problem.targetPath = options.targetPath;
  }
  return problem;
}

function createPlanEntry(options: {
  authority: MutationAuthority | undefined;
  outDir: string;
  rootDir: string;
  sourcePath: string;
  targetPath: string;
}): OutputDeclarationCopyPlanEntry {
  const entry: OutputDeclarationCopyPlanEntry = {
    outDir: options.outDir,
    rootDir: options.rootDir,
    sourcePath: options.sourcePath,
    targetPath: options.targetPath,
  };
  if (options.authority !== undefined) {
    entry.authority = options.authority;
  }
  return entry;
}

function shouldSkipInput(sourcePath: string, outDir: string): boolean {
  if (isInNodeModules(sourcePath)) {
    return true;
  }
  return isPathInsideDirectory(sourcePath, outDir);
}

function classifyTarget(options: {
  authority: MutationAuthority | undefined;
  outDir: string;
  rootDir: string;
  sourcePath: string;
  targetPath: string;
}): DeclarationInputClassification {
  if (options.targetPath === options.outDir) {
    return {
      kind: 'problem',
      value: createProblem({
        filePath: options.sourcePath,
        outDir: options.outDir,
        reason: 'target-is-out-dir',
        rootDir: options.rootDir,
        severity: 'error',
        targetPath: options.targetPath,
      }),
    };
  }
  if (!isPathInsideDirectory(options.targetPath, options.outDir)) {
    return {
      kind: 'problem',
      value: createProblem({
        filePath: options.sourcePath,
        outDir: options.outDir,
        reason: 'target-outside-out-dir',
        rootDir: options.rootDir,
        severity: 'error',
        targetPath: options.targetPath,
      }),
    };
  }
  return { kind: 'entry', value: createPlanEntry(options) };
}

function classifySourcePath(options: {
  authority: MutationAuthority | undefined;
  outDir: string;
  rootDir: string;
  sourcePath: string;
}): DeclarationInputClassification {
  if (shouldSkipInput(options.sourcePath, options.outDir)) {
    return { kind: 'skip' };
  }
  if (!isPathInsideDirectory(options.sourcePath, options.rootDir)) {
    return {
      kind: 'problem',
      value: createProblem({
        filePath: options.sourcePath,
        outDir: options.outDir,
        reason: 'outside-root',
        rootDir: options.rootDir,
        severity: 'warning',
      }),
    };
  }
  const targetPath = normalizeAbsolutePath(
    path.join(
      options.outDir,
      path.relative(options.rootDir, options.sourcePath),
    ),
  );
  return classifyTarget({ ...options, targetPath });
}

function classifyDeclarationInput(options: {
  authority: MutationAuthority | undefined;
  fileName: string;
  outDir: string;
  rootDir: string;
}): DeclarationInputClassification {
  if (!isDeclarationInputFile(options.fileName)) {
    return { kind: 'skip' };
  }
  return classifySourcePath({
    ...options,
    sourcePath: normalizeAbsolutePath(options.fileName),
  });
}

function compareEntries(
  left: OutputDeclarationCopyPlanEntry,
  right: OutputDeclarationCopyPlanEntry,
): number {
  return left.targetPath.localeCompare(right.targetPath);
}

function getProblemTarget(problem: OutputDeclarationCopyProblem): string {
  return problem.targetPath === undefined ? '' : problem.targetPath;
}

function compareProblems(
  left: OutputDeclarationCopyProblem,
  right: OutputDeclarationCopyProblem,
): number {
  const severity = left.severity.localeCompare(right.severity);
  if (severity !== 0) return severity;
  const filePath = left.filePath.localeCompare(right.filePath);
  if (filePath !== 0) return filePath;
  return getProblemTarget(left).localeCompare(getProblemTarget(right));
}

function createPlanResult(
  entries: ReadonlyMap<string, OutputDeclarationCopyPlanEntry>,
  problems: ReadonlyMap<string, OutputDeclarationCopyProblem>,
): OutputDeclarationCopyPlan {
  return {
    entries: [...entries.values()].sort(compareEntries),
    problems: [...problems.values()].sort(compareProblems),
  };
}

function storeClassification(
  result: DeclarationInputClassification,
  entries: Map<string, OutputDeclarationCopyPlanEntry>,
  problems: Map<string, OutputDeclarationCopyProblem>,
): void {
  if (result.kind === 'entry') {
    entries.set(entryKey(result.value), result.value);
    return;
  }
  if (result.kind === 'problem') {
    problems.set(problemKey(result.value), result.value);
  }
}

export function createOutputDeclarationCopyPlan(options: {
  authority?: MutationAuthority;
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
    storeClassification(
      classifyDeclarationInput({
        authority: options.authority,
        fileName,
        outDir,
        rootDir,
      }),
      entries,
      problems,
    );
  }
  return createPlanResult(entries, problems);
}

function addPlanEntries(
  plan: OutputDeclarationCopyPlan,
  entries: Map<string, OutputDeclarationCopyPlanEntry>,
): void {
  for (const entry of plan.entries) {
    entries.set(entryKey(entry), entry);
  }
}

function addPlanProblems(
  plan: OutputDeclarationCopyPlan,
  problems: Map<string, OutputDeclarationCopyProblem>,
): void {
  for (const problem of plan.problems) {
    problems.set(problemKey(problem), problem);
  }
}

export function mergeOutputDeclarationCopyPlans(
  plans: readonly OutputDeclarationCopyPlan[],
): OutputDeclarationCopyPlan {
  const entries = new Map<string, OutputDeclarationCopyPlanEntry>();
  const problems = new Map<string, OutputDeclarationCopyProblem>();
  for (const plan of plans) {
    addPlanEntries(plan, entries);
    addPlanProblems(plan, problems);
  }
  return createPlanResult(entries, problems);
}
