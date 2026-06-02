import { createElapsedTimer } from 'logaria/helper';
import path from 'pathe';
import { isStrictConfig, type ResolvedLiminaConfig } from '../config';
import type { LiminaFlowReporter } from '../flow';
import { clearCliScreen, formatErrorMessage, ReleaseLogger } from '../logger';
import {
  assertPackageReleaseConsistency,
  PackageReleaseConsistencyError,
} from '../package-release-consistency';
import { toRelativePath } from '../utils/path';
import { isLocalPackageDependencySpecifier } from '../workspace';
import {
  createPackageEntrySelectionPlan,
  type DistPackageJson,
  type PackageEntrySelectionPlan,
  type PackedPackageTarball,
  packOutputTarball,
  readDistPackageJson,
} from './package';

export interface RunReleaseCheckOptions {
  clearScreen?: boolean;
  config: ResolvedLiminaConfig;
  cwd?: string;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  packageNames?: readonly string[];
}

function logReleaseCheckPlan(options: {
  config: ResolvedLiminaConfig;
  cwd: string;
  plan: PackageEntrySelectionPlan;
}): void {
  ReleaseLogger.info(
    [
      'Release check plan:',
      `  config: ${toRelativePath(
        options.config.rootDir,
        options.config.configPath,
      )}`,
      `  cwd: ${toRelativePath(options.config.rootDir, options.cwd)}`,
      `  selection: ${options.plan.selectionReason}`,
      '  entries:',
      ...options.plan.entries.map((entry) =>
        [
          `    - ${entry.label}`,
          `      outDir: ${toRelativePath(options.config.rootDir, entry.outDir)}`,
        ].join('\n'),
      ),
    ].join('\n'),
  );
}

function collectStrictOutputManifestProblems(options: {
  label: string;
  manifest: DistPackageJson;
  outDir: string;
  rootDir: string;
}): string[] {
  const sections = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ] as const;
  const problems: string[] = [];

  for (const sectionName of sections) {
    const section = options.manifest[sectionName];

    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      continue;
    }

    for (const [dependencyName, specifier] of Object.entries(section)) {
      if (
        typeof specifier !== 'string' ||
        !isLocalPackageDependencySpecifier(specifier)
      ) {
        continue;
      }

      problems.push(
        [
          `${options.label}: ${options.manifest.name} -> ${dependencyName} [${sectionName}] (${specifier}): output package manifest must not expose workspace:, link:, file:, or catalog: dependency specifiers when strict: true`,
          `  output: ${toRelativePath(options.rootDir, options.outDir)}`,
        ].join('\n'),
      );
    }
  }

  return problems;
}

async function packReleaseTarball(options: {
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  label: string;
  outDir: string;
}): Promise<PackedPackageTarball> {
  const packTask = options.flow?.start(`release tarball: ${options.label}`, {
    depth: options.flowDepth ?? 0,
  });
  ReleaseLogger.info(`release tarball packing started: ${options.label}`);
  const packElapsed = createElapsedTimer();

  try {
    const packedDist = await packOutputTarball(options.outDir);

    if (!options.flow?.interactive) {
      ReleaseLogger.success(
        `release tarball packed: ${options.label}`,
        packElapsed(),
      );
    }

    packTask?.pass();
    return packedDist;
  } catch (error) {
    ReleaseLogger.error(
      `release tarball failed: ${options.label}: ${formatErrorMessage(error)}`,
      packElapsed(),
    );
    packTask?.fail(`release tarball failed: ${options.label}`, { error });
    throw error;
  }
}

async function runReleaseCheckEntry(options: {
  config: ResolvedLiminaConfig;
  flow?: LiminaFlowReporter;
  flowDepth?: number;
  label: string;
  outDir: string;
}): Promise<boolean> {
  const task = options.flow?.start(`release entry: ${options.label}`, {
    depth: options.flowDepth ?? 0,
  });
  let packedDist: PackedPackageTarball | undefined;

  try {
    const outputPackageJsonPath = path.join(options.outDir, 'package.json');
    const outputManifest = await readDistPackageJson({
      config: options.config,
      label: options.label,
      packageJsonPath: outputPackageJsonPath,
    });
    const strictOutputProblems = isStrictConfig(options.config)
      ? collectStrictOutputManifestProblems({
          label: options.label,
          manifest: outputManifest,
          outDir: options.outDir,
          rootDir: options.config.rootDir,
        })
      : [];

    if (strictOutputProblems.length > 0) {
      throw new PackageReleaseConsistencyError(
        [
          `package release check failed for ${options.label}:`,
          `  output: ${toRelativePath(options.config.rootDir, options.outDir)}`,
          '',
          'Output package manifest is not publish-ready:',
          ...strictOutputProblems.map((problem) => `  - ${problem}`),
        ].join('\n'),
      );
    }

    if (outputManifest.private === true) {
      throw new PackageReleaseConsistencyError(
        [
          `package release check failed for ${options.label}:`,
          `  output: ${toRelativePath(options.config.rootDir, options.outDir)}`,
          '',
          'Release tarball is not publishable:',
          `  - ${outputManifest.name}: selected release package has "private": true; npm publish would reject it`,
        ].join('\n'),
      );
    }

    packedDist = await packReleaseTarball({
      flow: options.flow,
      flowDepth: (options.flowDepth ?? 0) + 1,
      label: options.label,
      outDir: options.outDir,
    });

    await assertPackageReleaseConsistency({
      config: options.config,
      label: options.label,
      outDir: options.outDir,
      outputManifest,
      packedTarball: packedDist.tarball,
    });

    if (!options.flow?.interactive) {
      ReleaseLogger.success(`release checks passed: ${options.label}`);
    }

    task?.pass();
    return true;
  } catch (error) {
    if (error instanceof PackageReleaseConsistencyError) {
      ReleaseLogger.error(formatErrorMessage(error));
      task?.fail(`release checks failed: ${options.label}`);
      return false;
    }

    ReleaseLogger.error(
      `release checks failed: ${options.label}: ${formatErrorMessage(error)}`,
    );
    task?.fail(`release checks failed: ${options.label}`, { error });
    throw error;
  } finally {
    if (packedDist) {
      await packedDist.cleanup();
    }
  }
}

export async function runReleaseCheck(
  options: RunReleaseCheckOptions,
): Promise<boolean> {
  if (options.clearScreen ?? true) {
    clearCliScreen();
  }

  const elapsed = createElapsedTimer();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const task = options.flow?.start('release check', {
    depth: options.flowDepth ?? 0,
  });

  try {
    ReleaseLogger.info('release check started');

    const plan = createPackageEntrySelectionPlan({
      config: options.config,
      cwd,
      packageNames: options.packageNames,
      strictCwd: true,
    });

    logReleaseCheckPlan({
      config: options.config,
      cwd,
      plan,
    });

    let passed = true;

    for (const entry of plan.entries) {
      passed =
        (await runReleaseCheckEntry({
          config: options.config,
          flow: options.flow,
          flowDepth: (options.flowDepth ?? 0) + 1,
          label: entry.label,
          outDir: entry.outDir,
        })) && passed;
    }

    if (passed) {
      if (!options.flow?.interactive) {
        ReleaseLogger.success('release check finished', elapsed());
      }

      task?.pass();
    } else {
      ReleaseLogger.error('release check finished with failures', elapsed());
      task?.fail('release check finished with failures');
    }

    return passed;
  } catch (error) {
    ReleaseLogger.error(
      `release check failed: ${formatErrorMessage(error)}`,
      elapsed(),
    );
    task?.fail('release check failed', { error });
    throw error;
  }
}
