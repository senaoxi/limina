import { toRelativePath } from '#utils/path';
import type {
  OutputDeclarationCopyProblem,
  OutputDeclarationCopyProblemReason,
} from './types';

interface FormatProblemOptions {
  problem: OutputDeclarationCopyProblem;
  projectRootDir: string;
}

function formatProblemPath(projectRootDir: string, filePath: string): string {
  return toRelativePath(projectRootDir, filePath);
}

function getTargetPath(problem: OutputDeclarationCopyProblem): string {
  return problem.targetPath === undefined ? problem.outDir : problem.targetPath;
}

function formatWarningProblem(options: FormatProblemOptions): string[] {
  return [
    `  file: ${formatProblemPath(options.projectRootDir, options.problem.filePath)}`,
    `  rootDir: ${formatProblemPath(options.projectRootDir, options.problem.rootDir)}`,
    `  outDir: ${formatProblemPath(options.projectRootDir, options.problem.outDir)}`,
    '  reason: TypeScript uses this declaration input during build, but Limina only copies declaration inputs under output rootDir.',
    '  fix: move the declaration under rootDir, widen liminaOptions.outputs.rootDir, or add an explicit copy step.',
  ];
}

function formatConflict(options: FormatProblemOptions): string[] {
  return [
    'Output declaration copy conflict:',
    `  source: ${formatProblemPath(options.projectRootDir, options.problem.filePath)}`,
    `  target: ${formatProblemPath(options.projectRootDir, getTargetPath(options.problem))}`,
    '  reason: target already exists with different content.',
    '  fix: rename the declaration input, remove the conflicting emitted file, or exclude the declaration input.',
  ];
}

function formatTargetIsOutDir(options: FormatProblemOptions): string[] {
  return [
    'Output declaration copy target is invalid:',
    `  source: ${formatProblemPath(options.projectRootDir, options.problem.filePath)}`,
    `  target: ${formatProblemPath(options.projectRootDir, getTargetPath(options.problem))}`,
    '  reason: declaration input maps to the output directory itself.',
    '  fix: move the declaration under a file path inside rootDir or adjust liminaOptions.outputs.',
  ];
}

function formatTargetOutsideOutDir(options: FormatProblemOptions): string[] {
  return [
    'Output declaration copy target escapes outDir:',
    `  source: ${formatProblemPath(options.projectRootDir, options.problem.filePath)}`,
    `  target: ${formatProblemPath(options.projectRootDir, getTargetPath(options.problem))}`,
    `  outDir: ${formatProblemPath(options.projectRootDir, options.problem.outDir)}`,
    '  reason: declaration input target path is outside output outDir.',
    '  fix: adjust liminaOptions.outputs.rootDir and outDir so copied declaration inputs stay inside outDir.',
  ];
}

function formatOutsideRoot(options: FormatProblemOptions): string[] {
  return [
    'Output declaration input is outside rootDir:',
    ...formatWarningProblem(options),
  ];
}

const errorFormatters: Readonly<
  Record<
    OutputDeclarationCopyProblemReason,
    (options: FormatProblemOptions) => string[]
  >
> = {
  'outside-root': formatOutsideRoot,
  'target-conflict': formatConflict,
  'target-is-out-dir': formatTargetIsOutDir,
  'target-outside-out-dir': formatTargetOutsideOutDir,
};

function formatErrorProblem(options: FormatProblemOptions): string[] {
  return errorFormatters[options.problem.reason](options);
}

function getProblemsBySeverity(
  problems: readonly OutputDeclarationCopyProblem[],
  severity: OutputDeclarationCopyProblem['severity'],
): OutputDeclarationCopyProblem[] {
  return problems.filter((problem) => problem.severity === severity);
}

function joinProblemSections(
  problems: readonly OutputDeclarationCopyProblem[],
  format: (problem: OutputDeclarationCopyProblem) => string[],
): string {
  const lines: string[] = [];
  for (const problem of problems) {
    if (lines.length > 0) lines.push('');
    lines.push(...format(problem));
  }
  return lines.join('\n');
}

export function formatOutputDeclarationCopyWarnings(options: {
  problems: readonly OutputDeclarationCopyProblem[];
  projectRootDir: string;
}): string | null {
  const problems = getProblemsBySeverity(options.problems, 'warning');
  if (problems.length === 0) return null;
  return [
    'Output declaration inputs outside rootDir were not copied:',
    joinProblemSections(problems, (problem) =>
      formatWarningProblem({
        problem,
        projectRootDir: options.projectRootDir,
      }),
    ),
  ].join('\n');
}

export function formatOutputDeclarationCopyErrors(options: {
  problems: readonly OutputDeclarationCopyProblem[];
  projectRootDir: string;
}): string | null {
  const problems = getProblemsBySeverity(options.problems, 'error');
  if (problems.length === 0) return null;
  return joinProblemSections(problems, (problem) =>
    formatErrorProblem({
      problem,
      projectRootDir: options.projectRootDir,
    }),
  );
}
