import { toRelativePath } from '#utils/path';
import { PackageLogger } from '../../logger';
import { addPackageCheckIssue } from '../issue';
import {
  collectBuiltPackageManifestProblems,
  type DistPackageJson,
} from '../manifest';
import type { RunPackageCheckEntryOptions } from '../runner-types';

function getProblemSummary(problem: string): string {
  const summary = problem.split('\n')[0];
  return summary === undefined ? 'Built package manifest is invalid.' : summary;
}

function reportManifestProblem(options: {
  outputPackageJsonPath: string;
  packageName: string | undefined;
  problem: string;
  runOptions: RunPackageCheckEntryOptions;
}): void {
  const summary = getProblemSummary(options.problem);
  addPackageCheckIssue({
    code: 'LIMINA_PACKAGE_MANIFEST_INVALID',
    detailLines: options.problem.split('\n'),
    evidence: [
      { label: 'manifest diagnostic', lines: options.problem.split('\n') },
    ],
    fix: 'Fix the built package manifest before publishing or checking the package output.',
    fixSteps: [
      'Fix the built package manifest field reported in the diagnostic.',
      'Rebuild the package output.',
      'Rerun the package check.',
    ],
    issueSink: options.runOptions.issueSink,
    packageManifestPath: options.outputPackageJsonPath,
    packageName: options.packageName,
    reason: summary,
    rootDir: options.runOptions.config.rootDir,
    summary,
    title: 'Built package manifest issue',
    tool: 'manifest',
  });
  PackageLogger.error(options.problem);
}

export function reportManifestProblems(options: {
  manifest: DistPackageJson;
  outputPackageJsonPath: string;
  runOptions: RunPackageCheckEntryOptions;
}): boolean {
  const problems = collectBuiltPackageManifestProblems({
    label: options.runOptions.label,
    manifest: options.manifest,
    packageJsonPath: toRelativePath(
      options.runOptions.config.rootDir,
      options.outputPackageJsonPath,
    ),
  });
  for (const problem of problems) {
    reportManifestProblem({
      outputPackageJsonPath: options.outputPackageJsonPath,
      packageName: options.manifest.name,
      problem,
      runOptions: options.runOptions,
    });
  }
  return problems.length === 0;
}
