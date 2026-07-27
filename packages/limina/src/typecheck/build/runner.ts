import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import { resolvePreflight } from '../../preflight';
import { runManagedBuild } from '../managed-build-runner';
import { runRawBuild } from '../raw-build-runner';
import type { RunBuildOptions, RunBuildResult } from '../runner-types';
import { resolveBuildTarget } from './target-resolution';

export async function runBuildImpl(
  options: RunBuildOptions,
): Promise<RunBuildResult> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const projectRootDir = normalizeAbsolutePath(options.config.rootDir);
  const preflight = resolvePreflight(options.config, options);
  const workspaceContext = await preflight.ensureWorkspaceValidated();
  const target = await resolveBuildTarget({
    checker: options.checker,
    config: options.config,
    configPath: options.configPath,
    providers: options.providers,
    cwd,
    generatedGraphProvider: options.generatedGraphProvider,
    preflight,
    project: options.project,
    raw: options.raw,
  });
  if (target.kind === 'raw') {
    return runRawBuild({ cwd, request: options, target });
  }
  return runManagedBuild({
    cwd,
    preflight,
    projectRootDir,
    request: options,
    target,
    workspaceContext,
  });
}
